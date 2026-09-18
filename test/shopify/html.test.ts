import { describe, expect, it } from "vitest";
import { escapeHtml, toDescriptionHtml } from "../../src/shopify/html";

describe("toDescriptionHtml", () => {
  it("maps null, undefined, and empty to an empty string without wrapping", () => {
    expect(toDescriptionHtml(null)).toBe("");
    expect(toDescriptionHtml(undefined)).toBe("");
    expect(toDescriptionHtml("")).toBe("");
  });

  it("applies the approved 5-entity escape in order and does not trim or wrap", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(toDescriptionHtml(` &<>"'\n`)).toBe(" &amp;&lt;&gt;&quot;&#39;\n");
    expect(toDescriptionHtml("<p>Hi</p>")).toBe("&lt;p&gt;Hi&lt;/p&gt;");
    expect(toDescriptionHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("does not decode entities, strip tags, or convert newlines", () => {
    expect(toDescriptionHtml("&lt;already&gt;")).toBe("&amp;lt;already&amp;gt;");
    expect(toDescriptionHtml("line1\nline2")).toBe("line1\nline2");
    expect(toDescriptionHtml("  keep  ")).toBe("  keep  ");
  });
});
