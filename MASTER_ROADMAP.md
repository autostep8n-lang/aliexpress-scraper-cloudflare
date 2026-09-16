# Master Roadmap

> **Source of truth for project sequencing and status.**
>
> This roadmap supersedes older roadmap versions. Do not restart completed phases or block the project on TikTok Shop Saudi Arabia availability.

## Current Status

- **P0 — Foundation: DONE**
- **P1.1 — Product Matching / Deduplication: DONE**
  - Pure source-agnostic matching library under `src/matching/`.
  - Integrated into product upsert/deduplication flow.
  - 223 tests across 16 files passing.
  - Typecheck clean.
  - Wrangler build/dry-run passing.
  - Production deployment remains a separate verification step where credentials are available.
- **P1.2 — Product Normalization & Enrichment: DONE**
  - Reusable pure enrichment engine under `src/products/enrich.ts`.
- **P1.3 — Scoring Engine: DONE**
  - Deterministic scoring engine and quality signals under `src/scoring/`.
- **P1.4 — Trend History Engine: DONE**
  - Trend history engine under `src/trends/`.
- **P1.5 — Product Lifecycle: DONE**
  - Lifecycle engine under `src/lifecycle/`.
- **P1.6 — Profit Engine: DONE**
  - Deterministic product profit engine under `src/profit/` (cost breakdown, net profit, margin, ROI, `metrics` row mapping).
- **P1.8 — Amazon Scraper: DONE**
  - Deterministic Amazon adapter + JSON-LD-first parser under `src/scrapers/amazon*.ts`; registered in `src/scrapers/registry.ts` and wired through `/api/scrape` (`amazon:<ASIN>` identity, redirect safety, cache, browser-recovery for blocked pages).
- **P1.9 — AliExpress Production Scraper: DONE**
  - Cloudflare-native AliExpress adapter + layered parser (runParams / RDS / JSON-LD / HTML fallbacks) under `src/scrapers/aliexpress*.ts`; registered in `src/scrapers/registry.ts` and wired through `/api/scrape` (`aliexpress:<itemId>` identity, regional domain support, redirect safety, cache, browser-recovery for blocked pages).
- **P1.10 — Competition / Opportunity Score: DONE**
  - Deterministic competition and market opportunity scoring engine under `src/opportunity/` (competition pressure, demand and profit signals, `scores` row mapping).
- **P3.1 — Google Trends / Market Intelligence: DONE**
  - Cloudflare-native Google Trends provider + deterministic engine + persistence under `src/market/`; wired through `GET /api/market/google-trends`.
  - 67/67 focused P3.1 tests and 582/582 full-suite tests passing; typecheck, build and `git diff --check` clean; commit `3bc0461`.
- **P3.2 — Reddit Intelligence: DONE**
  - Implemented and merged as PR #1; implementation commit `b6ac2dc`, merge commit `324962b`.
- **P3.3 — YouTube Signals: DONE**
  - Cloudflare-native YouTube provider (`search.list` + `videos.list`) + deterministic engine + `youtube_signals` persistence under `src/market/`; wired through `GET /api/market/youtube`; implementation commit `978aca8`.
- **P3.4 — Instagram Signals: DONE**
  - Cloudflare-native Instagram Graph API provider (`hashtag_search` + `top_media` + `recent_media`) + deterministic engine + `instagram_signals` persistence under `src/market/`; wired through `GET /api/market/instagram`; implementation commit `7e89531`.
- **P3.5 — Facebook Signals: SKIPPED / BLOCKED**
  - Official Meta Graph API does not provide a generally available public organic keyword → posts + engagement discovery signal comparable to P3.2 Reddit, P3.3 YouTube, and P3.4 Instagram.
  - No generally available public Facebook keyword/post search API.
  - `/search?type=post` is not available for this purpose.
  - Pages Search is page discovery, not organic keyword demand/content discovery.
  - Page public content access requires additional Meta permissions/review and still does not provide arbitrary keyword-level market search.
  - Ads Library / ads-related APIs are advertising intelligence, not organic market signals.
  - No implementation, registry change, migration, or secrets added.
- **P3.6 — Pinterest Signals: SKIPPED / BLOCKED**
  - Official Pinterest API v5 does not provide a generally available public organic keyword → content + engagement signal comparable to P3.2 Reddit, P3.3 YouTube, and P3.4 Instagram.
  - `/search/pins` and `/search/boards` search only the token user's own content.
  - `/search/partner/pins` is beta/restricted and returns no useful engagement metrics.
  - Trends API (`/trends/keywords/{region}/top/{trend_type}`) returns top trending keywords, not arbitrary keyword lookup.
  - Ads keyword metrics (`/ad_accounts/{ad_account_id}/keywords/metrics`) are advertising intelligence, not organic market signals.
  - No implementation, registry change, migration, or secrets added.
