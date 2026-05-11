import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { computeTrustScore } from '@/lib/trust/compute';
import { attestTrustScore, isAttestationEnabled } from '@/lib/trust/attest';

/**
 * Trust score recompute endpoint.
 *
 * POST /api/admin/trust/recompute            — recompute all affiliates
 * POST /api/admin/trust/recompute?affiliateId=... — recompute one
 *
 * Auth: x-cron-secret matching CRON_SECRET, or an admin user. Designed for
 * a nightly cron. Per-affiliate variant is also called inline from the
 * mature commissions cron so a fresh approval can promote tier immediately.
 */

async function isAuthorized(request: NextRequest): Promise<boolean> {
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret && cronSecret === process.env.CRON_SECRET) return true;
    const userId = request.headers.get('x-user-id');
    if (!userId) return false;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return !!user && user.role === 'ADMIN' && user.status === 'ACTIVE';
}

async function recomputeOne(affiliateId: string, options: { attestIfCrypto: boolean; treasuryType: 'FIAT' | 'CRYPTO'; programId: string; trustEnabled: boolean }) {
    const { score, tier, inputs } = await computeTrustScore(affiliateId);
    const now = new Date();

    let attestationUid: string | null = null;
    let attestationSig: string | null = null;
    if (
        options.attestIfCrypto &&
        options.treasuryType === 'CRYPTO' &&
        options.trustEnabled &&
        isAttestationEnabled()
    ) {
        try {
            const att = await attestTrustScore({
                affiliateId,
                score,
                tier,
                programId: options.programId,
            });
            attestationUid = att?.uid ?? null;
            attestationSig = att?.signature ?? null;
        } catch (err) {
            console.error('Trust attestation failed for', affiliateId, err);
        }
    }

    await prisma.trustScore.upsert({
        where: { affiliateId },
        create: {
            affiliateId,
            score,
            tier,
            inputs: inputs as object,
            attestationUid,
            attestationSig,
            lastComputedAt: now,
        },
        update: {
            score,
            tier,
            inputs: inputs as object,
            attestationUid: attestationUid ?? undefined,
            attestationSig: attestationSig ?? undefined,
            lastComputedAt: now,
        },
    });

    return { affiliateId, score, tier, attested: !!attestationUid };
}

export async function POST(request: NextRequest) {
    if (!(await isAuthorized(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const affiliateIdParam = url.searchParams.get('affiliateId');

    const settings = await prisma.programSettings.findFirst();
    const treasuryType = (settings?.treasuryType ?? 'FIAT') as 'FIAT' | 'CRYPTO';
    const trustEnabled = settings?.trustEnabled ?? true;
    const programId = settings?.programId ?? 'default';

    // Per-affiliate variant
    if (affiliateIdParam) {
        const exists = await prisma.affiliate.findUnique({
            where: { id: affiliateIdParam },
            select: { id: true },
        });
        if (!exists) {
            return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });
        }
        const result = await recomputeOne(affiliateIdParam, {
            attestIfCrypto: true,
            treasuryType,
            programId,
            trustEnabled,
        });
        return NextResponse.json({ success: true, result });
    }

    // Batch variant: every affiliate with a TrustScore row OR an approved/paid commission.
    const candidates = await prisma.affiliate.findMany({
        where: {
            OR: [
                { trustScore: { isNot: null } },
                { commissions: { some: { status: { in: ['APPROVED', 'PAID'] } } } },
            ],
        },
        select: { id: true },
    });

    const results = [];
    for (const c of candidates) {
        try {
            results.push(
                await recomputeOne(c.id, {
                    attestIfCrypto: true,
                    treasuryType,
                    programId,
                    trustEnabled,
                })
            );
        } catch (err) {
            console.error('Trust recompute failed for', c.id, err);
        }
    }

    await logAuditAction({
        actorId: 'system-cron',
        action: 'TRUST_RECOMPUTE',
        objectType: 'TRUST_SCORE',
        objectId: 'batch',
        payload: { count: results.length },
    });

    return NextResponse.json({ success: true, count: results.length, results });
}
