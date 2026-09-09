import type { Env } from "../env";

/**
 * TEMPORARY operator smoke test. Remove after the Instagram Business Login
 * token is validated. GET /api/tmp/instagram-me calls graph.instagram.com/me
 * with env.INSTAGRAM_ACCESS_TOKEN and returns only id / username. It never
 * logs, persists, or echoes the token.
 */
export const INSTAGRAM_ME_SMOKE_PATH = "/api/tmp/instagram-me";

const ME_URL = "https://graph.instagram.com/me";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export async function handleInstagramMeSmoke(env: Env, requestId: string): Promise<Response> {
  const token = env.INSTAGRAM_ACCESS_TOKEN?.trim();
  if (!token) {
    return smokeError(
      503,
      "instagram access token is not configured",
      "INSTAGRAM_NOT_CONFIGURED",
      requestId,
    );
  }

  const url = new URL(ME_URL);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", token);

  let response: Response;
  try {
    response = await fetch(url.href, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return smokeError(502, "instagram me request timed out", "TIMEOUT", requestId);
    }
    return smokeError(502, "instagram me request failed", "HTTP_ERROR", requestId);
  }

  const graphStatus = response.status;
  const text = await readBodyLimited(response);

  if (!response.ok) {
    return smokeError(graphStatusToHttp(graphStatus), "instagram graph rejected the request", "AUTH_ERROR", requestId, {
      graphStatus,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return smokeError(502, "instagram me returned malformed JSON", "INVALID_PAYLOAD", requestId, { graphStatus });
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return smokeError(502, "instagram me response must be an object", "INVALID_PAYLOAD", requestId, { graphStatus });
  }

  const record = payload as Record<string, unknown>;
  const id = asNonEmptyString(record.id);
  const username = asNonEmptyString(record.username);
  if (!id) {
    return smokeError(502, "instagram me response is missing id", "INVALID_PAYLOAD", requestId, { graphStatus });
  }

  return Response.json(
    {
      temporary: true,
      path: INSTAGRAM_ME_SMOKE_PATH,
      graphStatus,
      id,
      username: username ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function smokeError(
  status: number,
  message: string,
  code: string,
  requestId: string,
  extra: { graphStatus?: number } = {},
): Response {
  const body: { error: string; code: string; requestId: string; temporary: true; path: string; graphStatus?: number } = {
    error: message,
    code,
    requestId,
    temporary: true,
    path: INSTAGRAM_ME_SMOKE_PATH,
  };
  if (extra.graphStatus !== undefined) body.graphStatus = extra.graphStatus;
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function graphStatusToHttp(graphStatus: number): number {
  if (graphStatus === 401 || graphStatus === 403) return 502;
  if (graphStatus === 429) return 502;
  if (graphStatus >= 400 && graphStatus < 500) return 502;
  if (graphStatus >= 500) return 502;
  return 502;
}

async function readBodyLimited(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return "";
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return text.slice(0, MAX_RESPONSE_BYTES);
  return text;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return undefined;
}
