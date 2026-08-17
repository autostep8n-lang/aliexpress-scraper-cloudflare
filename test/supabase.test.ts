import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSupabaseConnection, getSupabaseClient } from "../src/supabase/client";
import { routeRequest } from "../src/router";
import type { Env } from "../src/env";

const SUPABASE_URL = "https://example.supabase.co";
const SECRET_KEY = "test-secret-key";

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return { SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET_KEY, ...overrides } as Env;
}

function mockFetchResponse(status: number, body = "{}"): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(body, { status }));
}

function fetchCalls(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls.map(([input, init]) => [String(input), init] as [string, RequestInit | undefined]);
}

const ctx = {} as ExecutionContext;

async function get(path: string, requestEnv: Env): Promise<Response> {
  return routeRequest(new Request(`https://worker.example${path}`, { method: "GET" }), requestEnv, ctx);
}

describe("getSupabaseClient", () => {
  it("returns null when credentials are missing", () => {
    expect(getSupabaseClient({} as Env)).toBeNull();
    expect(getSupabaseClient({ SUPABASE_URL } as Env)).toBeNull();
    expect(getSupabaseClient({ SUPABASE_SECRET_KEY: SECRET_KEY } as Env)).toBeNull();
  });

  it("builds a client without making network calls when configured", () => {
    const client = getSupabaseClient(configuredEnv());
    expect(client).not.toBeNull();
    expect(typeof client!.from).toBe("function");
  });
});

describe("checkSupabaseConnection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetchResponse(200));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports not configured when credentials are missing", async () => {
    const result = await checkSupabaseConnection({} as Env);
    expect(result).toEqual({
      configured: false,
      connected: false,
      status: null,
      detail: "supabase not configured",
    });
  });

  it("returns connected when Supabase responds 2xx and never leaks the key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkSupabaseConnection(configuredEnv());

    expect(result.connected).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.status).toBe(200);

    const [calledUrl, init] = fetchCalls(fetchMock)[0];
    expect(calledUrl).toBe(`${SUPABASE_URL}/rest/v1/`);
    expect(init!.headers).toMatchObject({
      Authorization: `Bearer ${SECRET_KEY}`,
      apikey: SECRET_KEY,
    });

    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it("reports disconnected on a rejected/unauthorized response", async () => {
    vi.stubGlobal("fetch", mockFetchResponse(401));

    const result = await checkSupabaseConnection(configuredEnv());

    expect(result.configured).toBe(true);
    expect(result.connected).toBe(false);
    expect(result.status).toBe(401);
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it("reports disconnected when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await checkSupabaseConnection(configuredEnv());

    expect(result).toEqual({
      configured: true,
      connected: false,
      status: null,
      detail: "supabase request failed",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it("normalizes a trailing slash on the Supabase URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await checkSupabaseConnection(configuredEnv({ SUPABASE_URL: `${SUPABASE_URL}/` }));

    expect(fetchCalls(fetchMock)[0][0]).toBe(`${SUPABASE_URL}/rest/v1/`);
  });
});

describe("GET /health/supabase", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports not configured without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await get("/health/supabase", {} as Env);
    const body = (await res.json()) as { status: string; supabase: { configured: boolean; connected: boolean } };

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.supabase.configured).toBe(false);
    expect(body.supabase.connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports ok when the mocked connection succeeds and never leaks the key", async () => {
    vi.stubGlobal("fetch", mockFetchResponse(200));

    const res = await get("/health/supabase", configuredEnv());
    const text = await res.text();
    const body = JSON.parse(text) as { status: string; supabase: { configured: boolean; connected: boolean; status: number } };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.supabase.connected).toBe(true);
    expect(body.supabase.configured).toBe(true);
    expect(body.supabase.status).toBe(200);
    expect(text).not.toContain(SECRET_KEY);
  });

  it("reports degraded when the connection is rejected and never leaks the key", async () => {
    vi.stubGlobal("fetch", mockFetchResponse(401));

    const res = await get("/health/supabase", configuredEnv());
    const text = await res.text();
    const body = JSON.parse(text) as { status: string; supabase: { connected: boolean; status: number } };

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.supabase.connected).toBe(false);
    expect(body.supabase.status).toBe(401);
    expect(text).not.toContain(SECRET_KEY);
  });
});
