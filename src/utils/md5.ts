/**
 * RFC 1321 MD5 message-digest algorithm.
 *
 * Pure TypeScript implementation with no native bindings, so it runs on
 * Cloudflare Workers (WebCrypto `crypto.subtle` does not expose MD5). The
 * AliExpress mtop gateway signs every request with
 * `MD5("<token>&<timestamp>&<appKey>&<data>")`, so a byte-accurate digest is
 * required rather than any hashing convenience wrapper.
 *
 * Only the UTF-8 string form is exposed, which is all the mtop protocol needs
 * (its request payload is a JSON literal, so non-ASCII characters are already
 * escaped as `\uXXXX`). The digest is returned lowercase hex, matching the
 * signature format the mtop gateway expects.
 */

const S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

/** Round constants: `floor(abs(sin(i + 1)) * 2^32)`, matching RFC 1321. */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

const HEX = "0123456789abcdef";

export function md5(input: string): string {
  const message = new TextEncoder().encode(input);
  const byteLen = message.length;

  // Padded length: message + 0x80 + zeros to 56 mod 64 + 8-byte little-endian
  // bit length. The inputs here are tiny, but the length math stays correct up
  // to 2^32 bytes (the bit length is carried across two 32-bit words).
  const paddedLen = (((byteLen + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(message);
  padded[byteLen] = 0x80;
  const bitLenLow = (byteLen << 3) >>> 0;
  const bitLenHigh = Math.floor(byteLen / 0x20000000) >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, bitLenLow, true);
  dv.setUint32(paddedLen - 4, bitLenHigh, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      words[i] =
        padded[p] |
        (padded[p + 1] << 8) |
        (padded[p + 2] << 16) |
        (padded[p + 3] << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = ((b & c) | (~b & d)) >>> 0;
        g = i;
      } else if (i < 32) {
        f = ((d & b) | (~d & c)) >>> 0;
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = (b ^ c ^ d) >>> 0;
        g = (3 * i + 5) % 16;
      } else {
        f = (c ^ (b | ~d)) >>> 0;
        g = (7 * i) % 16;
      }

      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + words[g]) >>> 0, S[i])) >>> 0;
      a = tmp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return hex32(a0) + hex32(b0) + hex32(c0) + hex32(d0);
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function hex32(value: number): string {
  return (
    hexByte(value & 0xff) +
    hexByte((value >>> 8) & 0xff) +
    hexByte((value >>> 16) & 0xff) +
    hexByte((value >>> 24) & 0xff)
  );
}

function hexByte(value: number): string {
  return HEX[(value >>> 4) & 0xf] + HEX[value & 0xf];
}
