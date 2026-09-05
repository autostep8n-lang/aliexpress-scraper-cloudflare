import type { Env } from "../env";
import { findMarketIntelligence } from "../market/registry";
import { MarketError, type GoogleTrendsSignal, type MarketCollectResult } from "../market/types";
import { upsertCountryOpportunityScores } from "../supabase/repository";
import {
  analyzeCountryIntelligence,
  normalizeKeyword,
  scoreCountryOpportunity,
  toCountryOpportunityRow,
} from "./engine";
import { CountryError } from "./types";

export const MVP_COUNTRY = "SA" as const;

export type CountryOpportunityPipelineStatus = "written" | "skipped" | "failed";

export type CountryOpportunityPipelineResult = {
  status: CountryOpportunityPipelineStatus;
  code?: string;
  country?: typeof MVP_COUNTRY;
  keyword?: string;
};

export async function scoreAndPersistMvpCountryOpportunity(
  env: Env,
  ctx: ExecutionContext,
  input: { productId: string; title: string },
): Promise<CountryOpportunityPipelineResult> {
  let keyword: string;
  try {
    keyword = normalizeKeyword(input.title);
  } catch (err) {
    if (err instanceof CountryError && err.code === "INVALID_KEYWORD") {
      return { status: "skipped", code: "INVALID_KEYWORD" };
    }
    return failedFrom(err);
  }

  try {
    const module = findMarketIntelligence("google-trends");
    if (!module) {
      return { status: "failed", code: "NO_MARKET_SOURCE", country: MVP_COUNTRY, keyword };
    }

    let collected: MarketCollectResult;
    try {
      collected = (await module.collect({ keyword, geo: MVP_COUNTRY }, env, ctx)) as MarketCollectResult;
    } catch (err) {
      if (err instanceof MarketError) {
        return { status: "failed", code: err.code, country: MVP_COUNTRY, keyword };
      }
      return failedFrom(err, keyword);
    }

    const trends = Array.isArray(collected.signals) ? (collected.signals as GoogleTrendsSignal[]) : [];
    const countryIntelligence = analyzeCountryIntelligence({
      query: { keyword, country: MVP_COUNTRY },
      trends,
    });
    const scored = scoreCountryOpportunity({
      productId: input.productId,
      country: MVP_COUNTRY,
      keyword,
      countryIntelligence,
    });

    if (scored.tier === "unknown" || scored.score.totalWeight === 0) {
      return { status: "skipped", code: "UNKNOWN_OR_ZERO_WEIGHT", country: MVP_COUNTRY, keyword };
    }

    const persisted = await upsertCountryOpportunityScores(env, [toCountryOpportunityRow(scored)]);
    if (persisted.status === "created" || persisted.status === "updated") {
      return { status: "written", country: MVP_COUNTRY, keyword };
    }
    if (persisted.status === "credentials_missing") {
      return { status: "failed", code: "SUPABASE_NOT_CONFIGURED", country: MVP_COUNTRY, keyword };
    }
    if (persisted.status === "error") {
      return {
        status: "failed",
        code: persisted.code ?? "country_opportunity_upsert_failed",
        country: MVP_COUNTRY,
        keyword,
      };
    }
    return { status: "failed", code: "country_opportunity_upsert_failed", country: MVP_COUNTRY, keyword };
  } catch (err) {
    return failedFrom(err, keyword);
  }
}

function failedFrom(err: unknown, keyword?: string): CountryOpportunityPipelineResult {
  const code = err instanceof MarketError || err instanceof CountryError ? err.code : "PIPELINE_ERROR";
  if (keyword) {
    return { status: "failed", code, country: MVP_COUNTRY, keyword };
  }
  return { status: "failed", code };
}
