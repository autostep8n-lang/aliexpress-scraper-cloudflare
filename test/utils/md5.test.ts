import { describe, expect, it } from "vitest";
import { md5 } from "../../src/utils/md5";

describe("md5", () => {
  it("matches RFC 1321 test vectors", () => {
    const cases: Array<[string, string]> = [
      ["", "d41d8cd98f00b204e9800998ecf8427e"],
      ["abc", "900150983cd24fb0d6963f7d28e17f72"],
      ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
      ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
      ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
      ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
      ["The quick brown fox jumps over the lazy dog", "9e107d9d372bb6826bd81d3542a419d6"],
    ];
    for (const [input, expected] of cases) {
      expect(md5(input)).toBe(expected);
    }
  });

  it("produces the mtop signature format the gateway expects", () => {
    // MD5("<token>&<timestamp>&<appKey>&<data>")
    const token = "641dd17c1b34a2a36b417422edb239d3";
    const timestamp = "1787672719001";
    const appKey = "12574478";
    const data = '{"productId":"1005012410104961"}';
    expect(md5(`${token}&${timestamp}&${appKey}&${data}`)).toBe("4568d60e13f94c681f7f89e3c4d2e258");
  });

  it("handles multi-byte input deterministically", () => {
    expect(md5("héllo wörld")).toBe(md5("héllo wörld"));
    expect(md5("héllo wörld")).toMatch(/^[0-9a-f]{32}$/);
  });
});
