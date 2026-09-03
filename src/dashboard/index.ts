import type { Env } from "../env";
import { loadDiscoveryPage, loadOpportunitiesPage, parseProductListQuery } from "./assemble";
import { DEFAULT_PRODUCT_LIST_LIMIT, type DiscoveryPage, type DiscoveryProduct, type ProductListQuery } from "./types";

type DashboardKind = "discovery" | "opportunities";

const DASHBOARD_COPY: Record<
  DashboardKind,
  { title: string; empty: string; error: string; apiPath: string }
> = {
  discovery: {
    title: "Product Discovery",
    empty: "No products discovered yet.",
    error: "Unable to load products.",
    apiPath: "/api/products",
  },
  opportunities: {
    title: "Top Opportunities",
    empty: "No ranked opportunities.",
    error: "Unable to load opportunities.",
    apiPath: "/api/opportunities",
  },
};

/**
 * Product Discovery Dashboard (P6.26).
 *
 * Server-rendered HTML list of persisted products with compact on-read
 * P5.24 / P5.25 fields. Read-only: never writes scores or analyst results.
 */
export async function handleDashboard(url: URL, env: Env): Promise<Response> {
  return handleDashboardKind(url, env, "discovery");
}

/**
 * Top Opportunities Dashboard (P6.27).
 *
 * Server-rendered HTML list of products ranked by P5.24 Decision Opportunity
 * within the 200 most recently seen matching products. Read-only.
 */
export async function handleOpportunitiesDashboard(url: URL, env: Env): Promise<Response> {
  return handleDashboardKind(url, env, "opportunities");
}

async function handleDashboardKind(url: URL, env: Env, kind: DashboardKind): Promise<Response> {
  const parsed = parseProductListQuery(url.searchParams);
  if (!parsed.ok) {
    return htmlResponse(renderErrorPage(kind, parsed.message, parsed.code, url));
  }
  const result = kind === "opportunities" ? await loadOpportunitiesPage(env, parsed.query) : await loadDiscoveryPage(env, parsed.query);
  if (result.status === "credentials_missing") {
    return htmlResponse(renderUnconfiguredPage(kind, url));
  }
  if (result.status === "error") {
    return htmlResponse(renderErrorPage(kind, result.message, result.code ?? "PRODUCT_LIST_FAILED", url));
  }
  return htmlResponse(renderListPage(kind, result.data, parsed.query, url));
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderListPage(kind: DashboardKind, page: DiscoveryPage, query: ProductListQuery, url: URL): string {
  const copy = DASHBOARD_COPY[kind];
  const rows =
    page.products.length === 0
      ? `<p class="empty">${copy.empty}</p>`
      : `<ul class="products">${page.products.map(renderProduct).join("")}</ul>`;
  return layout(kind, `${renderFilters(query, url)}${rows}${renderPager(page, query, url)}`, url);
}

function renderProduct(product: DiscoveryProduct): string {
  const image = product.primaryImageUrl
    ? `<img src="${escapeHtml(product.primaryImageUrl)}" alt="" width="72" height="72" />`
    : `<div class="placeholder" aria-hidden="true"></div>`;
  const caveats =
    product.decision.caveats.length > 0
      ? `<p class="caveats">${escapeHtml(product.decision.caveats.join("; "))}</p>`
      : "";
  const country = product.decision.selectedCountry ? ` · ${escapeHtml(product.decision.selectedCountry)}` : "";
  return `<li class="product">
      ${image}
      <div>
        <h2>${escapeHtml(product.title)}</h2>
        <p class="meta">${escapeHtml(product.brand ?? "Unknown brand")} · ${escapeHtml(product.lifecycleStatus)} · ${escapeHtml(product.availabilityStatus)}</p>
        <p class="score">Score ${product.decision.score.value} (${escapeHtml(product.decision.score.tier)})${country}</p>
        <p class="summary">${escapeHtml(product.decision.summary)}</p>
        ${caveats}
      </div>
    </li>`;
}

function renderFilters(query: ProductListQuery, url: URL): string {
  const lifecycle = query.lifecycle ?? "";
  const q = query.q ?? "";
  return `<form class="filters" method="get" action="${escapeHtml(url.pathname)}">
      <label>Search <input type="search" name="q" value="${escapeHtml(q)}" /></label>
      <label>Lifecycle
        <select name="lifecycle">
          <option value="">Any</option>
          ${["discovered", "active", "tracking", "inactive", "archived"]
            .map((value) => `<option value="${value}"${lifecycle === value ? " selected" : ""}>${value}</option>`)
            .join("")}
        </select>
      </label>
      <button type="submit">Filter</button>
    </form>`;
}

function renderPager(page: DiscoveryPage, query: ProductListQuery, url: URL): string {
  const { limit, offset, total } = page.page;
  if (total <= limit) {
    return `<p class="pager">${total} product${total === 1 ? "" : "s"}</p>`;
  }
  const prev = offset > 0 ? pagerHref(url, query, Math.max(0, offset - limit)) : null;
  const next = offset + limit < total ? pagerHref(url, query, offset + limit) : null;
  return `<nav class="pager">
      ${prev ? `<a href="${escapeHtml(prev)}">Previous</a>` : `<span>Previous</span>`}
      <span>${offset + 1}–${Math.min(offset + limit, total)} of ${total}</span>
      ${next ? `<a href="${escapeHtml(next)}">Next</a>` : `<span>Next</span>`}
    </nav>`;
}

function pagerHref(url: URL, query: ProductListQuery, offset: number): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.lifecycle) params.set("lifecycle", query.lifecycle);
  if (query.limit !== DEFAULT_PRODUCT_LIST_LIMIT) params.set("limit", String(query.limit));
  if (offset > 0) params.set("offset", String(offset));
  const search = params.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

