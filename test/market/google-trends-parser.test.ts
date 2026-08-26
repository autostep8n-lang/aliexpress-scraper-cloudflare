import { describe, expect, it } from "vitest";
import {
  normalizeQuery,
  parseTimelinePayload,
  summarizeSignals,
  toObservationRow,
} from "../../src/market/engine";
import { MarketError, type GoogleTrendsSignal } from "../../src/market/types";

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

function signal(overrides: Partial<GoogleTrendsSignal> = {}): GoogleTrendsSignal {
  return {
    keyword: "smart watch",
    geo: "US",
    property: "web",
    category: null,
    timeRange: "today 5-y",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
    value: 50,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

describe("normalizeQuery", () => {
  it("rejects a missing keyword", () => {
    expectCode(() => normalizeQuery({}), "INVALID_KEYWORD");
    expectCode(() => normalizeQuery({ keyword: "   " }), "INVALID_KEYWORD");
  });

  it("accepts numeric keywords", () => {
    expect(normalizeQuery({ keyword: 42 }).keyword).toBe("42");
  });

  it("trims the keyword and caps its length", () => {
    expect(normalizeQuery({ keyword: "  phone  " }).keyword).toBe("phone");
    expectCode(() => normalizeQuery({ keyword: "x".repeat(201) }), "INVALID_KEYWORD");
  });

  it("defaults geo to WORLD", () => {
    expect(normalizeQuery({ keyword: "phone" }).geo).toBe("WORLD");
    expect(normalizeQuery({ keyword: "phone", geo: "" }).geo).toBe("WORLD");
  });

  it("uppercases and validates geo codes", () => {
    expect(normalizeQuery({ keyword: "phone", geo: "us" }).geo).toBe("US");
    expect(normalizeQuery({ keyword: "phone", geo: "gb-sct" }).geo).toBe("GB-SCT");
    expect(normalizeQuery({ keyword: "phone", geo: "WORLD" }).geo).toBe("WORLD");
    expectCode(() => normalizeQuery({ keyword: "phone", geo: "usa" }), "INVALID_GEO");
    expectCode(() => normalizeQuery({ keyword: "phone", geo: "US1" }), "INVALID_GEO");
  });

  it("defaults timeRange to today 5-y and accepts canonical and custom ranges", () => {
    expect(normalizeQuery({ keyword: "phone" }).timeRange).toBe("today 5-y");
    expect(normalizeQuery({ keyword: "phone", timeRange: "now 7-d" }).timeRange).toBe("now 7-d");
    expect(normalizeQuery({ keyword: "phone", timeRange: "2024-01-01 2024-12-31" }).timeRange).toBe(
      "2024-01-01 2024-12-31",
    );
    expectCode(() => normalizeQuery({ keyword: "phone", timeRange: "last week" }), "INVALID_TIME_RANGE");
  });

  it("normalizes property to lowercase and rejects unknown properties", () => {
    expect(normalizeQuery({ keyword: "phone", property: "News" }).property).toBe("news");
    expect(normalizeQuery({ keyword: "phone", property: "youtube" }).property).toBe("youtube");
    expectCode(() => normalizeQuery({ keyword: "phone", property: "podcast" }), "INVALID_PROPERTY");
  });

  it("normalizes category to a non-negative integer or null", () => {
    expect(normalizeQuery({ keyword: "phone", category: undefined }).category).toBeNull();
    expect(normalizeQuery({ keyword: "phone", category: "5" }).category).toBe(5);
    expect(normalizeQuery({ keyword: "phone", category: 7 }).category).toBe(7);
    expectCode(() => normalizeQuery({ keyword: "phone", category: -1 }), "INVALID_CATEGORY");
    expectCode(() => normalizeQuery({ keyword: "phone", category: "1.5" }), "INVALID_CATEGORY");
  });
});

describe("parseTimelinePayload", () => {
  const query = normalizeQuery({ keyword: "smart watch", geo: "US" });

  it("rejects structurally invalid payloads with INVALID_PAYLOAD", () => {
    expectCode(() => parseTimelinePayload(null, query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(() => parseTimelinePayload("nope", query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(() => parseTimelinePayload({}, query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(() => parseTimelinePayload({ default: {} }, query, CAPTURED_AT), "INVALID_PAYLOAD");
    expectCode(
      () => parseTimelinePayload({ default: { timelineData: "not-an-array" } }, query, CAPTURED_AT),
      "INVALID_PAYLOAD",
    );
  });

  it("returns an empty array for a valid payload with an empty timeline", () => {
    const signals = parseTimelinePayload({ default: { timelineData: [] } }, query, CAPTURED_AT);
    expect(signals).toEqual([]);
  });

  it("parses a timeline into ordered, clamped signals with derived periodEnd", () => {
    const payload = {
      default: {
        resolution: "MONTH",
        timelineData: [
          { time: "1735689600000", value: [40] },
          { time: "1738368000000", value: [100] },
          { time: "1740787200000", value: [200] },
        ],
      },
    };
    const signals = parseTimelinePayload(payload, query, CAPTURED_AT);
    expect(signals).toHaveLength(3);
    expect(signals[0].value).toBe(40);
    expect(signals[1].value).toBe(100);
    expect(signals[2].value).toBe(100);
    expect(signals[0].periodStart).toBe("2025-01-01T00:00:00.000Z");
    expect(signals[0].periodEnd).toBe("2025-02-01T00:00:00.000Z");
    expect(signals[2].periodEnd).toBe("2025-03-29T00:00:00.000Z");
    expect(signals.every((item) => item.keyword === "smart watch" && item.geo === "US")).toBe(true);
    expect(signals.every((item) => item.capturedAt === CAPTURED_AT)).toBe(true);
  });

  it("clamps out-of-range values to 0..100", () => {
    const payload = {
      default: {
        resolution: "MONTH",
        timelineData: [{ time: "1735689600000", value: [-5] }, { time: "1738368000000", value: [250] }],
      },
    };
    const signals = parseTimelinePayload(payload, query, CAPTURED_AT);
    expect(signals[0].value).toBe(0);
    expect(signals[1].value).toBe(100);
  });

  it("uses value[0] and skips entries without a usable value", () => {
    const payload = {
      default: {
        resolution: "MONTH",
        timelineData: [
          { time: "1735689600000", value: [null, 33] },
          { time: "1738368000000", value: [] },
          { time: "1740787200000", value: [50] },
        ],
      },
    };
    const signals = parseTimelinePayload(payload, query, CAPTURED_AT);
    expect(signals).toHaveLength(2);
    expect(signals[0].value).toBe(33);
    expect(signals[1].value).toBe(50);
  });

  it("drops entries with unparseable timestamps", () => {
    const payload = {
      default: {
        resolution: "MONTH",
        timelineData: [
          { time: "not-a-timestamp", value: [50] },
          { time: "1735689600000", value: [70] },
        ],
      },
    };
    const signals = parseTimelinePayload(payload, query, CAPTURED_AT);
    expect(signals).toHaveLength(1);
    expect(signals[0].periodStart).toBe("2025-01-01T00:00:00.000Z");
  });

  it("deduplicates duplicate periodStart buckets (last wins)", () => {
    const payload = {
      default: {
        resolution: "MONTH",
        timelineData: [
          { time: "1735689600000", value: [10] },
          { time: "1735689600000", value: [90] },
        ],
      },
    };
    const signals = parseTimelinePayload(payload, query, CAPTURED_AT);
    expect(signals).toHaveLength(1);
    expect(signals[0].value).toBe(90);
  });

  it("derives the final bucket periodEnd from the last gap", () => {
    const payload = {
      default: {
        resolution: "MONTH",
        timelineData: [
          { time: "1735689600000", value: [10] },
          { time: "1738368000000", value: [90] },
        ],
      },
    };
    const signals = parseTimelinePayload(payload, query, CAPTURED_AT);
    expect(signals[1].periodEnd).toBe("2025-03-04T00:00:00.000Z");
  });

  it("falls back to the resolution span for a single-point series", () => {
    const payload = { default: { resolution: "WEEK", timelineData: [{ time: "1735689600000", value: [10] }] } };
    const signals = parseTimelinePayload(payload, query, CAPTURED_AT);
    expect(signals).toHaveLength(1);
    expect(signals[0].periodEnd).toBe("2025-01-08T00:00:00.000Z");
  });
});

describe("summarizeSignals", () => {
  it("handles an empty series", () => {
    const summary = summarizeSignals([]);
    expect(summary).toEqual({ count: 0, first: null, last: null, change: null, direction: "unknown", spanMs: null });
  });

  it("handles a single-point series", () => {
    const summary = summarizeSignals([signal()]);
    expect(summary.count).toBe(1);
    expect(summary.direction).toBe("unknown");
    expect(summary.change).toBeNull();
    expect(summary.spanMs).toBeNull();
  });

  it("is order-independent and reports up/down/flat direction", () => {
    const up = summarizeSignals([signal({ value: 10 }), signal({ value: 90, periodStart: "2026-02-01T00:00:00.000Z" })]);
    expect(up.direction).toBe("up");
    expect(up.change).toBe(80);
    expect(up.spanMs).toBe(31 * 24 * 60 * 60 * 1000);

    const down = summarizeSignals([signal({ value: 90 }), signal({ value: 10, periodStart: "2026-02-01T00:00:00.000Z" })]);
    expect(down.direction).toBe("down");
    expect(down.change).toBe(-80);

    const flat = summarizeSignals([signal({ value: 50 }), signal({ value: 50, periodStart: "2026-02-01T00:00:00.000Z" })]);
    expect(flat.direction).toBe("flat");
    expect(flat.change).toBe(0);
  });
});

describe("toObservationRow", () => {
  it("maps a signal to its persistence row shape", () => {
    const row = toObservationRow(signal(), "src-123");
    expect(row).toEqual({
      source_id: "src-123",
      keyword: "smart watch",
      geo: "US",
      property: "web",
      category: null,
      time_range: "today 5-y",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2026-02-01T00:00:00.000Z",
      value: 50,
      captured_at: CAPTURED_AT,
      metadata: {},
    });
  });

  it("keeps source_id null when no source is provided", () => {
    expect(toObservationRow(signal(), null).source_id).toBeNull();
  });
});
