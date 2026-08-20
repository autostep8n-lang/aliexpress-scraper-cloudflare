import { tiktokDiscovery } from "./tiktok";
import type { DiscoveryModule, DiscoveryPlatform } from "./types";

/**
 * Registry of available discovery modules. Add new platforms by implementing
 * `DiscoveryModule` and registering them here, e.g.:
 *
 *   import { aliexpressDiscovery } from "./aliexpress";
 *   discoveryRegistry.push(aliexpressDiscovery);
 */
export const discoveryRegistry: DiscoveryModule[] = [tiktokDiscovery];

export function registerDiscovery(module: DiscoveryModule): void {
  discoveryRegistry.push(module);
}

/** Returns the discovery module registered for the given platform, if any. */
export function findDiscovery(platform: DiscoveryPlatform): DiscoveryModule | undefined {
  return discoveryRegistry.find((module) => module.platform === platform);
}
