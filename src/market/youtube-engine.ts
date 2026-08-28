/**
 * Market Intelligence - YouTube deterministic engine (P3.3).
 *
 * Pure, source-agnostic, deterministic computation: query normalization,
 * payload parsing, signal assembly and row mapping. No I/O, no wall-clock time
 * (recency windows take an explicit `nowMs` so results stay reproducible), no
 * provider/network logic. Identical inputs always produce identical outputs;
 * malformed external data is skipped or rejected with a stable `MarketError`
 * code rather than throwing unexpectedly.
 */

import {
  YOUTUBE_ORDERS,
  YOUTUBE_PUBLISHED_WITHIN,
  MarketError,
  type NormalizedYouTubeQuery,
  type YouTubeObservationRow,
  type YouTubeOrder,
  type YouTubePublishedWithin,
  type YouTubeQuery,
  type YouTubeSearchResult,
  type YouTubeSignal,
  type YouTubeVideo,
  type YouTubeVideoMeta,
  type YouTubeVideoStatistics,
} from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const KEYWORD_MAX_LENGTH = 200;
const HOUR_MS = 60 * 60 * 1000;
const MONTH_HOURS = 24 * 31;
const YEAR_HOURS = 24 * 366;

/**
 * Validates and normalizes raw, untrusted query input into a
 * `NormalizedYouTubeQuery`. Throws `MarketError` with a stable code on invalid
 * input: `INVALID_KEYWORD`, `INVALID_LIMIT`, `INVALID_ORDER`,
 * `INVALID_PUBLISHED_WITHIN`.
 */
export function normalizeYouTubeQuery(query: YouTubeQuery): NormalizedYouTubeQuery {
  const keyword = asString(query.keyword);
  if (!keyword) {
    throw new MarketError("INVALID_KEYWORD", "keyword is required and must be a non-empty string");
  }
  if (keyword.length > KEYWORD_MAX_LENGTH) {
    throw new MarketError("INVALID_KEYWORD", `keyword must be at most ${KEYWORD_MAX_LENGTH} characters`);
  }

  return {
    keyword,
    limit: normalizeLimit(query.limit),
    order: normalizeOrder(query.order),
    publishedWithin: normalizePublishedWithin(query.publishedWithin),
  };
}

/**
 * Parses a YouTube `search.list` payload into the video metadata it carries
 * plus the API-reported total match count.
 *
 * Rules:
 * - items are objects with an `id.videoId` and a `snippet` record
 * - entries without a `videoId`, a non-empty `title` or a parseable
 *   `publishedAt` are skipped (channels/playlists included in a mixed result
 *   set are naturally skipped too)
 * - `pageInfo.totalResults` drives `videoCount`; it is clamped to at least the
 *   number of items actually returned
 *
 * Structurally invalid payloads throw `INVALID_PAYLOAD`.
 */
export function parseYouTubeSearchResponse(
  payload: unknown,
  query: NormalizedYouTubeQuery,
): YouTubeSearchResult {
  const root = asRecord(payload);
  if (!root) {
    throw new MarketError("INVALID_PAYLOAD", "youtube search payload must be an object");
  }
  const items = root.items;
  if (!Array.isArray(items)) {
    throw new MarketError("INVALID_PAYLOAD", "youtube search payload is missing 'items'");
  }

  let videoCount = items.length;
  const pageInfo = asRecord(root.pageInfo);
  if (pageInfo && typeof pageInfo.totalResults === "number" && Number.isFinite(pageInfo.totalResults)) {
    videoCount = Math.max(videoCount, Math.floor(pageInfo.totalResults));
  }

  const metas: YouTubeVideoMeta[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const id = asRecord(record.id);
    if (!id) continue;
    const videoId = id.videoId;
    if (typeof videoId !== "string" || videoId.trim() === "") continue;
    const snippet = asRecord(record.snippet);
    if (!snippet) continue;
    if (typeof snippet.title !== "string" || snippet.title.trim() === "") continue;
    const publishedAt = typeof snippet.publishedAt === "string" ? snippet.publishedAt : "";
    if (publishedAt === "" || Number.isNaN(new Date(publishedAt).getTime())) continue;
    metas.push({
      id: videoId,
      title: snippet.title,
      channelId: stringOr(snippet.channelId, "unknown"),
      channelTitle: stringOr(snippet.channelTitle, "unknown"),
      publishedAt,
    });
  }

  return { videoCount, items: metas };
}

