import type { ScraperModule } from "./types";

/**
 * Registry of available scraper modules. Add new scrapers by implementing
 * `ScraperModule` and registering them here, e.g.:
 *
 *   import { aliexpressScraper } from "./aliexpress";
 *   registerScraper(aliexpressScraper);
 */
export const scraperRegistry: ScraperModule[] = [];

export function registerScraper(module: ScraperModule): void {
  scraperRegistry.push(module);
}

/** Returns the first enabled scraper that claims to support the URL. */
export function findScraper(url: URL): ScraperModule | undefined {
  return scraperRegistry.find((module) => module.enabled && module.supports(url));
}
