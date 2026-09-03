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
- **Next task: P4 — Country Intelligence Engine**

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
| 22 | Country Intelligence Engine | TODO | Target markets include SA / US / UK / EU and others |
| 23 | Country Opportunity Scoring | TODO | Product × Country |

## P5 — Decision Engine

| # | Feature | Status | Notes |
|---|---|---|---|
| 24 | Opportunity Score | TODO | Aggregate product and market signals |
| 25 | AI Product Analyst | TODO | Explain score, evidence and decision |

## P6 — Dashboard

| # | Feature | Status | Notes |
|---|---|---|---|
| 26 | Product Discovery Dashboard | TODO | Build after intelligence data is available |
| 27 | Top Opportunities | TODO | Rankings |
| 28 | Product Detail / Analysis | TODO | Explain the why behind the opportunity |

## P7 — Automation

| # | Feature | Status | Notes |
|---|---|---|---|
| 29 | Daily Product Discovery | TODO | Not started |
| 30 | Automated Scoring Pipeline | TODO | Not started |
| 31 | Alerts | TODO | Not started |
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