- **P4.22 — Country Intelligence Engine: DONE**
  - Pure engine `analyzeCountryIntelligence` under `src/country/`; country-scoped demand evidence from existing Google Trends observations (keyword + ISO alpha-2).
  - V1 countries: SA / US / GB / DE / FR / ES / IT. GB is the ISO alpha-2 code for the UK. EU is not a country key.
  - Current production ingest is SA MVP.
- **P4.23 — Country Opportunity Scoring: DONE**
  - Deterministic product × country scoring under `src/country/`; persistence in `country_opportunity_scores`.
  - Missing optional signals remain excluded from the weighted mean per the existing engine; absence of country evidence forces tier `unknown`.
  - Current production ingest is SA MVP.
- **P5.24 — Opportunity Score: DONE**
  - Deterministic product-global aggregator in `src/decision/`; composes P1.10 `market_opportunity` with the best eligible P4.23 `country_opportunity` using equal weighting; on-read via API/dashboard.
- **P5.25 — AI Product Analyst: DONE**
  - Deterministic template explainer in `src/analyst/`; explains frozen P5.24 score, evidence and decision; compact fields exposed on-read; no LLM or analyst persistence required.
- **P6.26 — Product Discovery Dashboard: DONE**
  - Read-only product discovery dashboard (`GET /`) lists persisted products by `last_seen_at` descending with search/lifecycle filters and pagination; compact on-read P5.24 / P5.25 decision fields; titles link to the P6.28 detail/analysis surface; JSON list API at `GET /api/products`; existing error contracts preserved.
- **P6.28 — Product Detail / Analysis: DONE**
  - Read-only product detail API (`GET /api/products/:id`) and HTML analysis surface (`GET /products/:id`) implemented; reuses deterministic P5.24 / P5.25 analyst evidence on-read; malformed product IDs return the existing 404 `NOT_FOUND` contract without querying the database; production smoke verification passed.
- **P6.27 — Top Opportunities: DONE**
  - Read-only ranked opportunities surface (`GET /opportunities` HTML + `GET /api/opportunities` JSON); on-read P5.24 `decision_opportunity` ranking over the 200 most-recent matching products; excludes unknown/zero-weight scores; search/lifecycle filters and pagination; titles link to P6.28 detail/analysis; existing error contracts preserved.
- **P7.29 — Daily Product Discovery: DONE**
  - Cloudflare Worker `scheduled` handler with daily Cron Trigger `0 0 * * *` (midnight UTC).
  - Reuses existing TikTok Shop discovery (`tiktokDiscovery.discover`) and existing `normalizeProduct` + `upsertProduct` persistence; no jobs/job_runs.
  - Deterministic scheduled defaults: query `"earbuds"`, no region, no category, limit 20.
  - Idempotent persistence by `(source, external_id)`; focused tests and typed error handling; no new secrets or providers.
  - Implementation commit `71f78f8`. Not deployed.
- **P7.30 — Automated Scoring Pipeline: DONE**
  - Chained into the existing daily Cron Trigger `0 0 * * *` after discovery; runs only when discovery succeeds, and a scoring failure never erases successful discovery.
  - Persists `competition` / `market_opportunity` from the existing P1.10 engine via a new bulk writer keyed on `(product_id, score_type, version)` (new unique constraint migration `20260817000017`); re-runs update in place and never append duplicates.
  - `decision_opportunity` (P5.24) and the analyst explanation (P5.25) remain on-read.
  - Bounded paging (50 per batch, 200 products max) reconstructs demand from persisted observations; competition is skipped with an explicit reason (discovery collects no competitor data) instead of writing a fabricated value.
  - Focused pipeline, repository, migration and scheduled-integration tests; no new secrets or providers. Not deployed.
