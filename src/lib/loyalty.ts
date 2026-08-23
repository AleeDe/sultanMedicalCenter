import type { LoyaltyTier } from "./types";

// Tier is always DERIVED from visit history, never stored as an editable
// column: a hand-set tier can be gamed and silently goes stale.
export const TIER_THRESHOLDS = { REGULAR: 3, GOLD: 8 } as const;

export function tierFor(visitCount: number): LoyaltyTier {
  if (visitCount >= TIER_THRESHOLDS.GOLD) return "GOLD";
  if (visitCount >= TIER_THRESHOLDS.REGULAR) return "REGULAR";
  return "NEW";
}

export const TIER_LABEL: Record<LoyaltyTier, string> = {
  NEW: "New patient",
  REGULAR: "Regular",
  GOLD: "Gold",
};
