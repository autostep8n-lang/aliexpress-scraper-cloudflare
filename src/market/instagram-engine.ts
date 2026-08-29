/**
 * Market Intelligence - Instagram deterministic engine (P3.4).
 *
 * Pure, source-agnostic, deterministic computation: query normalization,
 * payload parsing, signal assembly and row mapping. No I/O, no wall-clock
 * time, no provider/network logic. Identical inputs always produce identical
 * outputs; malformed external data is skipped or rejected with a stable
 * `MarketError` code rather than throwing unexpectedly.
 */

import {
  INSTAGRAM_MEDIA_TYPES,
  MarketError,
  type InstagramHashtag,
  type InstagramMedia,
  type InstagramMediaCollection,
  type InstagramMediaType,
  type InstagramObservationRow,
  type InstagramQuery,
  type InstagramSignal,
  type NormalizedInstagramQuery,
} from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const KEYWORD_MAX_LENGTH = 200;

/**
 * Validates and normalizes raw, untrusted query input into a
 * `NormalizedInstagramQuery`. Throws `MarketError` with a stable code on
 * invalid input: `INVALID_KEYWORD`, `INVALID_LIMIT`.
 */
export function normalizeInstagramQuery(query: InstagramQuery): NormalizedInstagramQuery {
  const keyword = asString(query.keyword);
  if (!keyword) {
    throw new MarketError("INVALID_KEYWORD", "keyword is required and must be a non-empty string");
  }
  if (keyword.length > KEYWORD_MAX_LENGTH) {
    throw new MarketError("INVALID_KEYWORD", `keyword must be at most ${KEYWORD_MAX_LENGTH} characters`);
  }

  const hashtag = toInstagramHashtag(keyword);

  return {
    keyword,
    hashtag,
    limit: normalizeLimit(query.limit),
  };
}

/**
 * Derives the `hashtag_search` query string from a keyword: the leading `#`
 * is stripped, the remainder is lowercased and every character that is not a
 * hashtag character (a-z, 0-9, _) is removed. A keyword with no hashtag
 * characters left (e.g. "$$$") is rejected with `INVALID_KEYWORD`.
 */
export function toInstagramHashtag(keyword: string): string {
  const withoutHash = keyword.startsWith("#") ? keyword.slice(1) : keyword;
  const hashtag = withoutHash.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (hashtag === "") {
    throw new MarketError("INVALID_KEYWORD", "keyword must contain at least one hashtag character (a-z, 0-9, _)");
  }
  return hashtag;
}

/**
 * Parses an IG Hashtag Search (`hashtag_search`) payload into the resolved
 * hashtag. `hashtag_search` returns at most one entry in `data`; the first
 * usable entry wins. Returns null when no hashtag is found.
 *
 * Structurally invalid payloads throw `INVALID_PAYLOAD`.
 */
export function parseInstagramHashtagSearchResponse(payload: unknown): InstagramHashtag | null {
  const root = asRecord(payload);
  if (!root) {
    throw new MarketError("INVALID_PAYLOAD", "instagram hashtag_search payload must be an object");
  }
  const items = root.data;
  if (!Array.isArray(items)) {
    throw new MarketError("INVALID_PAYLOAD", "instagram hashtag_search payload is missing 'data'");
  }

  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (id === "" || name === "") continue;
    return { id, name };
  }
  return null;
}

/**
 * Parses an IG Hashtag media edge (`top_media` or `recent_media`) payload into
 * a list of media items.
 *
 * Rules:
 * - `data` must be an array
 * - items without a non-empty `id` or a parseable `timestamp` are skipped
 * - `media_type` outside the documented set maps to `UNKNOWN`
 * - missing/empty captions map to null; unparseable counters map to 0
 * - `media_url` is kept only when present (Graph omits it for copyrighted
 *   audio and reels with downloads disabled)
 *
 * Structurally invalid payloads throw `INVALID_PAYLOAD`.
 */
