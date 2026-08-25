# Product Intelligence Platform

A Cloudflare Worker foundation for a product intelligence and multi-platform
scraping platform. Ships with a health endpoint, a typed scraper registry, and
a Supabase client factory — structured so new scrapers and APIs can be added
incrementally.

## Stack

- [TypeScript](https://www.typescriptlang.org/) + strict mode
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) v4
- [Vitest](https://vitest.dev/) for unit tests
- [Supabase](https://supabase.com/) client (`@supabase/supabase-js`)

## Structure

```
src/
├── index.ts              # Worker entry point
├── router.ts             # Request routing (/, /health, /api/scrape)
├── env.ts                # Runtime binding types (Env)
├── health.ts             # GET /health endpoint
├── dashboard/            # Landing page / future Cloudflare Dashboard UI
├── scrapers/
│   ├── types.ts          # ScraperModule / ScraperResult contracts
│   └── registry.ts       # Scraper registration + lookup
└── supabase/
    └── client.ts         # Supabase client factory (returns null if unconfigured)
```

No concrete scrapers (AliExpress, TikTok Shop, Amazon, YouTube, Instagram,
Facebook, Alibaba) are implemented yet. Add one by implementing `ScraperModule`
in `src/scrapers/` and registering it in `src/scrapers/registry.ts`.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start local dev server (wrangler dev)
npm run typecheck    # TypeScript type checking
npm test             # Run unit tests
npm run build        # Validate the bundle without deploying
npm run deploy       # Deploy to Cloudflare (requires auth)
```

## Deploying

`npx wrangler deploy` publishes the Worker to your workers.dev subdomain.
Authenticate first with either:

```bash
npx wrangler login          # browser-based login
```

or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as environment
variables (e.g., via GitHub Actions secrets) and run:

```bash
npm run deploy
```

### Endpoints

| Method | Path             | Description                                          |
| ------ | ---------------- | ---------------------------------------------------- |
| GET    | `/`              | Landing page                                         |
| GET    | `/health`        | Health check (reports binding status, never values)  |
| GET    | `/health/supabase` | Live Supabase connectivity check (never leaks keys) |
| GET    | `/api/scrape?url=...` | Scraping API — normalizes + persists a product  |

## AliExpress scraping architecture

AliExpress no longer embeds product data server-side for many pages: the HTML
is a client-side-rendered shell (`window._d_c_.isCSR = true`) and the payload
is fetched over the internal mtop gateway. AliExpress's anti-bot
(`_____tmd_____/punish`, x5sec) also punishes headless browsers — including
Cloudflare Browser Run — so browser rendering is not a viable fallback.

The AliExpress scraper therefore recovers blocked/shell pages in this order:

1. **Official Open Platform API** (`aliexpress.ds.product.get`) when
   `ALIEXPRESS_OPENAPI_KEY` / `ALIEXPRESS_OPENAPI_SECRET` are configured. This
   is the production-grade, anti-bot-free provider (see
   `src/scrapers/aliexpress-openapi.ts`).
2. **Internal mtop gateway** (`acs.aliexpress.com`) — the same endpoint the
   website itself uses, called with a token-bootstrap + MD5-signed request. No
   browser and no API key required (see `src/scrapers/aliexpress-mtop.ts`).
3. **Cloudflare Browser Run** as a last resort (kept for other bot surfaces;
   fundamentally blocked by AliExpress).

Each provider produces the same normalize-ready shape, so the shared
normalization, deduplication, matching, and Supabase ingestion pipeline is
unchanged. When every provider is blocked, the scraper returns a precise typed
error (`BLOCKED`, `NOT_PRODUCT_PAGE`, `PROVIDER_CREDENTIALS_MISSING`, ...).

## Configuration & Secrets

No secrets are hardcoded anywhere. The Worker requires two runtime secrets,
`SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Their names are declared in
`wrangler.toml` under `[secrets]` (with `keep_vars = true`), which makes
Wrangler treat this config as the source of truth:

- `wrangler deploy` **fails fast** if either required secret is missing from
  the Worker instead of silently deploying without them.
- `keep_vars = true` prevents Wrangler from overriding environment variables
  configured in the Cloudflare dashboard on the next deploy.

Configure the actual values (never committed) through the Cloudflare Dashboard
(**Settings > Variables and Secrets**) or:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in
real values. `.dev.vars` is git-ignored.
