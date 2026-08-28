import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildYouTubeSignal,
  normalizeYouTubeQuery,
  parseYouTubeSearchResponse,
  parseYouTubeVideosResponse,
  publishedAfterFor,
  toYouTubeObservationRow,
} from "../../src/market/youtube-engine";
import { MarketError } from "../../src/market/types";

const SEARCH_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "youtube-search.json"), "utf8"),
) as Record<string, unknown>;

const VIDEOS_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "youtube-videos.json"), "utf8"),
) as Record<string, unknown>;

const CAPTURED_AT = "2026-03-01T00:00:00.000Z";

/** Asserts that `fn` throws a MarketError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as MarketError).code).toBe(code);
    return;
  }
  throw new Error(`expected a MarketError with code ${code}`);
}

/** Parses both fixtures and assembles the full signal for a query. */
function signalFrom(query = normalizeYouTubeQuery({ keyword: "smart watch" })) {
  const search = parseYouTubeSearchResponse(SEARCH_FIXTURE, query);
  const statistics = parseYouTubeVideosResponse(VIDEOS_FIXTURE);
  return buildYouTubeSignal(search, statistics, query, CAPTURED_AT);
}

describe("normalizeYouTubeQuery", () => {
  it("rejects a missing keyword", () => {
    expectCode(() => normalizeYouTubeQuery({}), "INVALID_KEYWORD");
    expectCode(() => normalizeYouTubeQuery({ keyword: "   " }), "INVALID_KEYWORD");
  });

  it("accepts numeric keywords and trims and caps the keyword length", () => {
    expect(normalizeYouTubeQuery({ keyword: 42 }).keyword).toBe("42");
    expect(normalizeYouTubeQuery({ keyword: "  phone  " }).keyword).toBe("phone");
    expectCode(() => normalizeYouTubeQuery({ keyword: "x".repeat(201) }), "INVALID_KEYWORD");
  });

  it("defaults limit to 25 and rejects out-of-range limits (max 50)", () => {
    expect(normalizeYouTubeQuery({ keyword: "phone" }).limit).toBe(25);
    expect(normalizeYouTubeQuery({ keyword: "phone", limit: "" }).limit).toBe(25);
    expect(normalizeYouTubeQuery({ keyword: "phone", limit: "10" }).limit).toBe(10);
    expect(normalizeYouTubeQuery({ keyword: "phone", limit: 50 }).limit).toBe(50);
    expectCode(() => normalizeYouTubeQuery({ keyword: "phone", limit: 0 }), "INVALID_LIMIT");
    expectCode(() => normalizeYouTubeQuery({ keyword: "phone", limit: 51 }), "INVALID_LIMIT");
    expectCode(() => normalizeYouTubeQuery({ keyword: "phone", limit: "1.5" }), "INVALID_LIMIT");
  });

  it("defaults order to relevance and accepts the YouTube API orderings case-insensitively", () => {
    expect(normalizeYouTubeQuery({ keyword: "phone" }).order).toBe("relevance");
    expect(normalizeYouTubeQuery({ keyword: "phone", order: "Date" }).order).toBe("date");
    expect(normalizeYouTubeQuery({ keyword: "phone", order: "viewcount" }).order).toBe("viewCount");
    expect(normalizeYouTubeQuery({ keyword: "phone", order: "viewCount" }).order).toBe("viewCount");
    expect(normalizeYouTubeQuery({ keyword: "phone", order: "rating" }).order).toBe("rating");
    expectCode(() => normalizeYouTubeQuery({ keyword: "phone", order: "title" }), "INVALID_ORDER");
  });

  it("defaults publishedWithin to any and rejects unknown windows", () => {
    expect(normalizeYouTubeQuery({ keyword: "phone" }).publishedWithin).toBe("any");
    expect(normalizeYouTubeQuery({ keyword: "phone", publishedWithin: "Week" }).publishedWithin).toBe("week");
    expect(normalizeYouTubeQuery({ keyword: "phone", publishedWithin: "year" }).publishedWithin).toBe("year");
    expectCode(
      () => normalizeYouTubeQuery({ keyword: "phone", publishedWithin: "decade" }),
      "INVALID_PUBLISHED_WITHIN",
    );
  });
});

