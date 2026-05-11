import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { getProvider } from '@/lib/crypto-disbursement';

/**
 * Fallback reconcile cron for crypto payouts.
 *
 * Callbacks from the crypto provider (SHKeeper) normally drive
 * /api/webhook/payout-status, but networks or providers can drop them.
 * This endpoint queries each payout that's been stuck in queued/broadcast
 * state for > MIN_AGE_MINUTES and asks the provider for the current status.
 *
 * Auth: x-cron-secret matching CRON_SECRET, or an admin user.
 * Designed to run hourly.
 */

const MIN_AGE_MINUTES = 60;
const BATCH_LIMIT = 100;

async function isAuthorized(request: NextRequest): Promise<boolean> {
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret && cronSecret === process.env.CRON_SECRET) return true;
    const userId = request.headers.get('x-user-id');
    if (!userId) return false;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    return !!user && user.role === 'ADMIN' && user.status === 'ACTIVE';
}

export async function POST(request: NextRequest) {
    if (!(await isAuthorized(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const cutoff = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
    const stalePayouts = await prisma.payout.findMany({
        where: {
            txStatus: { in: ['queued', 'broadcast'] },
            updatedAt: { lt: cutoff },
            providerTaskId: { not: null },
        },
        take: BATCH_LIMIT,
    });

    if (stalePayouts.length === 0) {
        return NextResponse.json({ success: true, reconciled: 0 });
    }

    const provider = getProvider();
    const now = new Date();
    const summary: { id: string; from: string | null; to: string }[] = [];

    for (const payout of stalePayouts) {
        try {
            const status = await provider.getStatus(payout.providerTaskId as string);
            if (status === 'confirmed') {
                await prisma.payout.update({
                    where: { id: payout.id },
                    data: {
                        status: 'COMPLETED',
                        txStatus: 'confirmed',
                        processedAt: now,
                        updatedAt: now,
                    },
                });
                await prisma.commission.updateMany({
                    where: { payoutId: payout.id },
                    data: { status: 'PAID', paidAt: now, updatedAt: now },
                });
                summary.push({ id: payout.id, from: payout.txStatus, to: 'COMPLETED' });
            } else if (status === 'failed') {
                await prisma.payout.update({
                    where: { id: payout.id },
                    data: {
                        status: 'FAILED',
                        txStatus: 'failed',
                        providerError: payout.providerError ?? 'Reconciled as failed via getStatus',
                        updatedAt: now,
                    },
                });
                await prisma.commission.updateMany({
                    where: { payoutId: payout.id },
                    data: { payoutId: null, updatedAt: now },
                });
                summary.push({ id: payout.id, from: payout.txStatus, to: 'FAILED' });
            }
            // 'pending' → leave as is for the next reconcile pass
        } catch (err) {
            console.error('Reconcile failed for payout', payout.id, err);
        }
    }

    await logAuditAction({
        actorId: 'system-cron',
        action: 'RECONCILE_PAYOUTS',
        objectType: 'PAYOUT',
        objectId: 'batch',
        payload: { examined: stalePayouts.length, transitions: summary },
    });

    return NextResponse.json({ success: true, reconciled: summary.length, transitions: summary });
}