function renderUnconfiguredPage(kind: DashboardKind, url: URL): string {
  return layout(
    kind,
    `<p class="empty">Supabase is not configured. Check <a href="${escapeHtml(`${url.protocol}//${url.host}/health/supabase`)}">/health/supabase</a>.</p>`,
    url,
  );
}

function renderErrorPage(kind: DashboardKind, message: string, code: string, url: URL): string {
  return layout(
    kind,
    `<p class="error">${DASHBOARD_COPY[kind].error} ${escapeHtml(code)}: ${escapeHtml(message)}</p>`,
    url,
  );
}

function layout(kind: DashboardKind, body: string, url: URL): string {
  const copy = DASHBOARD_COPY[kind];
  const baseUrl = `${url.protocol}//${url.host}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(copy.title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #0b1220; color: #e6edf3; }
      main { max-width: 52rem; margin: 0 auto; }
      h1 { font-size: 1.5rem; }
      h2 { font-size: 1.05rem; margin: 0 0 0.25rem; }
      a { color: #58a6ff; }
      .filters { display: flex; gap: 0.75rem; flex-wrap: wrap; margin: 1rem 0 1.5rem; align-items: end; }
      .filters input, .filters select, .filters button { background: #1c2333; color: #e6edf3; border: 1px solid #30363d; border-radius: 4px; padding: 0.4rem 0.6rem; }
      .products { list-style: none; padding: 0; margin: 0; display: grid; gap: 1rem; }
      .product { display: grid; grid-template-columns: 72px 1fr; gap: 1rem; background: #161b26; padding: 1rem; border-radius: 8px; }
      .product img, .placeholder { width: 72px; height: 72px; object-fit: cover; border-radius: 6px; background: #1c2333; }
      .meta, .score, .summary, .caveats, .pager, .empty, .error { color: #9da7b3; margin: 0.2rem 0; }
      .caveats, .error { color: #f0883e; }
      .pager { display: flex; gap: 1rem; margin-top: 1.5rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(copy.title)}</h1>
      ${body}
      <p><a href="${baseUrl}/health">/health</a> · <a href="${baseUrl}${copy.apiPath}">${copy.apiPath}</a></p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
