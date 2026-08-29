import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildInstagramSignal,
  normalizeInstagramQuery,
  parseInstagramHashtagSearchResponse,
  parseInstagramMediaResponse,
  toInstagramHashtag,
  toInstagramObservationRow,
} from "../../src/market/instagram-engine";
import { MarketError } from "../../src/market/types";

const HASHTAG_SEARCH_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "instagram-hashtag-search.json"), "utf8"),
) as Record<string, unknown>;

const TOP_MEDIA_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "instagram-top-media.json"), "utf8"),
) as Record<string, unknown>;

const RECENT_MEDIA_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "instagram-recent-media.json"), "utf8"),
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

/** Parses the fixtures and assembles the full signal for a query. */
function signalFrom(query = normalizeInstagramQuery({ keyword: "smart watch" })) {
  const hashtag = parseInstagramHashtagSearchResponse(HASHTAG_SEARCH_FIXTURE);
  if (!hashtag) throw new Error("fixture hashtag must resolve");
  const collection = {
    hashtagId: hashtag.id,
    hashtagName: hashtag.name,
    topMedia: parseInstagramMediaResponse(TOP_MEDIA_FIXTURE),
    recentMedia: parseInstagramMediaResponse(RECENT_MEDIA_FIXTURE),
  };
  return buildInstagramSignal(collection, query, CAPTURED_AT);
}

describe("normalizeInstagramQuery", () => {
  it("rejects a missing keyword", () => {
    expectCode(() => normalizeInstagramQuery({}), "INVALID_KEYWORD");
    expectCode(() => normalizeInstagramQuery({ keyword: "   " }), "INVALID_KEYWORD");
  });

  it("accepts numeric keywords and trims and caps the keyword length", () => {
    expect(normalizeInstagramQuery({ keyword: 42 }).keyword).toBe("42");
    expect(normalizeInstagramQuery({ keyword: "  phone  " }).keyword).toBe("phone");
    expectCode(() => normalizeInstagramQuery({ keyword: "x".repeat(201) }), "INVALID_KEYWORD");
  });

  it("rejects a keyword that has no hashtag characters left", () => {
    expectCode(() => normalizeInstagramQuery({ keyword: "$$$" }), "INVALID_KEYWORD");
    expectCode(() => normalizeInstagramQuery({ keyword: "#!!!" }), "INVALID_KEYWORD");
  });

  it("defaults limit to 25 and rejects out-of-range limits (max 50)", () => {
    expect(normalizeInstagramQuery({ keyword: "phone" }).limit).toBe(25);
    expect(normalizeInstagramQuery({ keyword: "phone", limit: "" }).limit).toBe(25);
    expect(normalizeInstagramQuery({ keyword: "phone", limit: "10" }).limit).toBe(10);
    expect(normalizeInstagramQuery({ keyword: "phone", limit: 50 }).limit).toBe(50);
    expectCode(() => normalizeInstagramQuery({ keyword: "phone", limit: 0 }), "INVALID_LIMIT");
    expectCode(() => normalizeInstagramQuery({ keyword: "phone", limit: 51 }), "INVALID_LIMIT");
    expectCode(() => normalizeInstagramQuery({ keyword: "phone", limit: "1.5" }), "INVALID_LIMIT");
  });
});

describe("toInstagramHashtag", () => {
  it("lowercases, strips a leading # and removes non-hashtag characters", () => {
    expect(toInstagramHashtag("SmartWatch")).toBe("smartwatch");
    expect(toInstagramHashtag("#SmartWatch")).toBe("smartwatch");
    expect(toInstagramHashtag("Smart Watch 2026!")).toBe("smartwatch2026");
    expect(toInstagramHashtag("smart_watch")).toBe("smart_watch");
    expect(toInstagramHashtag("  #Tech  Gadgets  ")).toBe("techgadgets");
  });
});

