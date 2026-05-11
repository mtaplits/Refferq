import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as payoutStatusReceiver } from '@/app/api/webhook/payout-status/route';
import { createAffiliate, createUser } from './fixtures';

function makeRequest(url: string, init: RequestInit & { body?: string }) {
    return new Request(url, init) as unknown as import('next/server').NextRequest;
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

describe('SHKeeper callback receiver (Feature B)', () => {
    it('confirms a payout, marks commissions PAID, and persists txHash', async () => {
        process.env.SHKEEPER_CALLBACK_SECRET = 'test-callback-secret';
        const { payoutId, commissionIds } = await seedPayoutInFlight({ taskId: 'task-confirm' });

        const res = await payoutStatusReceiver(
            makeRequest('http://localhost/api/webhook/payout-status?secret=test-callback-secret', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    task_id: 'task-confirm',
                    status: 'confirmed',
                    tx_hash: '0xdeadbeef',
                }),
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

    it('accepts an HMAC-signed callback in lieu of the query secret', async () => {
        process.env.SHKEEPER_CALLBACK_SECRET = 'test-callback-secret';
        const { payoutId } = await seedPayoutInFlight({ taskId: 'task-hmac' });
        const body = JSON.stringify({
            task_id: 'task-hmac',
            status: 'confirmed',
            tx_hash: '0xabc',
        });
        const sig = crypto.createHmac('sha256', 'test-callback-secret').update(body).digest('hex');

        const res = await payoutStatusReceiver(
            makeRequest('http://localhost/api/webhook/payout-status', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-callback-signature': `sha256=${sig}`,
                },
                body,
            })
        );
        expect(res.status).toBe(200);
        const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
        expect(payout?.status).toBe('COMPLETED');
    });

    it('rejects callbacks with neither valid query secret nor HMAC', async () => {
        process.env.SHKEEPER_CALLBACK_SECRET = 'test-callback-secret';
        await seedPayoutInFlight({ taskId: 'task-bad-auth' });

        const res = await payoutStatusReceiver(
            makeRequest('http://localhost/api/webhook/payout-status?secret=wrong', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ task_id: 'task-bad-auth', status: 'confirmed' }),
            })
        );
        expect(res.status).toBe(401);

        const payout = await prisma.payout.findFirst({ where: { providerTaskId: 'task-bad-auth' } });
        expect(payout?.status).toBe('PROCESSING'); // unchanged
    });

    it('is idempotent on terminal-state replay', async () => {
        process.env.SHKEEPER_CALLBACK_SECRET = 'test-callback-secret';
        const { payoutId } = await seedPayoutInFlight({ taskId: 'task-replay' });

        const fire = () =>
            payoutStatusReceiver(
                makeRequest('http://localhost/api/webhook/payout-status?secret=test-callback-secret', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ task_id: 'task-replay', status: 'confirmed', tx_hash: '0x1' }),
                })
            );

        await fire();
        const after1 = await prisma.payout.findUnique({ where: { id: payoutId } });
        const processedAt1 = after1?.processedAt;

        // Replay with a different tx_hash; idempotency should preserve the first.
        const res2 = await payoutStatusReceiver(
            makeRequest('http://localhost/api/webhook/payout-status?secret=test-callback-secret', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ task_id: 'task-replay', status: 'confirmed', tx_hash: '0x2' }),
            })
        );
        expect(res2.status).toBe(200);

        const after2 = await prisma.payout.findUnique({ where: { id: payoutId } });
        expect(after2?.txHash).toBe('0x1'); // not overwritten
        expect(after2?.processedAt?.getTime()).toBe(processedAt1?.getTime());
    });

    it('marks failed and unlinks commissions when the provider reports failure', async () => {
        process.env.SHKEEPER_CALLBACK_SECRET = 'test-callback-secret';
        const { payoutId, commissionIds } = await seedPayoutInFlight({ taskId: 'task-fail' });

        const res = await payoutStatusReceiver(
            makeRequest('http://localhost/api/webhook/payout-status?secret=test-callback-secret', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    task_id: 'task-fail',
                    status: 'failed',
                    error: 'insufficient balance',
                }),
            })
        );
        expect(res.status).toBe(200);

        const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
        expect(payout?.status).toBe('FAILED');
        expect(payout?.providerError).toMatch(/insufficient balance/);

        const commissions = await prisma.commission.findMany({ where: { id: { in: commissionIds } } });
        // Commissions stayed APPROVED (never flipped to PAID) and were unlinked.
        expect(commissions[0].status).toBe('APPROVED');
        expect(commissions[0].payoutId).toBeNull();
    });
});
