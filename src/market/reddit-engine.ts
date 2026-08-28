/**
 * Market Intelligence - Reddit deterministic engine (P3.2).
 *
 * Pure, source-agnostic, deterministic computation: query normalization,
 * search-payload parsing and row mapping. No I/O, no wall-clock time, no
 * provider/network logic. Identical inputs always produce identical outputs;
 * malformed external data is skipped or rejected with a stable `MarketError`
 * code rather than throwing unexpectedly.
 */

import {
  REDDIT_SORTS,
  REDDIT_TIME_FILTERS,
  MarketError,
  type NormalizedRedditQuery,
  type RedditObservationRow,
  type RedditPost,
  type RedditQuery,
  type RedditSignal,
  type RedditSort,
  type RedditTimeFilter,
} from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const KEYWORD_MAX_LENGTH = 200;

/**
 * Validates and normalizes raw, untrusted query input into a
 * `NormalizedRedditQuery`. Throws `MarketError` with a stable code on invalid
 * input: `INVALID_KEYWORD`, `INVALID_LIMIT`, `INVALID_SORT`,
 * `INVALID_TIME_FILTER`.
 */
export function normalizeRedditQuery(query: RedditQuery): NormalizedRedditQuery {
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
    sort: normalizeSort(query.sort),
    timeFilter: normalizeTimeFilter(query.timeFilter),
  };
}

/**
 * Parses a Reddit search `Listing` payload into a single aggregate signal for
 * the given query.
 *
 * Rules:
 * - posts are children of `data.children` with a `data` record (kind `t3`)
 * - entries without an `id`, a non-empty `title` or a parseable `created_utc`
 *   are skipped
 * - posts are deterministically ranked (score desc, comments desc, id asc) and
 *   capped at the query `limit`; the aggregates are computed over that set
 * - a valid payload with no usable posts is a valid result (mentions = 0), not
 *   an error
 *
 * Structurally invalid payloads throw `INVALID_PAYLOAD`.
 */
export function parseRedditSearchResponse(
  payload: unknown,
  query: NormalizedRedditQuery,
  capturedAt: string,
): RedditSignal {
  const root = asRecord(payload);
  if (!root) {
    throw new MarketError("INVALID_PAYLOAD", "reddit search payload must be an object");
  }
  const data = asRecord(root.data);
  if (!data) {
    throw new MarketError("INVALID_PAYLOAD", "reddit search payload is missing 'data'");
  }
  const children = data.children;
  if (!Array.isArray(children)) {
    throw new MarketError("INVALID_PAYLOAD", "reddit search payload is missing 'data.children'");
  }

  const posts = parsePosts(children, query.limit);
  const mentions = posts.length;
  const totalScore = sum(posts, (post) => post.score);
  const totalComments = sum(posts, (post) => post.numComments);
  const avgScore = posts.length > 0 ? round(totalScore / posts.length) : null;
  const subredditCount = new Set(posts.map((post) => post.subreddit.toLowerCase())).size;

  return {
    keyword: query.keyword,
    limit: query.limit,
    sort: query.sort,
    timeFilter: query.timeFilter,
    mentions,
    totalScore,
    totalComments,
    avgScore,
    subredditCount,
    topSubreddit: topSubredditFor(posts),
    topPosts: posts,
    capturedAt,
  };
}

/** Maps a normalized signal to its persistence row shape. */
export function toRedditObservationRow(signal: RedditSignal, sourceId: string | null): RedditObservationRow {
  return {
    source_id: sourceId,
    keyword: signal.keyword,
    result_limit: signal.limit,
    sort: signal.sort,
    time_filter: signal.timeFilter,
    mentions: signal.mentions,
    total_score: signal.totalScore,
    total_comments: signal.totalComments,
    avg_score: signal.avgScore,
    subreddit_count: signal.subredditCount,
    top_subreddit: signal.topSubreddit,
    captured_at: signal.capturedAt,
    metadata: { topPosts: signal.topPosts },
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

function normalizeSort(value: unknown): RedditSort {
  if (value === undefined || value === null) return "relevance";
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "") return "relevance";
  if ((REDDIT_SORTS as readonly string[]).includes(raw)) {
    return raw as RedditSort;
  }
  throw new MarketError("INVALID_SORT", `invalid sort: ${String(value)}`);
}

function normalizeTimeFilter(value: unknown): RedditTimeFilter {
  if (value === undefined || value === null) return "all";
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "") return "all";
  if ((REDDIT_TIME_FILTERS as readonly string[]).includes(raw)) {
    return raw as RedditTimeFilter;
  }
  throw new MarketError("INVALID_TIME_FILTER", `invalid timeFilter: ${String(value)}`);
}

function parsePosts(children: unknown[], limit: number): RedditPost[] {
  const posts: RedditPost[] = [];
  for (const child of children) {
    const record = asRecord(child);
    if (!record) continue;
    const data = asRecord(record.data);
    if (!data) continue;
    if (typeof data.id !== "string" || data.id.trim() === "") continue;
    if (typeof data.title !== "string" || data.title.trim() === "") continue;
    const createdAt = isoFromUtcSeconds(data.created_utc);
    if (createdAt === null) continue;
    posts.push({
      id: data.id,
      title: data.title,
      subreddit:
        typeof data.subreddit === "string" && data.subreddit.trim() !== "" ? data.subreddit : "unknown",
      score: nonNegativeInt(data.score),
      numComments: nonNegativeInt(data.num_comments),
      author: typeof data.author === "string" && data.author.trim() !== "" ? data.author : null,
      permalink: typeof data.permalink === "string" ? data.permalink : "",
      createdAt,
    });
  }

  const sorted = [...posts].sort(comparePosts);
  return sorted.slice(0, limit);
}

function topSubredditFor(posts: RedditPost[]): string | null {
  if (posts.length === 0) return null;
  const counts = new Map<string, number>();
  const scores = new Map<string, number>();
  for (const post of posts) {
    const key = post.subreddit.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    scores.set(key, (scores.get(key) ?? 0) + post.score);
  }
  let best: string | null = null;
  let bestCount = -1;
  let bestScore = -1;
  for (const [subreddit, count] of counts) {
    const score = scores.get(subreddit) ?? 0;
    if (
      count > bestCount ||
      (count === bestCount && score > bestScore) ||
      (count === bestCount && score === bestScore && (best === null || subreddit < best))
    ) {
      best = subreddit;
      bestCount = count;
      bestScore = score;
    }
  }
  return best;
}

function comparePosts(a: RedditPost, b: RedditPost): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.numComments !== b.numComments) return b.numComments - a.numComments;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sum(posts: RedditPost[], select: (post: RedditPost) => number): number {
  let total = 0;
  for (const post of posts) total += select(post);
  return total;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function nonNegativeInt(value: unknown): number {
  const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function isoFromUtcSeconds(value: unknown): string | null {
  const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(num)) return null;
  const date = new Date(num * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
