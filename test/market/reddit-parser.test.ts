import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeRedditQuery,
  parseRedditSearchResponse,
  toRedditObservationRow,
} from "../../src/market/reddit-engine";
import { MarketError } from "../../src/market/types";

const SEARCH_FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "reddit-search.json"), "utf8"),
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

describe("normalizeRedditQuery", () => {
  it("rejects a missing keyword", () => {
    expectCode(() => normalizeRedditQuery({}), "INVALID_KEYWORD");
    expectCode(() => normalizeRedditQuery({ keyword: "   " }), "INVALID_KEYWORD");
  });

  it("accepts numeric keywords and trims and caps the keyword length", () => {
    expect(normalizeRedditQuery({ keyword: 42 }).keyword).toBe("42");
    expect(normalizeRedditQuery({ keyword: "  phone  " }).keyword).toBe("phone");
    expectCode(() => normalizeRedditQuery({ keyword: "x".repeat(201) }), "INVALID_KEYWORD");
  });

  it("defaults limit to 25 and rejects out-of-range limits", () => {
    expect(normalizeRedditQuery({ keyword: "phone" }).limit).toBe(25);
    expect(normalizeRedditQuery({ keyword: "phone", limit: "" }).limit).toBe(25);
    expect(normalizeRedditQuery({ keyword: "phone", limit: "10" }).limit).toBe(10);
    expect(normalizeRedditQuery({ keyword: "phone", limit: 100 }).limit).toBe(100);
    expectCode(() => normalizeRedditQuery({ keyword: "phone", limit: 0 }), "INVALID_LIMIT");
    expectCode(() => normalizeRedditQuery({ keyword: "phone", limit: 101 }), "INVALID_LIMIT");
    expectCode(() => normalizeRedditQuery({ keyword: "phone", limit: "1.5" }), "INVALID_LIMIT");
  });

  it("defaults sort to relevance and rejects unknown sorts", () => {
    expect(normalizeRedditQuery({ keyword: "phone" }).sort).toBe("relevance");
    expect(normalizeRedditQuery({ keyword: "phone", sort: "Top" }).sort).toBe("top");
    expect(normalizeRedditQuery({ keyword: "phone", sort: "new" }).sort).toBe("new");
    expectCode(() => normalizeRedditQuery({ keyword: "phone", sort: "rising" }), "INVALID_SORT");
  });

  it("defaults timeFilter to all and rejects unknown filters", () => {
    expect(normalizeRedditQuery({ keyword: "phone" }).timeFilter).toBe("all");
    expect(normalizeRedditQuery({ keyword: "phone", timeFilter: "Week" }).timeFilter).toBe("week");
    expect(normalizeRedditQuery({ keyword: "phone", timeFilter: "day" }).timeFilter).toBe("day");
    expectCode(() => normalizeRedditQuery({ keyword: "phone", timeFilter: "decade" }), "INVALID_TIME_FILTER");
  });
});

