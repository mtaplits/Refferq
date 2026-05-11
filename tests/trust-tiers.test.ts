import { describe, expect, it } from 'vitest';
import {
    TIER_THRESHOLDS,
    clampScore,
    effectiveHoldDays,
    multipliersFor,
    nextTierThreshold,
    tierForScore,
} from '@/lib/trust/tiers';

const baseSettings = {
    trustEnabled: true,
    trustNewHoldPctOff: 0,
    trustBuildingHoldPctOff: 0,
    trustTrustedHoldPctOff: 75,
    trustEliteHoldPctOff: 100,
    trustNewCommissionBoost: 0,
    trustBuildingCommissionBoost: 0,
    trustTrustedCommissionBoost: 2,
    trustEliteCommissionBoost: 5,
};

describe('trust tiers (Feature E)', () => {
    it('clamps scores to [0, 1000]', () => {
        expect(clampScore(-50)).toBe(0);
        expect(clampScore(0)).toBe(0);
        expect(clampScore(2000)).toBe(1000);
        expect(clampScore(NaN)).toBe(0);
        expect(clampScore(Infinity)).toBe(1000);
    });

    it('maps scores to the right tier', () => {
        expect(tierForScore(0)).toBe('NEW');
        expect(tierForScore(199)).toBe('NEW');
        expect(tierForScore(200)).toBe('BUILDING');
        expect(tierForScore(499)).toBe('BUILDING');
        expect(tierForScore(500)).toBe('TRUSTED');
        expect(tierForScore(799)).toBe('TRUSTED');
        expect(tierForScore(800)).toBe('ELITE');
        expect(tierForScore(1000)).toBe('ELITE');
    });

    it('tier ranges are contiguous and non-overlapping', () => {
        expect(TIER_THRESHOLDS.NEW[0]).toBe(0);
        expect(TIER_THRESHOLDS.NEW[1] + 1).toBe(TIER_THRESHOLDS.BUILDING[0]);
        expect(TIER_THRESHOLDS.BUILDING[1] + 1).toBe(TIER_THRESHOLDS.TRUSTED[0]);
        expect(TIER_THRESHOLDS.TRUSTED[1] + 1).toBe(TIER_THRESHOLDS.ELITE[0]);
        expect(TIER_THRESHOLDS.ELITE[1]).toBe(1000);
    });

    it('returns the next tier threshold or null at the top', () => {
        expect(nextTierThreshold(0)).toBe(200);
        expect(nextTierThreshold(199)).toBe(200);
        expect(nextTierThreshold(250)).toBe(500);
        expect(nextTierThreshold(700)).toBe(800);
        expect(nextTierThreshold(900)).toBeNull();
    });

    it('multipliersFor returns the right hold/boost per tier', () => {
        expect(multipliersFor('NEW', baseSettings)).toEqual({ holdPctOff: 0, commissionBoost: 0 });
        expect(multipliersFor('TRUSTED', baseSettings)).toEqual({ holdPctOff: 75, commissionBoost: 2 });
        expect(multipliersFor('ELITE', baseSettings)).toEqual({ holdPctOff: 100, commissionBoost: 5 });
    });

    it('disables modulation when trustEnabled is false', () => {
        const disabled = { ...baseSettings, trustEnabled: false };
        expect(multipliersFor('ELITE', disabled)).toEqual({ holdPctOff: 0, commissionBoost: 0 });
        expect(multipliersFor('NEW', null)).toEqual({ holdPctOff: 0, commissionBoost: 0 });
    });

    it('effectiveHoldDays scales by tier reduction', () => {
        // NEW with 0% off keeps the full hold.
        expect(effectiveHoldDays(30, 'NEW', baseSettings)).toBe(30);
        // TRUSTED with 75% off cuts hold to 25%.
        expect(effectiveHoldDays(30, 'TRUSTED', baseSettings)).toBe(7.5);
        // ELITE with 100% off drops to zero (instant maturation).
        expect(effectiveHoldDays(30, 'ELITE', baseSettings)).toBe(0);
        // Clamps pctOff to [0, 100] defensively.
        const wonky = { ...baseSettings, trustEliteHoldPctOff: 200 };
        expect(effectiveHoldDays(30, 'ELITE', wonky)).toBe(0);
        const negative = { ...baseSettings, trustNewHoldPctOff: -10 };
        expect(effectiveHoldDays(30, 'NEW', negative)).toBe(30);
    });
});
