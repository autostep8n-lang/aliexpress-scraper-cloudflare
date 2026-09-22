/**
 * Official AliExpress Dropshipping HMAC-SHA256 signing (Open Platform).
 *
 * Business APIs (`POST https://api-sg.aliexpress.com/sync`):
 *   sign = HMAC-SHA256(secret, sorted "keyvalue" pairs).hex.upper
 *
 * System APIs (`https://api-sg.aliexpress.com/rest{api_path}`):
 *   sign = HMAC-SHA256(secret, api_path + sorted "keyvalue" pairs).hex.upper
 *
 * Never reuse MD5 `openApiSign` for these calls.
 */

export const DS_BUSINESS_ENDPOINT = "https://api-sg.aliexpress.com/sync";
export const DS_REST_PREFIX = "https://api-sg.aliexpress.com/rest";
export const DS_AUTHORIZE_URL = "https://api-sg.aliexpress.com/oauth/authorize";
export const DS_SIGN_METHOD = "sha256";
export const DS_TOKEN_CREATE_PATH = "/auth/token/create";
export const DS_TOKEN_REFRESH_PATH = "/auth/token/refresh";

const TIMESTAMP_TZ_OFFSET_HOURS = 8;

export function dsTimestamp(date = new Date()): string {
  const shifted = new Date(date.getTime() + TIMESTAMP_TZ_OFFSET_HOURS * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(
    shifted.getUTCHours(),
  )}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/** HMAC-SHA256 over optional system `apiPath` plus sorted params. Uppercase hex. */
export async function dsHmacSign(
  secret: string,
  params: Record<string, string>,
  apiPath?: string,
): Promise<string> {
  const sorted = Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== "")
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  const payload = `${apiPath ?? ""}${sorted}`;
  return hmacSha256HexUpper(secret, payload);
}

export function quoteJsonIntegerFields(text: string, fields: readonly string[]): string {
  let next = text;
  for (const field of fields) {
    const pattern = new RegExp(`("${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*)(-?\\d+)`, "g");
    next = next.replace(pattern, '$1"$2"');
  }
  return next;
}

async function hmacSha256HexUpper(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(new Uint8Array(signature)).toUpperCase();
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