- **P7.31 — Alerts: DONE**
  - Pure deterministic alert engine under `src/alerts/` (`high_market_opportunity`, `high_country_opportunity`, `lifecycle_review`) with no I/O, wall-clock or randomness; candidates are ordered by `productId -> alertType -> dedupKey` and deduplicated on `(product_id, alert_type, dedup_key)`.
  - Market alerts require `value >= 65` and `total_weight > 0`; country alerts require tier `high` + an eligible v1 country + `score_type = country_opportunity`; invalid / NaN evidence is skipped, never coerced.
  - Persistence uses the approved schema in migration `20260817000018_alerts.sql` (`severity in info|warning|critical`, `summary`, `inputs`, nullable `country` / `value` / `tier`, unique `(product_id, alert_type, dedup_key)`, updated_at trigger, RLS enabled, non-destructive); the mixed/legacy `message`/`evidence` contract was removed.
  - Scheduled pipeline preserves `discovery -> scoring -> alerts` with failure isolation: a discovery/scoring failure yields no alerts run, an alert failure never erases a successful discovery/scoring result, and active alerts resolve and reactivate deterministically through an injected clock seam.
  - Read-only `GET /api/alerts?limit&offset&status` (default `limit=20`, `offset=0`; max 50; invalid limit/offset/status -> 400; Supabase unavailable -> 503; repository failure -> 502); no mutation endpoint.
  - Lifecycle limitation: the existing pipeline never produces/persists lifecycle transitions, so products stay at the ingestion default and `lifecycle_review` alerts remain safely at zero in production; the rule stays unit-tested against `inactive` / `archived` and no new lifecycle behavior was introduced.
  - Focused engine/pipeline/repository/API/scheduled/migration tests; not deployed (migration 18 not applied to production).
- **Next task: P7.32 — Reports**

## P0 — Foundation

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Architecture + GitHub + Cloudflare + Supabase + MonkeyCode | DONE | Foundation complete |
| 2 | Supabase Database & Schema | DONE | Schema and required infrastructure complete |
| 3 | Unified Product Model | DONE | Canonical product identity/model established |
| 4 | Product Ingestion API | DONE | Product validation, source resolution and ingestion complete |
| 5 | Source / Job Infrastructure | DONE | Sources, jobs and job-run infrastructure complete |

## P1 — Intelligence Core

| # | Feature | Status | Notes |
|---|---|---|---|
| 6 | Product Matching / Deduplication | DONE | Completed as P1.1; 223 tests passing |
| 7 | Product Normalization & Enrichment | DONE | Completed as P1.2; reusable pure engine in `src/products/enrich.ts` |
| 8 | Scoring Engine | DONE | Completed as P1.3; deterministic engine in `src/scoring/` |
| 9 | Trend History Engine | DONE | Completed as P1.4; engine in `src/trends/` |
| 10 | Product Lifecycle | DONE | Completed as P1.5; engine in `src/lifecycle/` |
| 11 | Profit Engine | DONE | Completed as P1.6; deterministic engine in `src/profit/` |
| 12 | Competition / Opportunity Score | DONE | Completed as P1.10; deterministic engine in `src/opportunity/` |

## P2 — Product Sources

| # | Feature | Status | Notes |
|---|---|---|---|
| 13 | AliExpress Production Scraper | DONE | Completed as P1.9; Cloudflare-native adapter + layered parser, `aliexpress:<itemId>` identity |
| 14 | Amazon Scraper | DONE | Completed as P1.8; commit `d012f71`, `amazon:<ASIN>` identity |
| 15 | TikTok Scraper | PARTIAL | Adapter/discovery work exists; TikTok Shop Saudi Arabia is not officially available and must not block the project |

## P3 — Market Intelligence

| # | Feature | Status | Notes |
|---|---|---|---|
| 16 | Google Trends | DONE | Completed as P3.1; commit `3bc0461`, `GET /api/market/google-trends`, provider abstraction + persistence in `src/market/` |
| 17 | Reddit Intelligence | DONE | Implemented and merged as PR #1; implementation commit `b6ac2dc`, merge commit `324962b` |
| 18 | YouTube Signals | DONE | Completed as P3.3; implementation commit `978aca8`, `GET /api/market/youtube`, provider + engine + persistence in `src/market/youtube*.ts` |
| 19 | Instagram Signals | DONE | Completed as P3.4; implementation commit `7e89531`, `GET /api/market/instagram`, provider + engine + persistence in `src/market/instagram*.ts` |
| 20 | Facebook Signals | SKIPPED / BLOCKED | Official Meta Graph API has no generally available public organic keyword → posts + engagement discovery signal comparable to Reddit / YouTube / Instagram. No public Facebook keyword/post search API; `/search?type=post` is not available for this purpose; Pages Search is page discovery not keyword demand; Page public content access requires extra Meta review and still is not arbitrary keyword-level market search; Ads Library / ads APIs are advertising intelligence, not organic market signals. Not implemented. |
| 21 | Pinterest Signals | SKIPPED / BLOCKED | Official API has no generally available public organic keyword → content + engagement signal comparable to Reddit / YouTube / Instagram. `/search/pins` and `/search/boards` are user-owned; `/search/partner/pins` is beta/restricted without useful engagement; Trends API is top-trend lists not arbitrary lookup; ads keyword metrics are advertising intelligence, not organic market signals. Not implemented. |

