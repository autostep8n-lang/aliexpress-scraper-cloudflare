import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { upsertYouTubeSignals } from "../../src/supabase/repository";
import type { YouTubeObservationRow } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const YOUTUBE_SOURCE = {
  id: "55555555-5555-5555-5555-555555555555",
  slug: "youtube",
  name: "YouTube",
  kind: "platform",
};

const YOUTUBE_CONFLICT = "source_id,keyword,order_by,published_within";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function row(overrides: Partial<YouTubeObservationRow> = {}): YouTubeObservationRow {
  return {
    source_id: null,
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
    captured_at: "2026-03-01T00:00:00.000Z",
    metadata: { videos: [] },
    ...overrides,
  };
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("upsertYouTubeSignals", () => {
  let server: MockPostgrest;

  beforeEach(() => {
    server = createMockPostgrest();
    vi.stubGlobal("fetch", server.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns credentials_missing without touching the network when Supabase is unconfigured", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertYouTubeSignals({} as Env, [row()]);

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns updated with an empty payload without touching the network for no rows", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertYouTubeSignals(configuredEnv(), []);

    expect(result).toEqual({ status: "updated", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the youtube source and inserts rows, backfilling source_id", async () => {
    const result = await upsertYouTubeSignals(configuredEnv(), [row(), row({ keyword: "phone" })]);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const source = server.store.sources.find((entry) => entry.slug === "youtube");
    expect(source).toBeDefined();
    expect(source).toMatchObject({ slug: "youtube", name: "YouTube", kind: "api" });

    expect(server.store.youtube_signals).toHaveLength(2);
    expect(server.store.youtube_signals.every((entry) => entry.source_id === source?.id)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((entry) => entry.source_id === source?.id)).toBe(true);
  });

  it("reuses an existing youtube source without duplicating it", async () => {
    server.seed("sources", [YOUTUBE_SOURCE]);

    const result = await upsertYouTubeSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("created");
    expect(server.store.sources.filter((entry) => entry.slug === "youtube")).toHaveLength(1);
    expect(server.store.youtube_signals[0].source_id).toBe(YOUTUBE_SOURCE.id);
  });

  it("replaces a snapshot instead of duplicating on a re-collect of the same keyword and window", async () => {
    const first = await upsertYouTubeSignals(configuredEnv(), [row()]);
    expect(first.status).toBe("created");

    const second = await upsertYouTubeSignals(configuredEnv(), [row({ video_count: 999 })]);
    expect(second.status).toBe("updated");
    expect(server.store.youtube_signals).toHaveLength(1);
    expect(server.store.youtube_signals[0].video_count).toBe(999);
  });

  it("keeps separate snapshots for the same keyword with a different order or recency", async () => {
    await upsertYouTubeSignals(configuredEnv(), [row()]);
    await upsertYouTubeSignals(
      configuredEnv(),
      [row({ order_by: "viewCount", published_within: "week", video_count: 5 })],
    );

    expect(server.store.youtube_signals).toHaveLength(2);
  });

  it("targets the dedup key with on_conflict on the upsert request", async () => {
    await upsertYouTubeSignals(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/youtube_signals")[0];
    expect(new URL(post.url).searchParams.get("on_conflict")).toBe(YOUTUBE_CONFLICT);
  });

  it("sends the normalized observation payload with a resolved source_id", async () => {
    await upsertYouTubeSignals(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/youtube_signals")[0];
    const payload = post.body as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
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
      captured_at: "2026-03-01T00:00:00.000Z",
      metadata: { videos: [] },
    });
    expect(payload[0].source_id).toBe(server.store.sources[0].id);
  });

  it("returns error source_lookup_failed when the source lookup fails", async () => {
    server.override("GET", "/rest/v1/sources", 500, {
      code: "PGRST301",
      message: "Database error",
    });

    const result = await upsertYouTubeSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("source_lookup_failed");
  });

  it("returns error source_create_failed when the source upsert fails", async () => {
    server.override("POST", "/rest/v1/sources", 500, {
      code: "23502",
      message: "null value in column violates not-null constraint",
    });

    const result = await upsertYouTubeSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("source_create_failed");
  });

  it("returns error youtube_signals_upsert_failed when the database rejects the write", async () => {
    server.seed("sources", [YOUTUBE_SOURCE]);
    server.override("POST", "/rest/v1/youtube_signals", 400, {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });

    const result = await upsertYouTubeSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("youtube_signals_upsert_failed");
  });

  it("never leaks credentials into request URLs", async () => {
    await upsertYouTubeSignals(configuredEnv(), [row()]);

    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
