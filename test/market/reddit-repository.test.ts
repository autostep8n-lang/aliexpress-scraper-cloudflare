import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { upsertRedditSignals } from "../../src/supabase/repository";
import type { RedditObservationRow } from "../../src/market/types";
import { createMockPostgrest, type MockPostgrest, type RecordedRequest } from "../helpers/postgrest-mock";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

const REDDIT_SOURCE = {
  id: "44444444-4444-4444-4444-444444444444",
  slug: "reddit",
  name: "Reddit",
  kind: "api",
};

const REDDIT_CONFLICT = "source_id,keyword";

function configuredEnv(): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY } as Env;
}

function row(overrides: Partial<RedditObservationRow> = {}): RedditObservationRow {
  return {
    source_id: null,
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
    captured_at: "2026-03-01T00:00:00.000Z",
    metadata: { topPosts: [] },
    ...overrides,
  };
}

function requestsTo(server: MockPostgrest, method: string, path: string): RecordedRequest[] {
  return server.requests.filter((request) => request.method === method && request.url.includes(path));
}

describe("upsertRedditSignals", () => {
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

    const result = await upsertRedditSignals({} as Env, [row()]);

    expect(result).toEqual({ status: "credentials_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns updated with an empty payload without touching the network for no rows", async () => {
    const fetchMock = vi.fn(server.fetch);
    vi.stubGlobal("fetch", fetchMock);

    const result = await upsertRedditSignals(configuredEnv(), []);

    expect(result).toEqual({ status: "updated", data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the reddit source and inserts rows, backfilling source_id", async () => {
    const result = await upsertRedditSignals(configuredEnv(), [row(), row({ keyword: "phone" })]);

    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const source = server.store.sources.find((entry) => entry.slug === "reddit");
    expect(source).toBeDefined();
    expect(source).toMatchObject({ slug: "reddit", name: "Reddit", kind: "api" });

    expect(server.store.reddit_signals).toHaveLength(2);
    expect(server.store.reddit_signals.every((entry) => entry.source_id === source?.id)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data.every((entry) => entry.source_id === source?.id)).toBe(true);
  });

  it("reuses an existing reddit source without duplicating it", async () => {
    server.seed("sources", [REDDIT_SOURCE]);

    const result = await upsertRedditSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("created");
    expect(server.store.sources.filter((entry) => entry.slug === "reddit")).toHaveLength(1);
    expect(server.store.reddit_signals[0].source_id).toBe(REDDIT_SOURCE.id);
  });

  it("replaces a snapshot instead of duplicating on a re-collect of the same keyword", async () => {
    const first = await upsertRedditSignals(configuredEnv(), [row()]);
    expect(first.status).toBe("created");

    const second = await upsertRedditSignals(configuredEnv(), [row({ mentions: 9 })]);
    expect(second.status).toBe("updated");
    expect(server.store.reddit_signals).toHaveLength(1);
    expect(server.store.reddit_signals[0].mentions).toBe(9);
  });

  it("targets the dedup key with on_conflict on the upsert request", async () => {
    await upsertRedditSignals(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/reddit_signals")[0];
    expect(new URL(post.url).searchParams.get("on_conflict")).toBe(REDDIT_CONFLICT);
  });

  it("sends the normalized observation payload with a resolved source_id", async () => {
    await upsertRedditSignals(configuredEnv(), [row()]);

    const post = requestsTo(server, "POST", "/rest/v1/reddit_signals")[0];
    const payload = post.body as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
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
      captured_at: "2026-03-01T00:00:00.000Z",
      metadata: { topPosts: [] },
    });
    expect(payload[0].source_id).toBe(server.store.sources[0].id);
  });

  it("returns error source_lookup_failed when the source lookup fails", async () => {
    server.override("GET", "/rest/v1/sources", 500, {
      code: "PGRST301",
      message: "Database error",
    });

    const result = await upsertRedditSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("source_lookup_failed");
  });

  it("returns error source_create_failed when the source upsert fails", async () => {
    server.override("POST", "/rest/v1/sources", 500, {
      code: "23502",
      message: "null value in column violates not-null constraint",
    });

    const result = await upsertRedditSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("source_create_failed");
  });

  it("returns error reddit_signals_upsert_failed when the database rejects the write", async () => {
    server.seed("sources", [REDDIT_SOURCE]);
    server.override("POST", "/rest/v1/reddit_signals", 400, {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    });

    const result = await upsertRedditSignals(configuredEnv(), [row()]);

    expect(result.status).toBe("error");
    expect((result as { code?: string }).code).toBe("reddit_signals_upsert_failed");
  });

  it("never leaks credentials into request URLs", async () => {
    await upsertRedditSignals(configuredEnv(), [row()]);

    for (const request of server.requests) {
      expect(request.url).not.toContain(SECRET_KEY);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${SECRET_KEY}`);
    }
  });
});