describe("parseInstagramHashtagSearchResponse", () => {
  it("rejects structurally invalid payloads with INVALID_PAYLOAD", () => {
    expectCode(() => parseInstagramHashtagSearchResponse(null), "INVALID_PAYLOAD");
    expectCode(() => parseInstagramHashtagSearchResponse("nope"), "INVALID_PAYLOAD");
    expectCode(() => parseInstagramHashtagSearchResponse({}), "INVALID_PAYLOAD");
    expectCode(() => parseInstagramHashtagSearchResponse({ data: "not-an-array" }), "INVALID_PAYLOAD");
  });

  it("returns null when no hashtag is found", () => {
    expect(parseInstagramHashtagSearchResponse({ data: [] })).toBeNull();
  });

  it("extracts the resolved hashtag from the fixture", () => {
    expect(parseInstagramHashtagSearchResponse(HASHTAG_SEARCH_FIXTURE)).toEqual({
      id: "17841401234567890",
      name: "smartwatch",
    });
  });

  it("skips unusable entries and picks the first usable one", () => {
    const payload = {
      data: [
        { id: "", name: "empty" },
        { id: "1", name: "   " },
        "not-an-item",
        { id: "2", name: "blue" },
      ],
    };
    expect(parseInstagramHashtagSearchResponse(payload)).toEqual({ id: "2", name: "blue" });
  });
});

describe("parseInstagramMediaResponse", () => {
  it("rejects structurally invalid payloads with INVALID_PAYLOAD", () => {
    expectCode(() => parseInstagramMediaResponse(null), "INVALID_PAYLOAD");
    expectCode(() => parseInstagramMediaResponse({}), "INVALID_PAYLOAD");
    expectCode(() => parseInstagramMediaResponse({ data: "nope" }), "INVALID_PAYLOAD");
  });

  it("parses the top_media fixture into media items", () => {
    const media = parseInstagramMediaResponse(TOP_MEDIA_FIXTURE);

    expect(media).toHaveLength(4);
    expect(media.map((item) => item.id)).toEqual(["media_top3", "media_top1", "media_top2", "media_top4"]);
    expect(media[0]).toEqual({
      id: "media_top3",
      mediaType: "REEL",
      caption: "This budget smart watch reels reel is getting attention #smartwatch",
      timestamp: "2026-02-20T08:30:00+0000",
      permalink: "https://www.instagram.com/p/media_top3/",
      likeCount: 1800,
      commentsCount: 220,
      mediaUrl: null,
      engagement: 2020,
    });
    expect(media[1].mediaUrl).toBe("https://scontent.cdninstagram.com/media_top1.jpg");
  });

  it("skips entries without an id or a parseable timestamp and keeps unknown media types", () => {
    const media = parseInstagramMediaResponse({
      data: [
        { id: "ok1", media_type: "IMAGE", timestamp: "2026-01-01T00:00:00+0000", like_count: 10, comments_count: 1 },
        { id: "", media_type: "IMAGE", timestamp: "2026-01-01T00:00:00+0000" },
        { id: "ok2", media_type: "BOOMERANG", timestamp: "2026-01-01T00:00:00+0000", like_count: 5, comments_count: 0 },
        { id: "ok3", media_type: "IMAGE", timestamp: "not-a-timestamp" },
      ],
    });

    expect(media.map((item) => item.id)).toEqual(["ok1", "ok2"]);
    expect(media[1].mediaType).toBe("UNKNOWN");
  });

  it("maps string counters, missing counters to 0 and empty captions to null", () => {
    const media = parseInstagramMediaResponse({
      data: [
        {
          id: "a",
          media_type: "VIDEO",
          timestamp: "2026-01-01T00:00:00+0000",
          like_count: "1200",
          comments_count: 98,
        },
        { id: "b", media_type: "IMAGE", timestamp: "2026-01-01T00:00:00+0000", caption: "   " },
      ],
    });

    expect(media[0].likeCount).toBe(1200);
    expect(media[0].commentsCount).toBe(98);
    expect(media[0].engagement).toBe(1298);
    expect(media[1].caption).toBeNull();
    expect(media[1].likeCount).toBe(0);
    expect(media[1].permalink).toBeNull();
  });
});