/**
 * Parses a YouTube `videos.list` payload into a map of video id ->
 * `YouTubeVideoStatistics`. Entries without an `id` or a `statistics` record
 * are skipped; missing counters map to `null` (a disabled counter) and
 * unparseable counters map to 0.
 *
 * Structurally invalid payloads throw `INVALID_PAYLOAD`.
 */
export function parseYouTubeVideosResponse(
  payload: unknown,
): Record<string, YouTubeVideoStatistics> {
  const root = asRecord(payload);
  if (!root) {
    throw new MarketError("INVALID_PAYLOAD", "youtube videos payload must be an object");
  }
  const items = root.items;
  if (!Array.isArray(items)) {
    throw new MarketError("INVALID_PAYLOAD", "youtube videos payload is missing 'items'");
  }

  const statistics: Record<string, YouTubeVideoStatistics> = {};
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    if (typeof record.id !== "string" || record.id.trim() === "") continue;
    const stats = asRecord(record.statistics);
    if (!stats) continue;
    statistics[record.id] = {
      viewCount: countValue(stats.viewCount),
      likeCount: nullableCountValue(stats.likeCount),
      commentCount: nullableCountValue(stats.commentCount),
    };
  }
  return statistics;
}

/**
 * Assembles the final aggregate `YouTubeSignal` from parsed search metadata,
 * per-video statistics, and the normalized query.
 *
 * Videos are deterministically ranked (views desc, likes desc, comments desc,
 * publishedAt desc, id asc) and capped at the query `limit`; the aggregates
 * are computed over that set. Videos missing from the statistics map count as
 * 0 views with disabled likes/comments.
 */
export function buildYouTubeSignal(
  search: YouTubeSearchResult,
  statistics: Record<string, YouTubeVideoStatistics>,
  query: NormalizedYouTubeQuery,
  capturedAt: string,
): YouTubeSignal {
  const videos: YouTubeVideo[] = search.items.map((item) => {
    const stats = statistics[item.id] ?? { viewCount: 0, likeCount: null, commentCount: null };
    return {
      ...item,
      viewCount: stats.viewCount,
      likeCount: stats.likeCount,
      commentCount: stats.commentCount,
      url: `https://www.youtube.com/watch?v=${item.id}`,
    };
  });

  const top = [...videos].sort(compareVideos).slice(0, query.limit);

  const totalViews = sum(top, (video) => video.viewCount);
  const totalLikes = sum(top, (video) => video.likeCount ?? 0);
  const totalComments = sum(top, (video) => video.commentCount ?? 0);
  const avgViews = top.length > 0 ? round(totalViews / top.length) : null;
  const channelCount = new Set(top.map((video) => video.channelId)).size;

  return {
    keyword: query.keyword,
    limit: query.limit,
    order: query.order,
    publishedWithin: query.publishedWithin,
    videoCount: Math.max(search.videoCount, top.length),
    totalViews,
    totalLikes,
    totalComments,
    avgViews,
    channelCount,
    topChannel: topChannelFor(top),
    videos: top,
    capturedAt,
  };
}

/**
 * Maps a `publishedWithin` window to the RFC 3339 `publishedAfter` timestamp
 * the YouTube Data API expects. `any` returns null (no date filter). `month`
 * and `year` use fixed 31/366-day approximations, which is sufficient for a
 * recency window. Pure given `nowMs`.
 */
