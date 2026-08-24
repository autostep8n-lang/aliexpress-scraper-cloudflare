/**
 * Multi-signal matching and merge decision for one candidate pair.
 *
 * Scoring is precision-first: a candidate is only ever merged when it clears
 * hard blockers (brand/variant/model conflicts) and meets a per-regime
 * confidence threshold. Exact global identifiers (GTIN/ISBN) auto-merge;
 * weaker signals require meaningful title agreement.
 */
import { jaccardSimilarity, levenshteinSimilarity, longestCommonPrefix } from "./normalize";
import type { IdentifierInfo, ProductSignals } from "./signals";

/** Confidence above which a match is treated as a certain merge. */
export const MATCH_CONFIDENCE = 0.95;
/** Minimum overall confidence for a weak, identifier-anchored merge. */
export const MERGE_CONFIDENCE = 0.8;
/** Title similarity required to merge when the incoming product has no identifier. */
export const NO_IDENTIFIER_TITLE_SIM = 0.95;
/** Minimum title Levenshtein similarity for weak merges. */
export const TITLE_MIN_LEV_SIM = 0.6;
/** Minimum title similarity required for a parent-identifier auto-merge. */
export const PARENT_TITLE_MIN_SIM = 0.5;

export type MatchRelation = "exact" | "parent" | "substring" | "title" | "none";

export type BlockedReason = "brand_conflict" | "variant_conflict" | "model_conflict";

export interface TitleSimilarity {
  levSim: number;
  jaccard: number;
  score: number;
  firstTokenAnchored: boolean;
}

export interface MatchResult {
  relation: MatchRelation;
  confidence: number;
  score: number;
  title: TitleSimilarity;
  identifierScore: number;
  brandScore: number;
  categoryScore: number;
  blocked: BlockedReason | null;
}

/** Weighted multi-signal score for an incoming product against one candidate. */
export function matchSignals(incoming: ProductSignals, candidate: ProductSignals): MatchResult {
  const blocked = findBlocker(incoming, candidate);
  const title = computeTitleSimilarity(incoming, candidate);
  const identifierScore = identifierSimilarity(incoming.identifiers, candidate.identifiers);
  const brandScore = brandSimilarity(incoming.brand, candidate.brand);
  const categoryScore = categorySimilarity(incoming.categoryPath, candidate.categoryPath);
  const relation = identifierRelation(identifierScore);

  let score =
    0.6 * title.score + 0.1 * identifierScore + 0.15 * brandScore + 0.15 * categoryScore;
  const anchorBoost = strongAnchorConfidence(identifierScore);
  if (anchorBoost > score) score = anchorBoost;

  return {
    relation,
    confidence: score,
    score,
    title,
    identifierScore,
    brandScore,
    categoryScore,
    blocked,
  };
}

/** Whether the incoming product should merge into this candidate row. */
export function decideMerge(incoming: ProductSignals, match: MatchResult): boolean {
  if (match.blocked) return false;
  if (match.identifierScore >= 1) return true;
  if (match.identifierScore >= 0.8) {
    return match.title.score >= PARENT_TITLE_MIN_SIM && match.title.firstTokenAnchored;
  }
  if (!incoming.hasIdentifier) {
    return match.title.score > NO_IDENTIFIER_TITLE_SIM && match.title.levSim > 0.9;
  }
  return (
    match.title.levSim >= TITLE_MIN_LEV_SIM &&
    match.title.firstTokenAnchored &&
    match.score >= MERGE_CONFIDENCE
  );
}

function findBlocker(incoming: ProductSignals, candidate: ProductSignals): BlockedReason | null {
  if (incoming.brand && candidate.brand && incoming.brand !== candidate.brand) {
    return "brand_conflict";
  }
  if (variantSetsConflict(incoming.variantTokens, candidate.variantTokens)) {
    return "variant_conflict";
  }
  const incomingModel = findIdentifier(incoming.identifiers, "model");
  const candidateModel = findIdentifier(candidate.identifiers, "model");
  if (incomingModel && candidateModel && compareIdentifiers(incomingModel, candidateModel) < 0.7) {
    return "model_conflict";
  }
  return null;
}

/** Two variant profiles conflict when both are non-empty and neither is a subset of the other. */
function variantSetsConflict(a: readonly string[], b: readonly string[]): boolean {
  const aSet = new Set(a);
  const bSet = new Set(b);
  if (aSet.size === 0 || bSet.size === 0) return false;
  if (setsEqual(aSet, bSet)) return false;
  const subset =
    [...aSet].every((item) => bSet.has(item)) || [...bSet].every((item) => aSet.has(item));
  return !subset;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function findIdentifier(identifiers: readonly IdentifierInfo[], type: IdentifierInfo["type"]): IdentifierInfo | undefined {
  return identifiers.find((identifier) => identifier.type === type);
}

/**
 * Identifier agreement between one pair:
 * - exact value (GTINs compared in canonical 14-digit form) -> 1
 * - strict prefix relation with a length-4+ stem -> 0.8
 * - long shared prefix (>= 8 chars) -> 0.4
 * - otherwise -> 0
 */
function compareIdentifiers(a: IdentifierInfo, b: IdentifierInfo): number {
  if (a.type !== b.type) return 0;
  if (a.value === b.value) return 1;
  const minLength = Math.min(a.value.length, b.value.length);
  const isParent = a.value.startsWith(b.value) || b.value.startsWith(a.value);
  if (isParent && minLength >= 4) return 0.8;
  if (longestCommonPrefix(a.value, b.value) >= 8) return 0.4;
  return 0;
}

function identifierSimilarity(incoming: readonly IdentifierInfo[], candidate: readonly IdentifierInfo[]): number {
  if (incoming.length === 0 || candidate.length === 0) return 0;
  let best = 0;
  for (const a of incoming) {
    for (const b of candidate) {
      const sim = compareIdentifiers(a, b);
      if (sim > best) best = sim;
    }
  }
  return best;
}

function identifierRelation(score: number): MatchRelation {
  if (score >= 1) return "exact";
  if (score >= 0.8) return "parent";
  if (score >= 0.4) return "substring";
  return "none";
}

function strongAnchorConfidence(identifierScore: number): number {
  if (identifierScore >= 1) return 0.98;
  if (identifierScore >= 0.8) return 0.96;
  return 0;
}

function brandSimilarity(a: string | null, b: string | null): number {
  if (a && b) return a === b ? 1 : 0;
  return 0.5;
}

function categorySimilarity(a: readonly string[], b: readonly string[]): number {
  const aTop = a[0];
  const bTop = b[0];
  if (aTop && bTop) return aTop === bTop ? 1 : 0;
  return 0.5;
}

function computeTitleSimilarity(incoming: ProductSignals, candidate: ProductSignals): TitleSimilarity {
  const joinedA = incoming.titleTokens.join("");
  const joinedB = candidate.titleTokens.join("");
  const levSim = levenshteinSimilarity(joinedA, joinedB);
  const jaccard = jaccardSimilarity(new Set(incoming.titleTokens), new Set(candidate.titleTokens));
  const score = 0.7 * levSim + 0.3 * jaccard;
  return { levSim, jaccard, score, firstTokenAnchored: firstTokenAnchored(incoming.titleTokens, candidate.titleTokens) };
}

function firstTokenAnchored(a: readonly string[], b: readonly string[]): boolean {
  const firstA = a.find((token) => token.length >= 2);
  const firstB = b.find((token) => token.length >= 2);
  if (!firstA || !firstB) return false;
  return longestCommonPrefix(firstA, firstB) >= 2;
}
