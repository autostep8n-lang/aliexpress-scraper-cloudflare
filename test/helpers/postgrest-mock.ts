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
  };
  const requests: RecordedRequest[] = [];
  const overrides: Override[] = [];

  async function fetchFn(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const method = req.method;
    const body = method === "POST" ? ((await req.json()) as StoredRow) : undefined;
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
      let rows = store[table] ?? [];
      for (const [key, value] of url.searchParams) {
        if (key === "select" || key === "limit" || key === "order") continue;
        if (value.startsWith("eq.")) {
          const expected = value.slice(3);
          rows = rows.filter((row) => row[key] === expected);
        }
      }
      const select = url.searchParams.get("select") ?? "*";
      const projected = rows.map((row) => project(row, select, table));
      return new Response(JSON.stringify(projected), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (method === "POST") {
      const onConflict = (url.searchParams.get("on_conflict") ?? "").split(",").map((column) => column.trim());
      const conflictColumns = onConflict.length > 0 && onConflict[0] ? onConflict : ["id"];
      const existing = (store[table] ?? []).find((row) => conflictColumns.every((column) => row[column] === body?.[column]));
      let created: boolean;
      if (existing) {
        Object.assign(existing, body);
        created = false;
      } else {
        const row: StoredRow = { id: nextId(), ...body };
        store[table].push(row);
        created = true;
      }
      const select = url.searchParams.get("select") ?? "*";
      const projected = project(existing ?? (store[table][store[table].length - 1] as StoredRow), select, table);
      return new Response(JSON.stringify([projected]), {
        status: created ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "method not supported" }), { status: 405 });
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
