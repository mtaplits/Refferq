import { describe, expect, it } from 'vitest';
import { scoreFromInputs, type TrustComputeInputs } from '@/lib/trust/compute';

function inputs(overrides: Partial<TrustComputeInputs> = {}): TrustComputeInputs {
    return {
        approvedReferralsCount: 0,
        refundFreeStreak: 0,
        totalApprovedCentsUsd: 0,
        downlineDepthCount: 0,
        accountAgeDays: 0,
        recentRefundRate: 0,
        fraudFlagged: false,
        failedPayoutCount: 0,
        ...overrides,
    };
}

describe('scoreFromInputs (Feature E)', () => {
    it('a brand-new affiliate scores 0 / NEW', () => {
        const { score, tier } = scoreFromInputs(inputs());
        expect(score).toBe(0);
        expect(tier).toBe('NEW');
    });

    it('approved referrals push the score up logarithmically', () => {
        const a = scoreFromInputs(inputs({ approvedReferralsCount: 1 }));
        const b = scoreFromInputs(inputs({ approvedReferralsCount: 10 }));
        const c = scoreFromInputs(inputs({ approvedReferralsCount: 100 }));
        // Strictly increasing.
        expect(a.score).toBeGreaterThan(0);
        expect(b.score).toBeGreaterThan(a.score);
        expect(c.score).toBeGreaterThan(b.score);
        // But sub-linear: doubling never doubles the score.
        expect(c.score).toBeLessThan(2 * b.score);
    });

    it('a heavy positive signal stack can promote to TRUSTED or higher', () => {
        const { score, tier } = scoreFromInputs(
            inputs({
                approvedReferralsCount: 1000,        // huge: hits cap of 400
                refundFreeStreak: 40,                 // 40 * 5 = 200 (cap)
                totalApprovedCentsUsd: 100_000_00,    // $100k → log cap of 200
                downlineDepthCount: 20,               // 20 * 5 = 100 (cap)
                accountAgeDays: 1000,                 // 1000 * 0.1 = 100 (cap)
            })
        );
        expect(score).toBeGreaterThanOrEqual(500);
        expect(['TRUSTED', 'ELITE']).toContain(tier);
    });

    it('fraud flag drops score and tier', () => {
        const clean = scoreFromInputs(
            inputs({
                approvedReferralsCount: 100,
                refundFreeStreak: 30,
                totalApprovedCentsUsd: 50_000_00,
            })
        );
        const fraudy = scoreFromInputs(
            inputs({
                approvedReferralsCount: 100,
                refundFreeStreak: 30,
                totalApprovedCentsUsd: 50_000_00,
                fraudFlagged: true,
            })
        );
        // -500 fraud penalty should drop the score substantially.
        expect(fraudy.score).toBeLessThan(clean.score);
    });

    it('high refund rate triggers a penalty', () => {
        const ok = scoreFromInputs(
            inputs({ approvedReferralsCount: 50, recentRefundRate: 0.05 })
        );
        const bad = scoreFromInputs(
            inputs({ approvedReferralsCount: 50, recentRefundRate: 0.5 })
        );
        expect(bad.score).toBeLessThan(ok.score);
    });

    it('failed payouts hurt the score and are capped at -200 total', () => {
        // Headroom: 1000 approved referrals scores well above the penalty cap.
        const baseline = inputs({ approvedReferralsCount: 1000 });
        const noFails = scoreFromInputs(baseline);
        const oneFail = scoreFromInputs({ ...baseline, failedPayoutCount: 1 });
        const manyFails = scoreFromInputs({ ...baseline, failedPayoutCount: 100 });

        // One failed payout is strictly worse than none.
        expect(oneFail.score).toBeLessThan(noFails.score);
        // 100 failed payouts is at the -200 cap, strictly worse than 1.
        expect(manyFails.score).toBeLessThan(oneFail.score);
        // The gap between best and worst is bounded by the cap.
        expect(noFails.score - manyFails.score).toBeLessThanOrEqual(200);
    });

    it('score is always clamped to [0, 1000]', () => {
        const maxedOut = scoreFromInputs(
            inputs({
                approvedReferralsCount: 1_000_000,
                refundFreeStreak: 10_000,
                totalApprovedCentsUsd: 1_000_000_00_00,
                downlineDepthCount: 1000,
                accountAgeDays: 100_000,
            })
        );
        expect(maxedOut.score).toBeLessThanOrEqual(1000);
        expect(maxedOut.score).toBeGreaterThanOrEqual(0);

        const minOut = scoreFromInputs(
            inputs({ fraudFlagged: true, recentRefundRate: 1, failedPayoutCount: 50 })
        );
        expect(minOut.score).toBeGreaterThanOrEqual(0);
        expect(minOut.tier).toBe('NEW');
    });
});
