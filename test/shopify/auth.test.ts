import { describe, expect, it } from "vitest";
import { readBearerToken, timingSafeEqual } from "../../src/shopify/auth";

describe("readBearerToken", () => {
  it("reads Authorization Bearer tokens and rejects other schemes", () => {
    expect(readBearerToken(new Request("https://x", { headers: { Authorization: "Bearer secret-token" } }))).toBe(
      "secret-token",
    );
    expect(readBearerToken(new Request("https://x", { headers: { authorization: "bearer other" } }))).toBe("other");
    expect(readBearerToken(new Request("https://x", { headers: { Authorization: "Basic abc" } }))).toBeNull();
    expect(readBearerToken(new Request("https://x"))).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("compares equal strings as true and unequal as false", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});
