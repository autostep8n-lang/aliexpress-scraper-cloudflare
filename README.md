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
| GET    | `/api/scrape?url=...` | Scraping API — returns 501 until scrapers land  |

## Configuration & Secrets

No secrets are hardcoded anywhere. Bindings are declared in `wrangler.toml`
(commented out) and configured through the Cloudflare Dashboard
(**Settings > Variables and Secrets**) or:

```bash
npx wrangler secret put SUPABASE_SECRET_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in
real values. `.dev.vars` is git-ignored.
