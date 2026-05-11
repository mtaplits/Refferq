import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the status-update helper so this is a pure unit test of the webhook
// route: signature verification, status normalization, and dispatch.
vi.mock('@/lib/payouts/apply-status-update', () => ({
    applyPayoutStatusUpdate: vi.fn(),
}));

import { applyPayoutStatusUpdate } from '@/lib/payouts/apply-status-update';
import { POST as nowPaymentsWebhook } from '@/app/api/webhook/nowpayments/route';

const SECRET = 'test-ipn-secret';

function makeRequest(opts: { body: string; sig?: string }) {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (opts.sig !== undefined) headers.set('x-nowpayments-sig', opts.sig);
    return new Request('http://localhost/api/webhook/nowpayments', {
        method: 'POST',
        headers,
        body: opts.body,
    }) as unknown as import('next/server').NextRequest;
}

function canonicalSign(payload: Record<string, unknown>, secret = SECRET): { body: string; sig: string } {
    const sortedKeys = Object.keys(payload).sort();
    const canonical = JSON.stringify(
        sortedKeys.reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = payload[k];
            return acc;
        }, {})
    );
    const sig = crypto.createHmac('sha512', secret).update(canonical).digest('hex');
    // Important: send the body in a different key order than canonical, so the
    // test exercises the "sort before verify" code path on the receiver side.
    const reverseOrdered = sortedKeys
        .slice()
        .reverse()
        .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = payload[k];
            return acc;
        }, {});
    return { body: JSON.stringify(reverseOrdered), sig };
}

describe('NowPayments webhook', () => {
    beforeEach(() => {
        process.env.NOWPAYMENTS_IPN_SECRET = SECRET;
        vi.mocked(applyPayoutStatusUpdate).mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('500s when NOWPAYMENTS_IPN_SECRET is unset', async () => {
        delete process.env.NOWPAYMENTS_IPN_SECRET;
        const res = await nowPaymentsWebhook(makeRequest({ body: '{}', sig: 'whatever' }));
        expect(res.status).toBe(500);
    });

    it('401s on missing signature', async () => {
        const res = await nowPaymentsWebhook(makeRequest({ body: '{"id":1}' }));
        expect(res.status).toBe(401);
    });

    it('401s on a wrong signature', async () => {
        const res = await nowPaymentsWebhook(
            makeRequest({ body: '{"id":1}', sig: '00'.repeat(64) })
        );
        expect(res.status).toBe(401);
    });

    it('verifies a correct HMAC-SHA512 signature regardless of incoming key order', async () => {
        vi.mocked(applyPayoutStatusUpdate).mockResolvedValue({
            kind: 'transitioned',
            to: 'COMPLETED',
            payoutId: 'po-1',
        });

        const { body, sig } = canonicalSign({
            id: 'wd-1',
            payment_status: 'FINISHED',
            hash: '0xabc',
            amount: '12.34',
        });

        const res = await nowPaymentsWebhook(makeRequest({ body, sig }));
        expect(res.status).toBe(200);
        const data = (await res.json()) as { ok: boolean; status: string };
        expect(data.ok).toBe(true);
        expect(data.status).toBe('COMPLETED');
        expect(applyPayoutStatusUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                providerTaskId: 'wd-1',
                status: 'confirmed',
                txHash: '0xabc',
                auditActor: 'system-webhook-nowpayments',
            })
        );
    });

    it('responds 200 with ignored:true for an unknown task id', async () => {
        vi.mocked(applyPayoutStatusUpdate).mockResolvedValue({ kind: 'unknown_task' });
        const { body, sig } = canonicalSign({
            id: 'wd-unknown',
            payment_status: 'FINISHED',
        });
        const res = await nowPaymentsWebhook(makeRequest({ body, sig }));
        expect(res.status).toBe(200);
        const data = (await res.json()) as { ignored?: boolean };
        expect(data.ignored).toBe(true);
    });

    it('is idempotent against a payout already in a terminal state', async () => {
        vi.mocked(applyPayoutStatusUpdate).mockResolvedValue({
            kind: 'already_terminal',
            status: 'COMPLETED',
        });
        const { body, sig } = canonicalSign({
            id: 'wd-1',
            payment_status: 'FINISHED',
        });
        const res = await nowPaymentsWebhook(makeRequest({ body, sig }));
        expect(res.status).toBe(200);
        const data = (await res.json()) as { alreadyTerminal?: boolean; status?: string };
        expect(data.alreadyTerminal).toBe(true);
        expect(data.status).toBe('COMPLETED');
    });

    it.each([
        ['FINISHED', 'confirmed'],
        ['FAILED', 'failed'],
        ['REJECTED', 'failed'],
        ['EXPIRED', 'failed'],
        ['WAITING', 'pending'],
        ['SENDING', 'pending'],
    ])('normalizes status %s → %s before dispatch', async (raw, expected) => {
        vi.mocked(applyPayoutStatusUpdate).mockResolvedValue({
            kind: 'transitioned',
            to: 'PROCESSING',
            payoutId: 'po-1',
        });
        const { body, sig } = canonicalSign({ id: 'wd-1', payment_status: raw });
        await nowPaymentsWebhook(makeRequest({ body, sig }));
        const args = vi.mocked(applyPayoutStatusUpdate).mock.calls[0][0];
        expect(args.status).toBe(expected);
    });

    it('400s when withdrawal id is missing from the body', async () => {
        const { body, sig } = canonicalSign({ payment_status: 'FINISHED' });
        const res = await nowPaymentsWebhook(makeRequest({ body, sig }));
        expect(res.status).toBe(400);
    });
});
