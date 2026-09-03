/**
 * Shared in-memory PostgREST mock used by repository and API tests.
 *
 * Implements just enough of the PostgREST protocol (GET selects with `eq.`
 * filters, POST upserts keyed on `on_conflict`) to exercise the real
 * supabase-js client. Rows live in an in-memory store so upsert conflicts
 * update rather than duplicate, mirroring the real database's unique indexes.
 */

export interface StoredRow {
  id: string;
  [key: string]: unknown;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

interface Override {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

const TABLE_DEFAULTS: Record<string, Record<string, unknown>> = {
  sources: { kind: "platform", base_url: null, enabled: true, metadata: {} },
  products: {
    dedup_key: null,
    canonical_url: null,
    description: null,
    brand: null,
    category_id: null,
    primary_image_url: null,
    images: [],
    attributes: {},
    availability_status: "unknown",
    lifecycle_status: "discovered",
    first_seen_at: "2026-08-18T00:00:00.000Z",
    last_seen_at: "2026-08-18T00:00:00.000Z",
  },
  product_categories: { parent_id: null, source_id: null, external_id: null, slug: null, path: [] },
  product_sources: {
    external_parent_id: null,
    title: null,
    description: null,
    brand: null,
    category_id: null,
    image_urls: [],
    original_price: null,
    shipping: {},
    rating_average: null,
    rating_count: null,
    reviews_count: null,
    available: null,
    attributes: {},
    raw: null,
    first_seen_at: "2026-08-18T00:00:00.000Z",
    last_seen_at: "2026-08-18T00:00:00.000Z",
    last_scraped_at: null,
  },
  google_trends: {
    category: null,
    captured_at: "2026-08-18T00:00:00.000Z",
    metadata: {},
  },
  reddit_signals: {
    result_limit: 25,
    avg_score: null,
    top_subreddit: null,
    captured_at: "2026-08-18T00:00:00.000Z",
    metadata: {},
  },
  youtube_signals: {
    result_limit: 25,
    avg_views: null,
    top_video_id: null,
    top_video_title: null,
    top_channel: null,
    captured_at: "2026-08-18T00:00:00.000Z",
    metadata: {},
  },
  instagram_signals: {
    hashtag: "",
    result_limit: 25,
    media_count: 0,
    top_media_count: 0,
    recent_media_count: 0,
    total_likes: 0,
    total_comments: 0,
    total_engagement: 0,
    avg_likes: null,
    avg_engagement: null,
    top_media_id: null,
    top_media_caption: null,
    captured_at: "2026-08-18T00:00:00.000Z",
    metadata: {},
  },
  country_opportunity_scores: {
    score_type: "country_opportunity",
    min_value: 0,
    max_value: 100,
    normalized: 0,
    total_weight: 0,
    tier: "unknown",
    version: 1,
    inputs: {},
    country_latest_value: null,
    country_change: null,
    country_direction: null,
    computed_at: "2026-08-18T00:00:00.000Z",
  },
  scores: {
    product_source_id: null,
    min_value: 0,
    max_value: 100,
    version: 1,
    inputs: {},
    computed_at: "2026-08-18T00:00:00.000Z",
  },
};

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

function project(row: StoredRow, select: string, table: string): StoredRow {
  const merged: StoredRow = { ...(TABLE_DEFAULTS[table] ?? {}), ...row };
  const columns = select
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
  if (columns.length === 0 || columns[0] === "*") return merged;
  const out: StoredRow = { id: merged.id };
  for (const column of columns) {
    if (column in merged) out[column] = merged[column];
  }
  return out;
}

export interface MockPostgrest {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
  store: Record<string, StoredRow[]>;
  seed(table: string, rows: StoredRow[]): void;
  override(method: string, path: string, status: number, body: unknown): void;
}

export function createMockPostgrest(): MockPostgrest {
  const store: Record<string, StoredRow[]> = {
    sources: [],
    products: [],
    product_categories: [],
    product_sources: [],
    google_trends: [],
    reddit_signals: [],
    youtube_signals: [],
    instagram_signals: [],
    country_opportunity_scores: [],
    scores: [],
  };
  const requests: RecordedRequest[] = [];
  const overrides: Override[] = [];

  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const method = req.method;
    const body = method === "POST" || method === "PATCH" ? await req.json() : undefined;
    requests.push({ method, url: req.url, headers: req.headers, body });

    const overrideIndex = overrides.findIndex(
      (override) => override.method === method && url.pathname.includes(override.path),
    );
    if (overrideIndex !== -1) {
      const [override] = overrides.splice(overrideIndex, 1);
      return new Response(JSON.stringify(override.body), {
        status: override.status,
        headers: { "content-type": "application/json" },
      });
    }

    const table = url.pathname.replace(/^\/rest\/v1\//, "");

    if (method === "GET") {
      let rows = applySearchParams(store[table] ?? [], url.searchParams);
      rows = applyOrder(rows, url.searchParams.get("order"));
      const total = rows.length;
      const sliced = applyRange(rows, url.searchParams, req.headers);
      const select = url.searchParams.get("select") ?? "*";
      const projected = sliced.map((row) => project(row, select, table));
      const rangeStart = sliced.length === 0 ? 0 : rows.indexOf(sliced[0]);
      const rangeEnd = sliced.length === 0 ? 0 : rows.indexOf(sliced[sliced.length - 1]);
      const contentRange = sliced.length === 0 ? `*/${total}` : `${rangeStart}-${rangeEnd}/${total}`;
      return new Response(JSON.stringify(projected), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": contentRange,
        },
      });
    }