## P4 — Country Intelligence

| # | Feature | Status | Notes |
|---|---|---|---|
| 22 | Country Intelligence Engine | DONE | `analyzeCountryIntelligence`; Google Trends evidence; v1 SA / US / GB / DE / FR / ES / IT (GB = UK; EU is not a country key); production ingest SA MVP |
| 23 | Country Opportunity Scoring | DONE | Product × country score + `country_opportunity_scores`; missing optional signals excluded per existing engine; production ingest SA MVP |

## P5 — Decision Engine

| # | Feature | Status | Notes |
|---|---|---|---|
| 24 | Opportunity Score | DONE | Deterministic product-global aggregator in `src/decision/`; composes P1.10 `market_opportunity` with the best eligible P4.23 `country_opportunity` using equal weighting; on-read via API/dashboard |
| 25 | AI Product Analyst | DONE | Deterministic template explainer in `src/analyst/`; explains frozen P5.24 score, evidence and decision; compact fields exposed on-read; no LLM or analyst persistence required |

## P6 — Dashboard

| # | Feature | Status | Notes |
|---|---|---|---|
| 26 | Product Discovery Dashboard | DONE | Read-only recency-based product list (`GET /` + `GET /api/products`); search/lifecycle filters and pagination; compact on-read P5.24 / P5.25 decision fields; titles link to P6.28 detail/analysis; existing error contracts preserved |
| 27 | Top Opportunities | DONE | Read-only ranked opportunities (`GET /opportunities` + `GET /api/opportunities`); on-read P5.24 ranking over the 200 most-recent matching products; excludes unknown/zero-weight; search/lifecycle filters and pagination; titles link to P6.28; existing error contracts preserved |
| 28 | Product Detail / Analysis | DONE | Read-only product detail API + HTML analysis surface; reuses deterministic P5.24 / P5.25 analyst evidence on-read; malformed product IDs return existing 404 `NOT_FOUND`; production smoke verification passed |

## P7 — Automation

| # | Feature | Status | Notes |
|---|---|---|---|
| 29 | Daily Product Discovery | DONE | Cloudflare scheduled handler with daily Cron Trigger at 0 0 * * *; reuses existing TikTok Shop discovery, normalizeProduct and upsertProduct flow; scheduled defaults are query "earbuds", no region/category, limit 20; idempotent persistence; focused tests and error handling; no new secrets/providers. |
| 30 | Automated Scoring Pipeline | DONE | Chained into the existing daily cron after discovery; persists `competition` / `market_opportunity` via existing P1.10 engine keyed on `(product_id, score_type, version)`; P5.24/P5.25 stay on-read; bounded paging; skips competition when no real input exists. |
| 31 | Alerts | DONE | Deterministic engine (`high_market_opportunity` / `high_country_opportunity` / `lifecycle_review`) persisted to `alerts` via migration `20260817000018`; scheduled after scoring with failure isolation; read-only `GET /api/alerts` (default limit 20, max 50). Lifecycle limitation: pipeline never persists lifecycle transitions, so `lifecycle_review` stays at zero in production. Not deployed. |
| 32 | Reports | TODO | Not started |

## P8 — Commerce & Advanced

| # | Feature | Status | Notes |
|---|---|---|---|
| 33 | Shopify Integration | TODO | Not started |
| 34 | Supplier Ranking | TODO | Not started |
| 35 | Ad Intelligence | TODO | Not started |
| 36 | Historical ML / Prediction | TODO | Not started |
| 37 | Fully Automated Pipeline | TODO | Not started |

## Execution Order

1. **P1.2 Normalization & Enrichment**
2. **P1.3 Scoring Engine**
3. **P1.4 Trend History Engine**
4. **P1.5 Product Lifecycle**
5. **P1.6 Profit Engine**
6. **P1.8 Amazon Scraper**
7. **P1.9 AliExpress Production Scraper**
8. **P1.10 Competition / Opportunity Score**
9. **P2 product sources**, continuing with other platforms; TikTok remains optional/non-blocking for SA.
10. **P3 → P4 → P5 → P6 → P7 → P8** in sequence as the intelligence foundation becomes available.

## Rules

- Do not redo P0 audits unless a concrete regression requires it.
- Do not rewrite the existing TikTok scraper or Browser Run fallback.
- Do not use Apify or third-party scraping services for the TikTok path.
- Do not modify Supabase secrets/configuration as part of roadmap feature work unless explicitly required and authorized.
- TikTok Shop Saudi Arabia availability is an external/platform constraint and must never block the core roadmap.