export function parseInstagramMediaResponse(payload: unknown): InstagramMedia[] {
  const root = asRecord(payload);
  if (!root) {
    throw new MarketError("INVALID_PAYLOAD", "instagram media payload must be an object");
  }
  const items = root.data;
  if (!Array.isArray(items)) {
    throw new MarketError("INVALID_PAYLOAD", "instagram media payload is missing 'data'");
  }

  const media: InstagramMedia[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id === "") continue;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
    if (timestamp === "" || Number.isNaN(new Date(timestamp).getTime())) continue;

    const likeCount = countValue(record.like_count);
    const commentsCount = countValue(record.comments_count);
    media.push({
      id,
      mediaType: normalizeMediaType(record.media_type),
      caption: nullableString(record.caption),
      timestamp,
      permalink: nullableString(record.permalink),
      likeCount,
      commentsCount,
      mediaUrl: nullableString(record.media_url),
      engagement: likeCount + commentsCount,
    });
  }
  return media;
}

/**
 * Assembles the final aggregate `InstagramSignal` from the parsed hashtag
 * media collection and the normalized query.
 *
 * The `top_media` and `recent_media` items are merged and deduplicated by id
 * (the first occurrence wins, so a `top_media` copy of a media item that also
 * appears in `recent_media` is kept). The unique media are deterministically
 * ranked (engagement desc, timestamp desc, id asc) and capped at the query
 * `limit`; the aggregates are computed over the full unique set.
 */
export function buildInstagramSignal(
  collection: InstagramMediaCollection,
  query: NormalizedInstagramQuery,
  capturedAt: string,
): InstagramSignal {
  const unique = mergeUnique(collection.topMedia, collection.recentMedia);
  const ranked = [...unique].sort(compareMedia);

  const totalLikes = sum(unique, (media) => media.likeCount);
  const totalComments = sum(unique, (media) => media.commentsCount);
  const totalEngagement = totalLikes + totalComments;
  const count = unique.length;

  return {
    keyword: query.keyword,
    hashtag: query.hashtag,
    limit: query.limit,
    mediaCount: count,
    topMediaCount: collection.topMedia.length,
    recentMediaCount: collection.recentMedia.length,
    totalLikes,
    totalComments,
    totalEngagement,
    avgLikes: count > 0 ? round(totalLikes / count) : null,
    avgEngagement: count > 0 ? round(totalEngagement / count) : null,
    topMedia: ranked.slice(0, query.limit),
    capturedAt,
  };
}

/** Maps a normalized signal to its persistence row shape. */
export function toInstagramObservationRow(
  signal: InstagramSignal,
  sourceId: string | null,
): InstagramObservationRow {
  const topMedia = signal.topMedia[0] ?? null;
  return {
    source_id: sourceId,
    keyword: signal.keyword,
    hashtag: signal.hashtag,
    result_limit: signal.limit,
    media_count: signal.mediaCount,
    top_media_count: signal.topMediaCount,
    recent_media_count: signal.recentMediaCount,
    total_likes: signal.totalLikes,
    total_comments: signal.totalComments,
    total_engagement: signal.totalEngagement,
    avg_likes: signal.avgLikes,
    avg_engagement: signal.avgEngagement,
    top_media_id: topMedia?.id ?? null,
    top_media_caption: topMedia?.caption ?? null,
    captured_at: signal.capturedAt,
    metadata: { media: signal.topMedia },
  };
}

function normalizeMediaType(value: unknown): InstagramMediaType {
  if (typeof value === "string") {
    for (const mediaType of INSTAGRAM_MEDIA_TYPES) {
      if (mediaType === value) return mediaType;
    }
  }
  return "UNKNOWN";
}

/** Merges two media lists, dropping duplicates by id (first occurrence wins). */
function mergeUnique(top: InstagramMedia[], recent: InstagramMedia[]): InstagramMedia[] {
  const seen = new Set<string>();
  const merged: InstagramMedia[] = [];
  for (const list of [top, recent]) {
    for (const media of list) {
      if (seen.has(media.id)) continue;
      seen.add(media.id);
      merged.push(media);
    }
  }
  return merged;
}

function compareMedia(a: InstagramMedia, b: InstagramMedia): number {
  if (a.engagement !== b.engagement) return b.engagement - a.engagement;
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const num = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(num) || num < 1 || num > MAX_LIMIT) {
    throw new MarketError("INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return num;
}

function sum(media: InstagramMedia[], select: (media: InstagramMedia) => number): number {
  let total = 0;
  for (const item of media) total += select(item);
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

function nullableString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