describe("parseYouTubeSearchResponse", () => {
  const query = normalizeYouTubeQuery({ keyword: "smart watch" });

  it("rejects structurally invalid payloads with INVALID_PAYLOAD", () => {
    expectCode(() => parseYouTubeSearchResponse(null, query), "INVALID_PAYLOAD");
    expectCode(() => parseYouTubeSearchResponse("nope", query), "INVALID_PAYLOAD");
    expectCode(() => parseYouTubeSearchResponse({}, query), "INVALID_PAYLOAD");
    expectCode(() => parseYouTubeSearchResponse({ items: "not-an-array" }, query), "INVALID_PAYLOAD");
  });

  it("returns an empty search result for a valid payload with no items", () => {
    const result = parseYouTubeSearchResponse({ items: [], pageInfo: { totalResults: 0 } }, query);
    expect(result.videoCount).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("extracts video metadata and the total match count from the fixture", () => {
    const result = parseYouTubeSearchResponse(SEARCH_FIXTURE, query);

    expect(result.videoCount).toBe(1243);
    expect(result.items.map((item) => item.id)).toEqual(["vid1", "vid2", "vid3", "vid4"]);
    expect(result.items[0]).toEqual({
      id: "vid1",
      title: "Best budget smart watch under $50?",
      channelId: "chanA",
      channelTitle: "TechReviews",
      publishedAt: "2025-01-10T00:00:00.000Z",
    });
  });

  it("skips entries without a videoId, an empty title, a non-video kind or a bad publish date", () => {
    const payload = {
      items: [
        { id: { kind: "youtube#video", videoId: "ok1" }, snippet: { publishedAt: "2025-01-01T00:00:00.000Z", channelId: "c1", channelTitle: "C1", title: "ok" } },
        { id: { kind: "youtube#channel", channelId: "chanX" }, snippet: { publishedAt: "2025-01-01T00:00:00.000Z", channelId: "c1", channelTitle: "C1", title: "a channel" } },
        { id: { kind: "youtube#video", videoId: "" }, snippet: { publishedAt: "2025-01-01T00:00:00.000Z", channelId: "c1", channelTitle: "C1", title: "no id" } },
        { id: { kind: "youtube#video", videoId: "ok2" }, snippet: { publishedAt: "2025-01-01T00:00:00.000Z", channelId: "c1", channelTitle: "C1", title: "" } },
        { id: { kind: "youtube#video", videoId: "ok3" }, snippet: { publishedAt: "nope", channelId: "c1", channelTitle: "C1", title: "bad time" } },
        "not-an-item",
      ],
    };

    const result = parseYouTubeSearchResponse(payload, query);
    expect(result.items.map((item) => item.id)).toEqual(["ok1"]);
  });
});

describe("parseYouTubeVideosResponse", () => {
  it("rejects structurally invalid payloads with INVALID_PAYLOAD", () => {
    expectCode(() => parseYouTubeVideosResponse(null), "INVALID_PAYLOAD");
    expectCode(() => parseYouTubeVideosResponse({}), "INVALID_PAYLOAD");
    expectCode(() => parseYouTubeVideosResponse({ items: "nope" }), "INVALID_PAYLOAD");
  });

  it("parses the fixture statistics into a map keyed by video id", () => {
    const statistics = parseYouTubeVideosResponse(VIDEOS_FIXTURE);
    expect(statistics.vid1).toEqual({ viewCount: 120000, likeCount: 5400, commentCount: 980 });
    expect(statistics.vid4).toEqual({ viewCount: 150000, likeCount: 8100, commentCount: 1200 });
  });

  it("maps missing or unparseable counters to null/0 and skips id-less entries", () => {
    const statistics = parseYouTubeVideosResponse({
      items: [
        { id: "a", statistics: { viewCount: "100", likeCount: "10", commentCount: "2" } },
        { id: "b", statistics: { viewCount: "200" } },
        { id: "c", statistics: { viewCount: "not-a-number" } },
        { statistics: { viewCount: "1" } },
      ],
    });

    expect(statistics.a).toEqual({ viewCount: 100, likeCount: 10, commentCount: 2 });
    expect(statistics.b).toEqual({ viewCount: 200, likeCount: null, commentCount: null });
    expect(statistics.c).toEqual({ viewCount: 0, likeCount: null, commentCount: null });
    expect(statistics.undefined).toBeUndefined();
  });
});

describe("buildYouTubeSignal", () => {
  it("assembles a deterministic aggregate signal from search + statistics fixtures", () => {
    const signal = signalFrom();

    expect(signal.keyword).toBe("smart watch");
    expect(signal.limit).toBe(25);
    expect(signal.order).toBe("relevance");
    expect(signal.publishedWithin).toBe("any");
    expect(signal.videoCount).toBe(1243);
    expect(signal.totalViews).toBe(425000);
    expect(signal.totalLikes).toBe(18800);
    expect(signal.totalComments).toBe(2850);
    expect(signal.avgViews).toBe(106250);
    expect(signal.channelCount).toBe(3);
    expect(signal.topChannel).toBe("TechReviews");
    expect(signal.capturedAt).toBe(CAPTURED_AT);

    expect(signal.videos.map((video) => video.id)).toEqual(["vid4", "vid1", "vid2", "vid3"]);
    expect(signal.videos[0]).toEqual({
      id: "vid4",
      title: "Top 5 smart watches 2026",
      channelId: "chanC",
      channelTitle: "GadgetLab",
      publishedAt: "2025-02-01T00:00:00.000Z",
      viewCount: 150000,
      likeCount: 8100,
      commentCount: 1200,
      url: "https://www.youtube.com/watch?v=vid4",
    });
  });

  it("caps the aggregated videos at the query limit and re-ranks them", () => {
    const limited = normalizeYouTubeQuery({ keyword: "smart watch", limit: 2 });
    const signal = signalFrom(limited);

    expect(signal.limit).toBe(2);
    expect(signal.videos.map((video) => video.id)).toEqual(["vid4", "vid1"]);
    expect(signal.totalViews).toBe(270000);
    expect(signal.totalLikes).toBe(13500);
    expect(signal.totalComments).toBe(2180);
    expect(signal.avgViews).toBe(135000);
    expect(signal.channelCount).toBe(2);
    expect(signal.topChannel).toBe("GadgetLab");
  });

  it("returns a zero-signal for a valid search with no usable videos", () => {
    const query = normalizeYouTubeQuery({ keyword: "nope" });
    const search = parseYouTubeSearchResponse({ items: [], pageInfo: { totalResults: 0 } }, query);
    const signal = buildYouTubeSignal(search, {}, query, CAPTURED_AT);

    expect(signal.videoCount).toBe(0);
    expect(signal.totalViews).toBe(0);
    expect(signal.totalLikes).toBe(0);
    expect(signal.totalComments).toBe(0);
    expect(signal.avgViews).toBeNull();
    expect(signal.channelCount).toBe(0);
    expect(signal.topChannel).toBeNull();
    expect(signal.videos).toEqual([]);
  });

  it("defaults videos missing from the statistics map to zero views and disabled counters", () => {
    const query = normalizeYouTubeQuery({ keyword: "smart watch" });
    const search = parseYouTubeSearchResponse(SEARCH_FIXTURE, query);
    const signal = buildYouTubeSignal(search, {}, query, CAPTURED_AT);

    expect(signal.totalViews).toBe(0);
    expect(signal.totalLikes).toBe(0);
    expect(signal.totalComments).toBe(0);
    expect(signal.avgViews).toBe(0);
    expect(signal.channelCount).toBe(3);
    expect(signal.videos[0]).toEqual({
      id: "vid4",
      title: "Top 5 smart watches 2026",
      channelId: "chanC",
      channelTitle: "GadgetLab",
      publishedAt: "2025-02-01T00:00:00.000Z",
      viewCount: 0,
      likeCount: null,
      commentCount: null,
      url: "https://www.youtube.com/watch?v=vid4",
    });
  });
});

describe("publishedAfterFor", () => {
  const NOW = Date.parse("2026-03-08T00:00:00.000Z");

  it("returns null for the any window", () => {
    expect(publishedAfterFor("any", NOW)).toBeNull();
  });

  it("subtracts the window from now for the recency tokens", () => {
    expect(publishedAfterFor("hour", NOW)).toBe(new Date(NOW - 1 * 60 * 60 * 1000).toISOString());
    expect(publishedAfterFor("day", NOW)).toBe(new Date(NOW - 24 * 60 * 60 * 1000).toISOString());
    expect(publishedAfterFor("week", NOW)).toBe(new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString());
    expect(publishedAfterFor("month", NOW)).toBe(new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString());
    expect(publishedAfterFor("year", NOW)).toBe(new Date(NOW - 366 * 24 * 60 * 60 * 1000).toISOString());
  });
});

describe("toYouTubeObservationRow", () => {
  it("maps a signal to its persistence row shape", () => {
    const signal = signalFrom();
    const row = toYouTubeObservationRow(signal, "src-youtube");

    expect(row).toEqual({
      source_id: "src-youtube",
      keyword: "smart watch",
      result_limit: 25,
      order_by: "relevance",
      published_within: "any",
      video_count: 1243,
      total_views: 425000,
      total_likes: 18800,
      total_comments: 2850,
      avg_views: 106250,
      channel_count: 3,
      top_video_id: "vid4",
      top_video_title: "Top 5 smart watches 2026",
      top_channel: "TechReviews",
      captured_at: CAPTURED_AT,
      metadata: { videos: signal.videos },
    });
  });

  it("keeps source_id null and the top video columns null when there are no videos", () => {
    const query = normalizeYouTubeQuery({ keyword: "nope" });
    const signal = buildYouTubeSignal(
      parseYouTubeSearchResponse({ items: [] }, query),
      {},
      query,
      CAPTURED_AT,
    );
    const row = toYouTubeObservationRow(signal, null);

    expect(row.source_id).toBeNull();
    expect(row.top_video_id).toBeNull();
    expect(row.top_video_title).toBeNull();
    expect(row.top_channel).toBeNull();
    expect(row.metadata).toEqual({ videos: [] });
  });
});
