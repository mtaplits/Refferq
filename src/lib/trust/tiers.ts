import { TrustTier } from '@prisma/client';

export const TIER_THRESHOLDS: Record<TrustTier, [number, number]> = {
    NEW: [0, 199],
    BUILDING: [200, 499],
    TRUSTED: [500, 799],
    ELITE: [800, 1000],
};

export const SCORE_MIN = 0;
export const SCORE_MAX = 1000;

export function clampScore(score: number): number {
    // NaN → 0 (defensive default). ±Infinity flow through Math.max/Math.min
    // and clamp to [SCORE_MIN, SCORE_MAX] naturally.
    if (Number.isNaN(score)) return SCORE_MIN;
    return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)));
}

export function tierForScore(score: number): TrustTier {
    const s = clampScore(score);
    if (s >= TIER_THRESHOLDS.ELITE[0]) return 'ELITE';
    if (s >= TIER_THRESHOLDS.TRUSTED[0]) return 'TRUSTED';
    if (s >= TIER_THRESHOLDS.BUILDING[0]) return 'BUILDING';
    return 'NEW';
}

// Hold-period reduction (% off the default holdDays) by tier, read from ProgramSettings.
export interface TrustMultipliers {
    holdPctOff: number;       // 0-100
    commissionBoost: number;  // additive percentage points (e.g. 5 = +5%)
}

interface TrustSettings {
    trustEnabled: boolean;
    trustNewHoldPctOff: number;
    trustBuildingHoldPctOff: number;
    trustTrustedHoldPctOff: number;
    trustEliteHoldPctOff: number;
    trustNewCommissionBoost: number;
    trustBuildingCommissionBoost: number;
    trustTrustedCommissionBoost: number;
    trustEliteCommissionBoost: number;
}

export function multipliersFor(tier: TrustTier, settings: TrustSettings | null | undefined): TrustMultipliers {
    if (!settings || !settings.trustEnabled) {
        return { holdPctOff: 0, commissionBoost: 0 };
    }
    switch (tier) {
        case 'ELITE':
            return {
                holdPctOff: settings.trustEliteHoldPctOff,
                commissionBoost: settings.trustEliteCommissionBoost,
            };
        case 'TRUSTED':
            return {
                holdPctOff: settings.trustTrustedHoldPctOff,
                commissionBoost: settings.trustTrustedCommissionBoost,
            };
        case 'BUILDING':
            return {
                holdPctOff: settings.trustBuildingHoldPctOff,
                commissionBoost: settings.trustBuildingCommissionBoost,
            };
        case 'NEW':
        default:
            return {
                holdPctOff: settings.trustNewHoldPctOff,
                commissionBoost: settings.trustNewCommissionBoost,
            };
    }
}

/**
 * Return the effective hold (in days) for an affiliate at the given tier,
 * given the program's default `commissionHoldDays`. Always returns a
 * non-negative number; an ELITE affiliate with 100% off returns 0.
 */
export function effectiveHoldDays(
    holdDays: number,
    tier: TrustTier,
    settings: TrustSettings | null | undefined
): number {
    const { holdPctOff } = multipliersFor(tier, settings);
    const pct = Math.max(0, Math.min(100, holdPctOff));
    return Math.max(0, holdDays * (1 - pct / 100));
}

/**
 * What score does the affiliate need to reach the next tier? Returns
 * `null` if already at the top tier.
 */
export function nextTierThreshold(score: number): number | null {
    const s = clampScore(score);
    if (s < TIER_THRESHOLDS.BUILDING[0]) return TIER_THRESHOLDS.BUILDING[0];
    if (s < TIER_THRESHOLDS.TRUSTED[0]) return TIER_THRESHOLDS.TRUSTED[0];
    if (s < TIER_THRESHOLDS.ELITE[0]) return TIER_THRESHOLDS.ELITE[0];
    return null;
}
