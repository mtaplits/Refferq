import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { evaluateCredits } from '@/lib/credits/evaluate';
import { computeTrustScore } from '@/lib/trust/compute';

/**
 * POST /api/admin/commissions/mature
 * 
 * Cron/admin endpoint that matures all PENDING commissions whose hold period
 * has expired. Moves them to APPROVED and credits the affiliate balance.
 * 
 * Can be called by:
 * - A cron job (e.g. Vercel Cron, Railway Cron)
 * - Manually by an admin from the dashboard
 */
export async function POST(request: NextRequest) {
    try {
        // Auth check — must be admin or cron secret
        const cronSecret = request.headers.get('x-cron-secret');
        const userId = request.headers.get('x-user-id');

        let isAuthorized = false;

        // Method 1: Cron secret
        if (cronSecret && cronSecret === process.env.CRON_SECRET) {
            isAuthorized = true;
        }

        // Method 2: Admin user
        if (!isAuthorized && userId) {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (user?.role === 'ADMIN' && user?.status === 'ACTIVE') {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const now = new Date();

        // Find all PENDING commissions that have matured
        const maturedCommissions = await prisma.commission.findMany({
            where: {
                status: 'PENDING',
                maturesAt: { lte: now },
            },
            include: {
                affiliate: true,
            },
        });

        if (maturedCommissions.length === 0) {
            return NextResponse.json({
                success: true,
                message: 'No commissions to mature',
                matured: 0,
            });
        }

        // Group by affiliate for batch balance updates
        const affiliateUpdates = new Map<string, number>();
        const maturedIds: string[] = [];

        for (const commission of maturedCommissions) {
            maturedIds.push(commission.id);
            const current = affiliateUpdates.get(commission.affiliateId) || 0;
            affiliateUpdates.set(commission.affiliateId, current + commission.amountCents);
        }

        // Batch update: mark all as APPROVED
        await prisma.commission.updateMany({
            where: { id: { in: maturedIds } },
            data: {
                status: 'APPROVED',
                approvedAt: now,
                approvedBy: userId || 'system-cron',
            },
        });

        // Update each affiliate's balance
        for (const [affiliateId, totalCents] of affiliateUpdates.entries()) {
            await prisma.affiliate.update({
                where: { id: affiliateId },
                data: {
                    balanceCents: { increment: totalCents },
                },
            });
        }

        // ─── Feature E: recompute trust score per affected affiliate ───
        // A fresh approved commission can promote an affiliate into a
        // higher trust tier; we recompute immediately so the next
        // conversion's hold/boost reflect the new state.
        const trustUpdates: { affiliateId: string; score: number; tier: string }[] = [];
        for (const affiliateId of affiliateUpdates.keys()) {
            try {
                const { score, tier, inputs } = await computeTrustScore(affiliateId);
                await prisma.trustScore.upsert({
                    where: { affiliateId },
                    create: {
                        affiliateId,
                        score,
                        tier,
                        inputs: inputs as object,
                        lastComputedAt: now,
                    },
                    update: {
                        score,
                        tier,
                        inputs: inputs as object,
                        lastComputedAt: now,
                    },
                });
                trustUpdates.push({ affiliateId, score, tier });
            } catch (err) {
                console.error('Trust recompute failed for affiliate', affiliateId, err);
            }
        }

        // ─── Feature C: evaluate milestone-based credit buckets ───
        const creditsIssued: { affiliateId: string; count: number }[] = [];
        for (const affiliateId of affiliateUpdates.keys()) {
            try {
                const { earned } = await evaluateCredits(affiliateId);
                if (earned.length > 0) {
                    creditsIssued.push({ affiliateId, count: earned.length });
                }
            } catch (err) {
                console.error('Credit evaluation failed for affiliate', affiliateId, err);
            }
        }

        // Log audit
        await logAuditAction({
            actorId: userId || 'system-cron',
            action: 'MATURE_COMMISSIONS',
            objectType: 'COMMISSION',
            objectId: 'batch',
            payload: {
                count: maturedIds.length,
                totalCents: Array.from(affiliateUpdates.values()).reduce((a, b) => a + b, 0),
                affiliateCount: affiliateUpdates.size,
                trustUpdates,
                creditsIssued,
            },
        });

        return NextResponse.json({
            success: true,
            message: `${maturedIds.length} commission(s) matured and approved`,
            matured: maturedIds.length,
            affiliatesUpdated: affiliateUpdates.size,
            trustUpdates,
            creditsIssued,
        });
    } catch (error) {
        console.error('Commission maturation error:', error);
        return NextResponse.json(
            { error: 'Failed to mature commissions' },
            { status: 500 }
        );
    }
}