describe("parseRedditSearchResponse", () => {
  const query = normalizeRedditQuery({ keyword: "smart watch" });

  it("rejects structurally invalid payloads with INVALID_PAYLOAD", () => {
    expectCode(() => parseRedditSearchResponse(null, query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(() => parseRedditSearchResponse("nope", query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(() => parseRedditSearchResponse({}, query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(() => parseRedditSearchResponse({ data: {} }, query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(
      () => parseRedditSearchResponse({ data: { children: "not-an-array" } }, query, CAPTURED_AT),
      "INVALID_PAYLOAD",
    );
  });

  it("returns a zero-mention signal for a valid payload with no posts", () => {
    const signal = parseRedditSearchResponse({ data: { children: [] } }, query, CAPTURED_AT);
    expect(signal.mentions).toBe(0);
    expect(signal.totalScore).toBe(0);
    expect(signal.totalComments).toBe(0);
    expect(signal.avgScore).toBeNull();
    expect(signal.subredditCount).toBe(0);
    expect(signal.topSubreddit).toBeNull();
    expect(signal.topPosts).toEqual([]);
  });

  it("parses a listing into a deterministic aggregate signal", () => {
    const signal = parseRedditSearchResponse(SEARCH_FIXTURE, query, CAPTURED_AT);

    expect(signal.keyword).toBe("smart watch");
    expect(signal.limit).toBe(25);
    expect(signal.sort).toBe("relevance");
    expect(signal.timeFilter).toBe("all");
    expect(signal.mentions).toBe(4);
    expect(signal.totalScore).toBe(320);
    expect(signal.totalComments).toBe(117);
    expect(signal.avgScore).toBe(80);
    expect(signal.subredditCount).toBe(2);
    expect(signal.topSubreddit).toBe("smartwatch");
    expect(signal.capturedAt).toBe(CAPTURED_AT);

    expect(signal.topPosts.map((post) => post.id)).toEqual(["abc1", "abc2", "abc6", "abc3"]);
    expect(signal.topPosts[0]).toEqual({
      id: "abc1",
      title: "Best budget smart watch under $50?",
      subreddit: "smartwatch",
      score: 120,
      numComments: 34,
      author: "user_a",
      permalink: "/r/smartwatch/comments/abc1/best_budget_smart_watch/",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("caps the aggregated posts at the query limit", () => {
    const limited = normalizeRedditQuery({ keyword: "smart watch", limit: 2 });
    const signal = parseRedditSearchResponse(SEARCH_FIXTURE, limited, CAPTURED_AT);

    expect(signal.limit).toBe(2);
    expect(signal.mentions).toBe(2);
    expect(signal.totalScore).toBe(215);
    expect(signal.totalComments).toBe(85);
    expect(signal.avgScore).toBe(107.5);
    expect(signal.subredditCount).toBe(2);
    expect(signal.topSubreddit).toBe("smartwatch");
    expect(signal.topPosts.map((post) => post.id)).toEqual(["abc1", "abc2"]);
  });

  it("skips entries without an id, title or parseable timestamp", () => {
    const payload = {
      data: {
        children: [
          { kind: "t3", data: { id: "abc1", title: "ok", subreddit: "r1", score: 10, num_comments: 1, created_utc: 1735689600 } },
          { kind: "t3", data: { title: "no id", subreddit: "r1", score: 99, created_utc: 1735689600 } },
          { kind: "t3", data: { id: "abc3", title: "", subreddit: "r1", score: 99, created_utc: 1735689600 } },
          { kind: "t3", data: { id: "abc4", title: "bad time", subreddit: "r1", score: 99, created_utc: "nope" } },
          "not-a-child",
        ],
      },
    };
    const signal = parseRedditSearchResponse(payload, query, CAPTURED_AT);
    expect(signal.mentions).toBe(1);
    expect(signal.topPosts).toHaveLength(1);
    expect(signal.topPosts[0].id).toBe("abc1");
  });
});

describe("toRedditObservationRow", () => {
  it("maps a signal to its persistence row shape", () => {
    const signal = parseRedditSearchResponse(SEARCH_FIXTURE, normalizeRedditQuery({ keyword: "smart watch" }), CAPTURED_AT);
    const row = toRedditObservationRow(signal, "src-reddit");

    expect(row).toEqual({
      source_id: "src-reddit",
      keyword: "smart watch",
      result_limit: 25,
      sort: "relevance",
      time_filter: "all",
      mentions: 4,
      total_score: 320,
      total_comments: 117,
      avg_score: 80,
      subreddit_count: 2,
      top_subreddit: "smartwatch",
      captured_at: CAPTURED_AT,
      metadata: { topPosts: signal.topPosts },
    });
  });

  it("keeps source_id null when no source is provided", () => {
    const signal = parseRedditSearchResponse(SEARCH_FIXTURE, normalizeRedditQuery({ keyword: "smart watch" }), CAPTURED_AT);
    expect(toRedditObservationRow(signal, null).source_id).toBeNull();
  });
});
