import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';

export type PayoutStatusUpdate = 'confirmed' | 'failed' | 'pending';

export interface ApplyStatusUpdateInput {
    /** The provider's task / withdrawal id (matches Payout.providerTaskId). */
    providerTaskId: string;
    /** Normalized status from the webhook payload. */
    status: PayoutStatusUpdate;
    /** On-chain transaction hash, if the provider has one yet. */
    txHash?: string | null;
    /** Provider-supplied error message, used on `status === 'failed'`. */
    error?: string | null;
    /** Identifier for the audit log actor (e.g. 'system-webhook-nowpayments'). */
    auditActor: string;
    /** Optional extra payload merged into the audit log entry. */
    auditExtra?: Record<string, unknown>;
}

export type ApplyStatusUpdateResult =
    | { kind: 'unknown_task' }
    | { kind: 'already_terminal'; status: 'COMPLETED' | 'FAILED' }
    | { kind: 'transitioned'; to: 'COMPLETED' | 'FAILED' | 'PROCESSING'; payoutId: string };

/**
 * Shared helper that applies a normalized provider status to a payout. Used by
 * both webhook routes (NowPayments today, others tomorrow) and the reconcile
 * cron, so the state machine stays in one place.
 *
 * Behavior:
 *  - 'confirmed' → Payout.status = COMPLETED, commissions → PAID
 *  - 'failed'    → Payout.status = FAILED, refund (unlink commissions, re-credit balance)
 *  - 'pending'   → record broadcast + tx hash, leave payout in PROCESSING
 *
 * Idempotency: if the payout is already in a terminal state (COMPLETED or
 * FAILED), the call is a no-op so retries from the provider are safe.
 */
export async function applyPayoutStatusUpdate(
    input: ApplyStatusUpdateInput
): Promise<ApplyStatusUpdateResult> {
    const { providerTaskId, status, txHash, error, auditActor, auditExtra } = input;

    const payout = await prisma.payout.findFirst({
        where: { providerTaskId },
    });
    if (!payout) {
        return { kind: 'unknown_task' };
    }

    if (payout.status === 'COMPLETED' || payout.status === 'FAILED') {
        return { kind: 'already_terminal', status: payout.status };
    }

    const now = new Date();

    if (status === 'confirmed') {
        await prisma.payout.update({
            where: { id: payout.id },
            data: {
                status: 'COMPLETED',
                txStatus: 'confirmed',
                txHash: txHash || null,
                processedAt: now,
                updatedAt: now,
            },
        });
        await prisma.commission.updateMany({
            where: { payoutId: payout.id },
            data: { status: 'PAID', paidAt: now, updatedAt: now },
        });
        await logAuditAction({
            actorId: auditActor,
            action: 'PAYOUT_CONFIRMED',
            objectType: 'PAYOUT',
            objectId: payout.id,
            payload: { providerTaskId, txHash, ...auditExtra },
        });
        return { kind: 'transitioned', to: 'COMPLETED', payoutId: payout.id };
    }

    if (status === 'failed') {
        await prisma.payout.update({
            where: { id: payout.id },
            data: {
                status: 'FAILED',
                txStatus: 'failed',
                providerError: error || 'Provider reported failed status',
                updatedAt: now,
            },
        });
        // Refund: unlink commissions AND re-credit the affiliate's balance by
        // the payout amount. The balance was decremented at payout-create time
        // to maintain the `balance = sum(APPROVED w/ payoutId=null)` invariant;
        // we restore it here so the commissions can be retried.
        await prisma.commission.updateMany({
            where: { payoutId: payout.id },
            data: { payoutId: null, updatedAt: now },
        });
        await prisma.affiliate.update({
            where: { id: payout.affiliateId },
            data: { balanceCents: { increment: payout.amountCents } },
        });
        await logAuditAction({
            actorId: auditActor,
            action: 'PAYOUT_FAILED',
            objectType: 'PAYOUT',
            objectId: payout.id,
            payload: { providerTaskId, error, refundedCents: payout.amountCents, ...auditExtra },
        });
        return { kind: 'transitioned', to: 'FAILED', payoutId: payout.id };
    }

    // 'pending' or other intermediate: record broadcast + tx hash.
    await prisma.payout.update({
        where: { id: payout.id },
        data: {
            txStatus: 'broadcast',
            txHash: txHash || payout.txHash || null,
            updatedAt: now,
        },
    });
    return { kind: 'transitioned', to: 'PROCESSING', payoutId: payout.id };
}
