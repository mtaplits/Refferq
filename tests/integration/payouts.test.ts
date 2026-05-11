import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as nowPaymentsWebhook } from '@/app/api/webhook/nowpayments/route';
import { createAffiliate, createUser } from './fixtures';

const IPN_SECRET = 'test-ipn-secret';

function makeRequest(url: string, init: RequestInit & { body?: string }) {
    return new Request(url, init) as unknown as import('next/server').NextRequest;
}

/**
 * Build a NowPayments-style signed request: HMAC-SHA512 of the body with
 * top-level keys sorted alphabetically. The transmitted body uses the original
 * (unsorted) key order so the receiver's canonicalize-then-verify code path
 * gets exercised.
 */
function signedNowPaymentsRequest(payload: Record<string, unknown>): {
    body: string;
    sig: string;
} {
    const sortedKeys = Object.keys(payload).sort();
    const canonical = JSON.stringify(
        sortedKeys.reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = payload[k];
            return acc;
        }, {})
    );
    const sig = crypto.createHmac('sha512', IPN_SECRET).update(canonical).digest('hex');
    return { body: JSON.stringify(payload), sig };
}

async function seedPayoutInFlight(opts: { taskId: string }): Promise<{
    payoutId: string;
    commissionIds: string[];
    affiliateId: string;
    userId: string;
}> {
    const u = await createUser({ name: 'Recipient' });
    const a = await createAffiliate({ user: u });
    const conv = await prisma.conversion.create({
        data: {
            affiliateId: a.id,
            eventType: 'PURCHASE',
            amountCents: 10_000,
            currency: 'USDT',
            status: 'APPROVED',
        },
    });
    const c1 = await prisma.commission.create({
        data: {
            conversionId: conv.id,
            affiliateId: a.id,
            userId: u.id,
            amountCents: 1_000,
            rate: 10,
            status: 'APPROVED',
            approvedAt: new Date(),
        },
    });
    const payout = await prisma.payout.create({
        data: {
            affiliateId: a.id,
            userId: u.id,
            amountCents: 1_000,
            commissionCount: 1,
            method: 'USDT_ONCHAIN',
            status: 'PROCESSING',
            txStatus: 'queued',
            providerTaskId: opts.taskId,
            createdBy: u.id,
        },
    });
    // Link commission to payout but keep status APPROVED (crypto flow).
    await prisma.commission.update({
        where: { id: c1.id },
        data: { payoutId: payout.id },
    });
    return { payoutId: payout.id, commissionIds: [c1.id], affiliateId: a.id, userId: u.id };
}

describe('NowPayments IPN webhook (Feature B)', () => {
    it('confirms a payout, marks commissions PAID, and persists txHash', async () => {
        process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
        const { payoutId, commissionIds } = await seedPayoutInFlight({ taskId: 'wd-confirm' });

        const { body, sig } = signedNowPaymentsRequest({
            id: 'wd-confirm',
            payment_status: 'FINISHED',
            hash: '0xdeadbeef',
        });

        const res = await nowPaymentsWebhook(
            makeRequest('http://localhost/api/webhook/nowpayments', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-nowpayments-sig': sig,
                },
                body,
            })
        );
        expect(res.status).toBe(200);

        const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
        expect(payout?.status).toBe('COMPLETED');
        expect(payout?.txStatus).toBe('confirmed');
        expect(payout?.txHash).toBe('0xdeadbeef');
        expect(payout?.processedAt).toBeInstanceOf(Date);

        const commissions = await prisma.commission.findMany({ where: { id: { in: commissionIds } } });
        expect(commissions).toHaveLength(1);
        expect(commissions[0].status).toBe('PAID');
        expect(commissions[0].paidAt).toBeInstanceOf(Date);
    });

    it('rejects callbacks with a missing or invalid signature', async () => {
        process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
        await seedPayoutInFlight({ taskId: 'wd-bad-auth' });

        const body = JSON.stringify({ id: 'wd-bad-auth', payment_status: 'FINISHED' });
        const res = await nowPaymentsWebhook(
            makeRequest('http://localhost/api/webhook/nowpayments', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-nowpayments-sig': '00'.repeat(64),
                },
                body,
            })
        );
        expect(res.status).toBe(401);

        const payout = await prisma.payout.findFirst({ where: { providerTaskId: 'wd-bad-auth' } });
        expect(payout?.status).toBe('PROCESSING'); // unchanged
    });

    it('is idempotent on terminal-state replay', async () => {
        process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
        const { payoutId } = await seedPayoutInFlight({ taskId: 'wd-replay' });

        const fire = (txHash: string) => {
            const { body, sig } = signedNowPaymentsRequest({
                id: 'wd-replay',
                payment_status: 'FINISHED',
                hash: txHash,
            });
            return nowPaymentsWebhook(
                makeRequest('http://localhost/api/webhook/nowpayments', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig },
                    body,
                })
            );
        };

        await fire('0x1');
        const after1 = await prisma.payout.findUnique({ where: { id: payoutId } });
        const processedAt1 = after1?.processedAt;

        const res2 = await fire('0x2');
        expect(res2.status).toBe(200);

        const after2 = await prisma.payout.findUnique({ where: { id: payoutId } });
        expect(after2?.txHash).toBe('0x1'); // not overwritten
        expect(after2?.processedAt?.getTime()).toBe(processedAt1?.getTime());
    });

    it('marks failed, unlinks commissions, AND refunds balance', async () => {
        process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
        const { payoutId, commissionIds, affiliateId } = await seedPayoutInFlight({ taskId: 'wd-fail' });
        // Balance starts at 0 (post-decrement at payout-create). After the
        // failed callback, the payout amount (1_000) is re-credited.
        const before = await prisma.affiliate.findUnique({ where: { id: affiliateId } });
        expect(before?.balanceCents).toBe(0);

        const { body, sig } = signedNowPaymentsRequest({
            id: 'wd-fail',
            payment_status: 'FAILED',
            error: 'insufficient balance',
        });
        const res = await nowPaymentsWebhook(
            makeRequest('http://localhost/api/webhook/nowpayments', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig },
                body,
            })
        );
        expect(res.status).toBe(200);

        const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
        expect(payout?.status).toBe('FAILED');
        expect(payout?.providerError).toMatch(/insufficient balance/);

        const commissions = await prisma.commission.findMany({ where: { id: { in: commissionIds } } });
        expect(commissions[0].status).toBe('APPROVED');
        expect(commissions[0].payoutId).toBeNull();

        const after = await prisma.affiliate.findUnique({ where: { id: affiliateId } });
        expect(after?.balanceCents).toBe(1_000); // refunded
    });

    it('returns 200/ignored:true for an unknown withdrawal id', async () => {
        process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
        const { body, sig } = signedNowPaymentsRequest({
            id: 'wd-not-in-db',
            payment_status: 'FINISHED',
            hash: '0xnope',
        });
        const res = await nowPaymentsWebhook(
            makeRequest('http://localhost/api/webhook/nowpayments', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig },
                body,
            })
        );
        expect(res.status).toBe(200);
        const payload = (await res.json()) as { ignored?: boolean };
        expect(payload.ignored).toBe(true);
    });
});
