import type { V1Country } from "../country/types";
import type { LifecycleStatus } from "../lifecycle/types";
import type { OpportunityTier } from "../opportunity/types";

export const DEFAULT_PRODUCT_LIST_LIMIT = 20;
export const MAX_PRODUCT_LIST_LIMIT = 50;

export interface ProductListQuery {
  limit: number;
  offset: number;
  lifecycle?: LifecycleStatus;
  q?: string;
}

export interface DiscoveryDecision {
  score: {
    scoreType: string;
    version: number;
    value: number;
    normalized: number;
    tier: OpportunityTier;
  };
  selectedCountry: V1Country | null;
  summary: string;
  caveats: string[];
  provider: "template";
}

export interface DiscoveryProduct {
  id: string;
  title: string;
  brand: string | null;
  primaryImageUrl: string | null;
  canonicalUrl: string | null;
  availabilityStatus: string;
  lifecycleStatus: string;
  lastSeenAt: string;
  decision: DiscoveryDecision;
}

export interface DiscoveryPage {
  status: "ok";
  products: DiscoveryProduct[];
  page: {
    limit: number;
    offset: number;
    total: number;
  };
}