describe("buildInstagramSignal", () => {
  it("assembles a deterministic aggregate signal from the fixtures", () => {
    const signal = signalFrom();

    expect(signal.keyword).toBe("smart watch");
    expect(signal.hashtag).toBe("smartwatch");
    expect(signal.limit).toBe(25);
    expect(signal.mediaCount).toBe(6);
    expect(signal.topMediaCount).toBe(4);
    expect(signal.recentMediaCount).toBe(3);
    expect(signal.totalLikes).toBe(5300);
    expect(signal.totalComments).toBe(439);
    expect(signal.totalEngagement).toBe(5739);
    expect(signal.avgLikes).toBe(883.33);
    expect(signal.avgEngagement).toBe(956.5);
    expect(signal.capturedAt).toBe(CAPTURED_AT);

    expect(signal.topMedia.map((item) => item.id)).toEqual([
      "media_top3",
      "media_top1",
      "media_top2",
      "media_rec1",
      "media_top4",
      "media_rec2",
    ]);
    expect(signal.topMedia[0].id).toBe("media_top3");
  });

  it("deduplicates media that appear in both edges", () => {
    const signal = signalFrom();
    expect(signal.mediaCount).toBe(6);
    expect(signal.totalLikes).toBe(5300);
  });

  it("caps the aggregated media at the query limit", () => {
    const query = normalizeInstagramQuery({ keyword: "smart watch", limit: 2 });
    const signal = signalFrom(query);

    expect(signal.limit).toBe(2);
    expect(signal.topMedia.map((item) => item.id)).toEqual(["media_top3", "media_top1"]);
    expect(signal.mediaCount).toBe(6);
    expect(signal.totalEngagement).toBe(5739);
  });

  it("returns a zero-signal for an unresolvable hashtag", () => {
    const query = normalizeInstagramQuery({ keyword: "nope" });
    const signal = buildInstagramSignal(
      { hashtagId: "", hashtagName: "", topMedia: [], recentMedia: [] },
      query,
      CAPTURED_AT,
    );

    expect(signal.mediaCount).toBe(0);
    expect(signal.topMediaCount).toBe(0);
    expect(signal.recentMediaCount).toBe(0);
    expect(signal.totalLikes).toBe(0);
    expect(signal.totalComments).toBe(0);
    expect(signal.totalEngagement).toBe(0);
    expect(signal.avgLikes).toBeNull();
    expect(signal.avgEngagement).toBeNull();
    expect(signal.topMedia).toEqual([]);
  });
});

describe("toInstagramObservationRow", () => {
  it("maps a signal to its persistence row shape", () => {
    const signal = signalFrom();
    const row = toInstagramObservationRow(signal, "src-instagram");

    expect(row).toEqual({
      source_id: "src-instagram",
      keyword: "smart watch",
      hashtag: "smartwatch",
      result_limit: 25,
      media_count: 6,
      top_media_count: 4,
      recent_media_count: 3,
      total_likes: 5300,
      total_comments: 439,
      total_engagement: 5739,
      avg_likes: 883.33,
      avg_engagement: 956.5,
      top_media_id: "media_top3",
      top_media_caption: "This budget smart watch reels reel is getting attention #smartwatch",
      captured_at: CAPTURED_AT,
      metadata: { media: signal.topMedia },
    });
  });

  it("keeps source_id null and the top media columns null when there is no media", () => {
    const query = normalizeInstagramQuery({ keyword: "nope" });
    const signal = buildInstagramSignal(
      { hashtagId: "", hashtagName: "", topMedia: [], recentMedia: [] },
      query,
      CAPTURED_AT,
    );
    const row = toInstagramObservationRow(signal, null);

    expect(row.source_id).toBeNull();
    expect(row.hashtag).toBe("nope");
    expect(row.top_media_id).toBeNull();
    expect(row.top_media_caption).toBeNull();
    expect(row.metadata).toEqual({ media: [] });
  });
});
