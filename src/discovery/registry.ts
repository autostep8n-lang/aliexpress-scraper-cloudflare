import { aliexpressDiscovery } from "./aliexpress";
import { tiktokDiscovery } from "./tiktok";
import type { DiscoveryModule, DiscoveryPlatform } from "./types";

/**
 * Registry of available discovery modules. TikTok Shop remains the default
 * scheduled/API platform; AliExpress Dropshipping is an additional provider.
 */
export const discoveryRegistry: DiscoveryModule[] = [tiktokDiscovery, aliexpressDiscovery];

export function registerDiscovery(module: DiscoveryModule): void {
  discoveryRegistry.push(module);
}

/** Returns the discovery module registered for the given platform, if any. */
export function findDiscovery(platform: DiscoveryPlatform): DiscoveryModule | undefined {
  return discoveryRegistry.find((module) => module.platform === platform);
}
