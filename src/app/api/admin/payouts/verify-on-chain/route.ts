import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { verifyOnChain, type VerifyResult } from '@/lib/payouts/on-chain-verifier';

/**
 * Background cron that confirms each completed crypto payout against the
 * chain. NowPayments tells us a payout is FINISHED and gives us a tx hash;
 * this job independently checks that the tx exists, the recipient matches
 * the affiliate's wallet, and the amount transferred is at least what we
 * intended. The verification result is stored on the Payout (`onChainVerified`,
 * `onChainCheckReason`, `onChainVerifiedAt`) and surfaced to the affiliate as
 * a "verified on-chain" badge.
 *
 * Auth: x-cron-secret matching CRON_SECRET, or an admin user.
 * Designed to run every few minutes; idempotent.
 */

const BATCH_LIMIT = 100;

async function isAuthorized(request: NextRequest): Promise<boolean> {
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret && cronSecret === process.env.CRON_SECRET) return true;
    const userId = request.headers.get('x-user-id');
    if (!userId) return false;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return !!user && user.role === 'ADMIN' && user.status === 'ACTIVE';
}

function getWalletAddress(payoutDetails: unknown): string | null {
    if (!payoutDetails || typeof payoutDetails !== 'object') return null;
    const wa = (payoutDetails as Record<string, unknown>).walletAddress;
    return typeof wa === 'string' && wa.length > 0 ? wa : null;
}

function persistDataFor(result: VerifyResult): {
    onChainVerified: boolean | null;
    onChainVerifiedAt: Date | null;
    onChainCheckReason: string | null;
} {
    const now = new Date();
    if (result.verified) {
        return { onChainVerified: true, onChainVerifiedAt: now, onChainCheckReason: null };
    }
    // Network or verifier outages: leave the verified flag null so the next
    // cron run retries. Persist the reason for visibility.
    if (result.reason === 'verifier_unavailable') {
        return { onChainVerified: null, onChainVerifiedAt: null, onChainCheckReason: 'verifier_unavailable' };
    }
    // Anything else is a definitive negative result (mismatch, wrong contract,
    // tx not found, etc.) — record it so ops can investigate.
    return {
        onChainVerified: false,
        onChainVerifiedAt: now,
        onChainCheckReason: result.reason ?? 'unknown_failure',
    };
}

export async function POST(request: NextRequest) {
    if (!(await isAuthorized(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const network = (process.env.NOWPAYMENTS_USDT_NETWORK || 'usdttrc20').toLowerCase();

    const candidates = await prisma.payout.findMany({
        where: {
            status: 'COMPLETED',
            txHash: { not: null },
            onChainVerified: null,
        },
        include: { affiliate: true },
        take: BATCH_LIMIT,
        orderBy: { processedAt: 'asc' },
    });

    if (candidates.length === 0) {
        return NextResponse.json({ success: true, checked: 0, verified: 0, mismatched: 0, skipped: 0, deferred: 0 });
    }

    let verifiedCount = 0;
    let mismatchedCount = 0;
    let skippedCount = 0;
    let deferredCount = 0;
    const summary: { id: string; verified: boolean | null; reason: string | null }[] = [];

    for (const payout of candidates) {
        const txHash = payout.txHash as string;
        const expectedAddress = getWalletAddress(payout.affiliate.payoutDetails);
        if (!expectedAddress) {
            await prisma.payout.update({
                where: { id: payout.id },
                data: {
                    onChainVerified: false,
                    onChainVerifiedAt: new Date(),
                    onChainCheckReason: 'no_recipient_address',
                },
            });
            skippedCount += 1;
            summary.push({ id: payout.id, verified: false, reason: 'no_recipient_address' });
            continue;
        }

        let result: VerifyResult;
        try {
            result = await verifyOnChain({
                txHash,
                expectedAddress,
                expectedAmountCents: payout.amountCents,
                network,
            });
        } catch (err) {
            // verifyOnChain isn't supposed to throw, but if it ever does, treat
            // it as a transient failure so the next run retries.
            console.error('verifyOnChain threw for payout', payout.id, err);
            result = { verified: false, reason: 'verifier_unavailable' };
        }

        const persist = persistDataFor(result);
        await prisma.payout.update({
            where: { id: payout.id },
            data: persist,
        });

        if (persist.onChainVerified === true) {
            verifiedCount += 1;
        } else if (persist.onChainVerified === false) {
            mismatchedCount += 1;
            // Mismatches are real money problems — log loudly so ops sees it.
            console.error('on-chain verification mismatch', {
                payoutId: payout.id,
                txHash,
                expectedAddress,
                expectedAmountCents: payout.amountCents,
                reason: result.reason,
                observedAmountCents: result.observedAmountCents,
                observedRecipient: result.observedRecipient,
            });
            await logAuditAction({
                actorId: 'system-cron-verify-on-chain',
                action: 'PAYOUT_VERIFICATION_MISMATCH',
                objectType: 'PAYOUT',
                objectId: payout.id,
                payload: {
                    txHash,
                    reason: result.reason,
                    observedAmountCents: result.observedAmountCents,
                    observedRecipient: result.observedRecipient,
                },
            });
        } else {
            deferredCount += 1;
        }

        summary.push({
            id: payout.id,
            verified: persist.onChainVerified,
            reason: persist.onChainCheckReason,
        });
    }

    return NextResponse.json({
        success: true,
        checked: candidates.length,
        verified: verifiedCount,
        mismatched: mismatchedCount,
        skipped: skippedCount,
        deferred: deferredCount,
        summary,
    });
}
