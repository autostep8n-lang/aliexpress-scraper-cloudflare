import { describe, expect, it } from "vitest";
import { DS_TOKEN_CREATE_PATH, dsGopTimestamp, dsHmacSign, dsTimestamp } from "../../src/scrapers/aliexpress-sign";

const SECRET = "test-app-secret";

async function expectedHmac(secret: string, params: Record<string, string>, apiPath?: string): Promise<string> {
  const sorted = Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== "")
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  const payload = `${apiPath ?? ""}${sorted}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

describe("dsTimestamp", () => {
  it("formats UTC+8 time as yyyy-MM-dd HH:mm:ss", () => {
    expect(dsTimestamp(new Date("2026-08-25T00:00:00.000Z"))).toBe("2026-08-25 08:00:00");
  });

  it("rolls the date across midnight correctly", () => {
    expect(dsTimestamp(new Date("2026-08-25T17:00:00.000Z"))).toBe("2026-08-26 01:00:00");
  });
});

describe("dsGopTimestamp", () => {
  it("formats unix milliseconds as a decimal string", () => {
    expect(dsGopTimestamp(new Date("2026-08-25T00:00:00.000Z"))).toBe("1787616000000");
  });

  it("is within 7200s of UTC when compared as unix seconds", () => {
    const now = new Date("2026-08-25T12:34:56.789Z");
    const gopMs = Number(dsGopTimestamp(now));
    expect(gopMs).toBe(now.getTime());
    expect(Math.abs(gopMs - now.getTime())).toBeLessThan(7200 * 1000);
  });

  it("is not a TOP UTC+8 datetime string", () => {
    const now = new Date("2026-08-25T00:00:00.000Z");
    expect(dsGopTimestamp(now)).not.toBe(dsTimestamp(now));
    expect(dsGopTimestamp(now)).not.toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("dsHmacSign", () => {
  it("signs business params as uppercase HMAC-SHA256 hex", async () => {
    const params = {
      method: "aliexpress.ds.product.get",
      app_key: "k",
      timestamp: "2026-08-25 08:00:00",
      sign_method: "sha256",
      product_id: "1005001",
      ship_to_country: "US",
      access_token: "tok",
    };
    const sign = await dsHmacSign(SECRET, params);
    expect(sign).toMatch(/^[0-9A-F]{64}$/);
    expect(sign).toBe(await expectedHmac(SECRET, params));
  });

  it("prepends api_path for system APIs", async () => {
    const params = {
      code: "auth-code",
      app_key: "k",
      timestamp: "2026-08-25 08:00:00",
      sign_method: "sha256",
    };
    const sign = await dsHmacSign(SECRET, params, DS_TOKEN_CREATE_PATH);
    expect(sign).toBe(await expectedHmac(SECRET, params, DS_TOKEN_CREATE_PATH));
    expect(sign).not.toBe(await expectedHmac(SECRET, params));
  });

  it("excludes sign and empty values", async () => {
    const params = { a: "1", sign: "ignored", b: "", c: "2" };
    const sign = await dsHmacSign("s", params);
    expect(sign).toBe(await expectedHmac("s", { a: "1", c: "2" }));
  });
});