    if (method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const onConflict = (url.searchParams.get("on_conflict") ?? "").split(",").map((column) => column.trim());
      const conflictColumns = onConflict.length > 0 && onConflict[0] ? onConflict : ["id"];
      let anyCreated = false;
      const results: StoredRow[] = [];
      for (const row of rows) {
        const existing = (store[table] ?? []).find((candidate) =>
          conflictColumns.every((column) => candidate[column] === row?.[column]),
        );
        if (existing) {
          Object.assign(existing, row);
          results.push(existing);
        } else {
          const stored: StoredRow = { id: nextId(), ...row };
          store[table].push(stored);
          results.push(stored);
          anyCreated = true;
        }
      }
      const select = url.searchParams.get("select") ?? "*";
      const projected = results.map((row) => project(row, select, table));
      return new Response(JSON.stringify(projected), {
        status: anyCreated ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "PATCH") {
      const rows = applySearchParams(store[table] ?? [], url.searchParams);
      for (const row of rows) {
        Object.assign(row, body);
      }
      const select = url.searchParams.get("select") ?? "";
      if (!select) {
        return new Response(null, { status: 204 });
      }
      const projected = rows.map((row) => project(row, select, table));
      return new Response(JSON.stringify(projected), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "method not supported" }), { status: 405 });
  }

  function applySearchParams(rows: StoredRow[], params: URLSearchParams): StoredRow[] {
    let filtered = [...rows];
    for (const [key, value] of params) {
      if (key === "select" || key === "limit" || key === "offset" || key === "order" || key === "on_conflict") continue;
      if (value.startsWith("eq.")) {
        const expected = value.slice(3);
        filtered = filtered.filter((row) => row[key] === expected);
      } else if (value.startsWith("ilike.")) {
        const pattern = value.slice(6).replace(/\\%/g, "%").replace(/\\_/g, "_");
        const regex = new RegExp("^" + pattern.split("%").map(escapeRegExp).join(".*") + "$", "i");
        filtered = filtered.filter((row) => typeof row[key] === "string" && regex.test(String(row[key])));
      } else if (value.startsWith("in.")) {
        const inner = value.slice(3).replace(/^\(/, "").replace(/\)$/, "");
        const expected = inner
          .split(",")
          .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
          .filter(Boolean);
        filtered = filtered.filter((row) => expected.includes(String(row[key])));
      } else if (value.startsWith("cs.")) {
        const expected = JSON.parse(value.slice(3)) as unknown[];
        filtered = filtered.filter((row) => {
          const cell = row[key];
          if (Array.isArray(cell)) return expected.every((item) => cell.includes(item));
          if (typeof cell === "object" && cell !== null) {
            const record = cell as Record<string, unknown>;
            return expected.every((item) => Object.values(record).includes(item));
          }
          return false;
        });
      } else if (key === "or") {
        const inner = value.replace(/^\((.*)\)$/, "$1");
        filtered = filtered.filter((row) => {
          for (const clause of inner.split(",")) {
            const dot1 = clause.indexOf(".");
            const dot2 = clause.indexOf(".", dot1 + 1);
            if (dot1 === -1 || dot2 === -1) continue;
            const column = clause.slice(0, dot1);
            const operator = clause.slice(dot1 + 1, dot2);
            const operand = clause.slice(dot2 + 1).replace(/\*/g, "%");
            const single = new URLSearchParams([[column, `${operator}.${operand}`]]);
            if (applySearchParams([row], single).length > 0) return true;
          }
          return false;
        });
      }
    }
    return filtered;
  }

  function applyOrder(rows: StoredRow[], order: string | null): StoredRow[] {
    if (!order) return rows;
    const parts = order.split(",").map((part) => part.trim()).filter(Boolean);
    return [...rows].sort((left, right) => {
      for (const part of parts) {
        const [column, direction] = part.split(".");
        const av = left[column];
        const bv = right[column];
        if (av === bv) continue;
        const cmp = String(av) < String(bv) ? -1 : 1;
        return direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  function applyRange(rows: StoredRow[], params: URLSearchParams, headers: Headers): StoredRow[] {
    const range = headers.get("Range") ?? headers.get("range");
    if (range) {
      const match = /^(\d+)-(\d+)$/.exec(range);
      if (match) {
        return rows.slice(Number(match[1]), Number(match[2]) + 1);
      }
    }
    const offsetRaw = params.get("offset");
    const limitRaw = params.get("limit");
    const offset = offsetRaw ? Number(offsetRaw) : 0;
    if (limitRaw) {
      return rows.slice(offset, offset + Number(limitRaw));
    }
    return offset > 0 ? rows.slice(offset) : rows;
  }

  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return {
    fetch: fetchFn,
    requests,
    store,
    seed(table, rows) {
      store[table].push(...rows);
    },
    override(method, path, status, body) {
      overrides.push({ method, path, status, body });
    },
  };
}
