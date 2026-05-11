import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import crypto from 'crypto';

/**
 * Webhook receiver for crypto-provider (SHKeeper) status callbacks.
 *
 * Expected body shape (best-effort across SHKeeper versions):
 * {
 *   task_id: string,
 *   status: 'confirmed' | 'failed' | 'pending' | ...,
 *   tx_hash?: string,
 *   error?: string,
 *   ...
 * }
 *
 * Authenticates via:
 *  1. `?secret=` query param matching SHKEEPER_CALLBACK_SECRET, OR
 *  2. an `x-callback-signature` HMAC of the raw body using SHKEEPER_CALLBACK_SECRET.
 */
function verifyCallback(request: NextRequest, rawBody: string): boolean {
    const expected = process.env.SHKEEPER_CALLBACK_SECRET;
    if (!expected) {
        // Without a configured secret, we accept the callback (operator's
        // responsibility to set the secret in production).
        return true;
    }
    const url = new URL(request.url);
    const querySecret = url.searchParams.get('secret');
    if (querySecret && timingSafeEqStrings(querySecret, expected)) {
        return true;
    }
    const signature = request.headers.get('x-callback-signature') || request.headers.get('x-shkeeper-signature');
    if (signature) {
        const computed = crypto.createHmac('sha256', expected).update(rawBody).digest('hex');
        const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
        try {
            return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'));
        } catch {
            return false;
        }
    }
    return false;
}

function timingSafeEqStrings(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function normalizeStatus(s: unknown): 'confirmed' | 'failed' | 'pending' {
    const v = String(s ?? '').toLowerCase();
    if (v === 'confirmed' || v === 'paid' || v === 'success') return 'confirmed';
    if (v === 'failed' || v === 'error') return 'failed';
    return 'pending';
}

export async function POST(request: NextRequest) {
    let rawBody: string;
    try {
        rawBody = await request.text();
    } catch {
        return NextResponse.json({ error: 'Could not read body' }, { status: 400 });
    }
    if (!verifyCallback(request, rawBody)) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const taskId = (body.task_id ?? body.taskId ?? body.id) as string | undefined;
    if (!taskId) {
        return NextResponse.json({ error: 'task_id is required' }, { status: 400 });
    }

    const payout = await prisma.payout.findFirst({
        where: { providerTaskId: taskId },
    });
    if (!payout) {
        // Unknown task_id — return 200 so the provider doesn't retry forever,
        // but log it for diagnostics.
        console.warn('payout-status callback for unknown task_id', taskId);
        return NextResponse.json({ ok: true, ignored: true });
    }

    // Idempotency: terminal states (COMPLETED, FAILED) are not re-applied.
    if (payout.status === 'COMPLETED' || payout.status === 'FAILED') {
        return NextResponse.json({ ok: true, alreadyTerminal: true });
    }

    const status = normalizeStatus(body.status);
    const txHash = (body.tx_hash ?? body.txHash) as string | undefined;
    const errMsg = (body.error ?? body.message) as string | undefined;
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
            actorId: 'system-webhook',
            action: 'PAYOUT_CONFIRMED',
            objectType: 'PAYOUT',
            objectId: payout.id,
            payload: { taskId, txHash },
        });
        return NextResponse.json({ ok: true, status: 'COMPLETED' });
    }

    if (status === 'failed') {
        await prisma.payout.update({
            where: { id: payout.id },
            data: {
                status: 'FAILED',
                txStatus: 'failed',
                providerError: errMsg || 'Provider reported failed status',
                updatedAt: now,
            },
        });
        // Refund: unlink commissions AND re-credit the affiliate's balance
        // by the payout amount. The balance was decremented at payout-create
        // time to maintain the `balance = sum(APPROVED w/ payoutId=null)`
        // invariant; we restore it here so the commissions can be retried.
        await prisma.commission.updateMany({
            where: { payoutId: payout.id },
            data: { payoutId: null, updatedAt: now },
        });
        await prisma.affiliate.update({
            where: { id: payout.affiliateId },
            data: { balanceCents: { increment: payout.amountCents } },
        });
        await logAuditAction({
            actorId: 'system-webhook',
            action: 'PAYOUT_FAILED',
            objectType: 'PAYOUT',
            objectId: payout.id,
            payload: { taskId, error: errMsg, refundedCents: payout.amountCents },
        });
        return NextResponse.json({ ok: true, status: 'FAILED' });
    }

    // 'pending' or other intermediate states: record the broadcast and keep
    // the payout in PROCESSING.
    await prisma.payout.update({
        where: { id: payout.id },
        data: {
            txStatus: 'broadcast',
            txHash: txHash || payout.txHash || null,
            updatedAt: now,
        },
    });
    return NextResponse.json({ ok: true, status: 'PROCESSING' });
}
