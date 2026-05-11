import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { applyPayoutStatusUpdate, type PayoutStatusUpdate } from '@/lib/payouts/apply-status-update';

/**
 * Webhook receiver for NowPayments IPN callbacks.
 *
 * Authentication: HMAC-SHA512 of the request body with NOWPAYMENTS_IPN_SECRET,
 * where the body is canonicalized by sorting its top-level JSON keys
 * alphabetically before stringification. NowPayments transmits the digest in
 * the `x-nowpayments-sig` header (hex-encoded).
 *
 * Expected payload (representative, fields vary by event):
 *   {
 *     id | withdrawal_id: string | number,
 *     payment_status | status: 'WAITING' | 'PROCESSING' | 'SENDING' | 'FINISHED' | 'FAILED' | 'REJECTED' | 'EXPIRED' | ...,
 *     hash | tx_hash: string,
 *     ...
 *   }
 *
 * We always return 200 once the signature checks out so NowPayments doesn't
 * retry unknown / stale payouts forever; specifics are surfaced via logs.
 */

function canonicalSortedJson(parsed: unknown): string {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return JSON.stringify(parsed);
    }
    const obj = parsed as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = obj[key];
    }
    return JSON.stringify(sorted);
}

function verifySignature(rawBody: string, headerSig: string | null, secret: string): boolean {
    if (!headerSig) return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        return false;
    }
    const canonical = canonicalSortedJson(parsed);
    const expected = crypto.createHmac('sha512', secret).update(canonical).digest('hex');
    const provided = headerSig.toLowerCase();
    if (provided.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
        return false;
    }
}

function normalizeStatus(s: unknown): PayoutStatusUpdate {
    const v = String(s ?? '').toUpperCase();
    if (v === 'FINISHED') return 'confirmed';
    if (v === 'FAILED' || v === 'REJECTED' || v === 'EXPIRED') return 'failed';
    return 'pending';
}

export async function POST(request: NextRequest) {
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!secret) {
        console.error('NOWPAYMENTS_IPN_SECRET is not set; rejecting webhook');
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
    }

    let rawBody: string;
    try {
        rawBody = await request.text();
    } catch {
        return NextResponse.json({ error: 'Could not read body' }, { status: 400 });
    }

    const sig = request.headers.get('x-nowpayments-sig');
    if (!verifySignature(rawBody, sig, secret)) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const taskIdRaw = body.id ?? body.withdrawal_id ?? body.payment_id;
    if (taskIdRaw === undefined || taskIdRaw === null || taskIdRaw === '') {
        return NextResponse.json({ error: 'withdrawal id is required' }, { status: 400 });
    }
    const taskId = String(taskIdRaw);
    const status = normalizeStatus(body.payment_status ?? body.status);
    const txHash = (body.hash ?? body.tx_hash ?? body.txHash) as string | undefined;
    const errMsg = (body.error ?? body.error_message ?? body.message) as string | undefined;

    const result = await applyPayoutStatusUpdate({
        providerTaskId: taskId,
        status,
        txHash: txHash ?? null,
        error: errMsg ?? null,
        auditActor: 'system-webhook-nowpayments',
        auditExtra: { rawStatus: body.payment_status ?? body.status },
    });

    if (result.kind === 'unknown_task') {
        console.warn('NowPayments webhook for unknown task_id', taskId);
        return NextResponse.json({ ok: true, ignored: true });
    }
    if (result.kind === 'already_terminal') {
        return NextResponse.json({ ok: true, alreadyTerminal: true, status: result.status });
    }
    return NextResponse.json({ ok: true, status: result.to });
}