export function publishedAfterFor(
  publishedWithin: YouTubePublishedWithin,
  nowMs: number,
): string | null {
  if (publishedWithin === "any") return null;
  const hours: Record<Exclude<YouTubePublishedWithin, "any">, number> = {
    hour: 1,
    day: 24,
    week: 24 * 7,
    month: MONTH_HOURS,
    year: YEAR_HOURS,
  };
  return new Date(nowMs - hours[publishedWithin] * HOUR_MS).toISOString();
}

/** Maps a normalized signal to its persistence row shape. */
export function toYouTubeObservationRow(
  signal: YouTubeSignal,
  sourceId: string | null,
): YouTubeObservationRow {
  const topVideo = signal.videos[0] ?? null;
  return {
    source_id: sourceId,
    keyword: signal.keyword,
    result_limit: signal.limit,
    order_by: signal.order,
    published_within: signal.publishedWithin,
    video_count: signal.videoCount,
    total_views: signal.totalViews,
    total_likes: signal.totalLikes,
    total_comments: signal.totalComments,
    avg_views: signal.avgViews,
    channel_count: signal.channelCount,
    top_video_id: topVideo?.id ?? null,
    top_video_title: topVideo?.title ?? null,
    top_channel: signal.topChannel,
    captured_at: signal.capturedAt,
    metadata: { videos: signal.videos },
  };
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(num) || num < 1 || num > MAX_LIMIT) {
    throw new MarketError("INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return num;
}

function normalizeOrder(value: unknown): YouTubeOrder {
  if (value === undefined || value === null) return "relevance";
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "") return "relevance";
  for (const order of YOUTUBE_ORDERS) {
    if (order.toLowerCase() === raw) return order;
  }
  throw new MarketError("INVALID_ORDER", `invalid order: ${String(value)}`);
}

function normalizePublishedWithin(value: unknown): YouTubePublishedWithin {
  if (value === undefined || value === null) return "any";
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "") return "any";
  if ((YOUTUBE_PUBLISHED_WITHIN as readonly string[]).includes(raw)) {
    return raw as YouTubePublishedWithin;
  }
  throw new MarketError("INVALID_PUBLISHED_WITHIN", `invalid publishedWithin: ${String(value)}`);
}

function topChannelFor(videos: YouTubeVideo[]): string | null {
  if (videos.length === 0) return null;
  const counts = new Map<string, number>();
  const views = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const video of videos) {
    counts.set(video.channelId, (counts.get(video.channelId) ?? 0) + 1);
    views.set(video.channelId, (views.get(video.channelId) ?? 0) + video.viewCount);
    titles.set(video.channelId, video.channelTitle);
  }

  let bestId: string | null = null;
  let bestCount = -1;
  let bestViews = -1;
  for (const [channelId, count] of counts) {
    const totalViews = views.get(channelId) ?? 0;
    const title = titles.get(channelId) ?? "";
    const bestTitle = bestId === null ? "" : titles.get(bestId) ?? "";
    if (
      count > bestCount ||
      (count === bestCount && totalViews > bestViews) ||
      (count === bestCount && totalViews === bestViews && (bestId === null || title.toLowerCase() < bestTitle.toLowerCase()))
    ) {
      bestId = channelId;
      bestCount = count;
      bestViews = totalViews;
    }
  }
  return bestId === null ? null : (titles.get(bestId) ?? null);
}

function compareVideos(a: YouTubeVideo, b: YouTubeVideo): number {
  if (a.viewCount !== b.viewCount) return b.viewCount - a.viewCount;
  if ((a.likeCount ?? 0) !== (b.likeCount ?? 0)) return (b.likeCount ?? 0) - (a.likeCount ?? 0);
  if ((a.commentCount ?? 0) !== (b.commentCount ?? 0)) return (b.commentCount ?? 0) - (a.commentCount ?? 0);
  if (a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sum(videos: YouTubeVideo[], select: (video: YouTubeVideo) => number): number {
  let total = 0;
  for (const video of videos) total += select(video);
  return total;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function countValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const num = Number(value.trim());
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return 0;
}

function nullableCountValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
