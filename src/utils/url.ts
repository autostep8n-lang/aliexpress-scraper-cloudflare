/**
 * URL validation helpers. Only HTTP(S) URLs are considered valid for the
 * platform - schemes such as `file:`, `javascript:`, or `data:` are never
 * accepted.
 */

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parses a string into a URL, returning null for anything that is not a
 * well-formed HTTP(S) URL.
 */
export function parseHttpUrl(value: string): URL | null {
  if (!isHttpUrl(value)) {
    return null;
  }
  return new URL(value);
}
