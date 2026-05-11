import { prisma } from '@/lib/prisma';
import { TrustTier } from '@prisma/client';
import { clampScore, tierForScore } from './tiers';

export interface TrustComputeInputs {
    approvedReferralsCount: number;
    refundFreeStreak: number;
    totalApprovedCentsUsd: number;
    downlineDepthCount: number;
    accountAgeDays: number;
    recentRefundRate: number;          // 0-1 over last 50 conversions
    fraudFlagged: boolean;
    failedPayoutCount: number;
}

export interface TrustComputeResult {
    score: number;
    tier: TrustTier;
    inputs: TrustComputeInputs;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function logScale(value: number, perDoubling: number, cap: number): number {
    if (value <= 0) return 0;
    // log2(value+1) so we don't infinite-add for value=1; +1 keeps the first
    // unit worth ~perDoubling without overshooting.
    const pts = Math.log2(value + 1) * perDoubling;
    return Math.min(cap, Math.max(0, pts));
}

export async function gatherInputs(affiliateId: string): Promise<TrustComputeInputs> {
    const [affiliate, approvedCount, allCommissions, downlineCount, recentConversions, failedPayouts] =
        await Promise.all([
            prisma.affiliate.findUnique({
                where: { id: affiliateId },
                select: { id: true, createdAt: true },
            }),
            prisma.commission.count({
                where: { affiliateId, status: { in: ['APPROVED', 'PAID'] } },
            }),
            prisma.commission.findMany({
                where: { affiliateId, status: { in: ['APPROVED', 'PAID'] } },
                select: { amountCents: true, status: true, createdAt: true },
                orderBy: { createdAt: 'asc' },
            }),
            prisma.affiliate.count({ where: { referredById: affiliateId } }),
            prisma.conversion.findMany({
                where: { affiliateId },
                select: { status: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
                take: 50,
            }),
            prisma.payout.count({
                where: { affiliateId, txStatus: 'failed' },
            }),
        ]);

    const totalApprovedCentsUsd = allCommissions.reduce((acc, c) => acc + c.amountCents, 0);

    // Refund-free streak = number of most-recent conversions in a row that are NOT REJECTED.
    let refundFreeStreak = 0;
    for (const c of recentConversions) {
        if (c.status === 'REJECTED') break;
        refundFreeStreak++;
    }

    const refundCount = recentConversions.filter((c) => c.status === 'REJECTED').length;
    const recentRefundRate = recentConversions.length > 0 ? refundCount / recentConversions.length : 0;

    const accountAgeDays = affiliate
        ? Math.max(0, (Date.now() - affiliate.createdAt.getTime()) / DAY_MS)
        : 0;

    // For fraud signal: existing fraud-detection module reads from various
    // sources. We don't have a single boolean column yet, so v1 treats this
    // as false. The /api/admin/trust/recompute endpoint can be extended to
    // accept an override map from a future fraud-detection sweep.
    const fraudFlagged = false;

    return {
        approvedReferralsCount: approvedCount,
        refundFreeStreak,
        totalApprovedCentsUsd,
        downlineDepthCount: downlineCount,
        accountAgeDays,
        recentRefundRate,
        fraudFlagged,
        failedPayoutCount: failedPayouts,
    };
}

export function scoreFromInputs(inputs: TrustComputeInputs): { score: number; tier: TrustTier } {
    let pts = 0;

    // Positive signals
    pts += logScale(inputs.approvedReferralsCount, 30, 400);
    pts += Math.min(200, inputs.refundFreeStreak * 5);
    pts += logScale(inputs.totalApprovedCentsUsd / 100, 20, 200);
    pts += Math.min(100, inputs.downlineDepthCount * 5);
    pts += Math.min(100, inputs.accountAgeDays * 0.1);

    // Penalties
    if (inputs.recentRefundRate > 0.1) pts -= 200;
    if (inputs.fraudFlagged) pts -= 500;
    pts -= Math.min(200, inputs.failedPayoutCount * 50);

    const score = clampScore(pts);
    return { score, tier: tierForScore(score) };
}

export async function computeTrustScore(affiliateId: string): Promise<TrustComputeResult> {
    const inputs = await gatherInputs(affiliateId);
    const { score, tier } = scoreFromInputs(inputs);
    return { score, tier, inputs };
}

/**
 * Look up an affiliate's current tier in O(1), defaulting to NEW when no
 * TrustScore row exists. Hot path — used at commission-create time.
 */
export async function tierOf(affiliateId: string): Promise<TrustTier> {
    const row = await prisma.trustScore.findUnique({
        where: { affiliateId },
        select: { tier: true },
    });
    return row?.tier ?? 'NEW';
}
