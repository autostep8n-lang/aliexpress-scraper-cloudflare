import { googleTrendsModule } from "./google-trends";
import { redditModule } from "./reddit";
import { youtubeModule } from "./youtube";
import type { MarketIntelligenceModule } from "./types";

/**
 * Registry of available market-intelligence modules. Add new sources by
 * implementing `MarketIntelligenceModule` and registering them here, e.g.:
 *
 *   import { someMarketModule } from "./some-market";
 *   marketRegistry.push(someMarketModule);
 */
export const marketRegistry: MarketIntelligenceModule<unknown, unknown>[] = [
  googleTrendsModule,
  redditModule,
  youtubeModule,
];

export function registerMarketIntelligence(module: MarketIntelligenceModule<unknown, unknown>): void {
  marketRegistry.push(module);
}

/** Returns the market-intelligence module registered for the given source. */
export function findMarketIntelligence(
  source: string,
): MarketIntelligenceModule<unknown, unknown> | undefined {
  return marketRegistry.find((module) => module.source === source);
}
