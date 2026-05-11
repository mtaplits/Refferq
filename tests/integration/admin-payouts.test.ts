import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as createPayout } from '@/app/api/admin/payouts/route';
import {
    createAffiliate,
    createProgramSettings,
    createUser,
} from './fixtures';

function makeAdminRequest(url: string, body: object, adminId: string) {
    return new Request(url, {
        method: 'POST',
        headers: { 'x-user-id': adminId, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

async function seedApprovedCommissions(opts: {
    affiliateId: string;
    userId: string;
    count: number;
    amountCents?: number;
}) {
    const ids: string[] = [];
    for (let i = 0; i < opts.count; i++) {
        const conv = await prisma.conversion.create({
            data: {
                affiliateId: opts.affiliateId,
                eventType: 'PURCHASE',
                amountCents: opts.amountCents ?? 10_000,
                currency: 'USD',
                status: 'APPROVED',
            },
        });
        const c = await prisma.commission.create({
            data: {
                conversionId: conv.id,
                affiliateId: opts.affiliateId,
                userId: opts.userId,
                amountCents: 1_000,
                rate: 10,
                status: 'APPROVED',
                approvedAt: new Date(),
            },
        });
        ids.push(c.id);
    }
    return ids;
}

describe('Admin payouts CREATE (Feature B)', () => {
    it('fiat path: creates a PENDING payout and marks commissions PAID', async () => {
        await createProgramSettings({ currency: 'USD', treasuryType: 'FIAT' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Recipient' });
        const a = await createAffiliate({ user: u });
        const commissionIds = await seedApprovedCommissions({
            affiliateId: a.id,
            userId: u.id,
            count: 2,
        });

        const res = await createPayout(
            makeAdminRequest(
                'http://localhost/api/admin/payouts',
                {
                    affiliateId: a.id,
                    commissionIds,
                    method: 'PAYPAL',
                    notes: 'monthly',
                },
                admin.id
            )
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.payout.status).toBe('PENDING');
        expect(body.payout.amountCents).toBe(2000);

        const commissions = await prisma.commission.findMany({
            where: { id: { in: commissionIds } },
        });
        expect(commissions.every((c) => c.status === 'PAID')).toBe(true);
        expect(commissions.every((c) => c.payoutId === body.payout.id)).toBe(true);
    });

    it('crypto path: validates treasury=CRYPTO and rejects when program is FIAT', async () => {
        await createProgramSettings({ currency: 'USD', treasuryType: 'FIAT' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Recipient' });
        const a = await createAffiliate({
            user: u,
            payoutDetails: { walletAddress: '0xabc' },
        });
        const commissionIds = await seedApprovedCommissions({
            affiliateId: a.id,
            userId: u.id,
            count: 1,
        });

        const res = await createPayout(
            makeAdminRequest(
                'http://localhost/api/admin/payouts',
                { affiliateId: a.id, commissionIds, method: 'USDT_ONCHAIN' },
                admin.id
            )
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/CRYPTO-treasury/);

        // Commissions must still be APPROVED (not linked to any payout).
        const commissions = await prisma.commission.findMany({
            where: { id: { in: commissionIds } },
        });
        expect(commissions.every((c) => c.status === 'APPROVED')).toBe(true);
        expect(commissions.every((c) => c.payoutId === null)).toBe(true);
    });

    it('crypto path: rejects when affiliate has no walletAddress in payoutDetails', async () => {
        await createProgramSettings({ currency: 'USDT', treasuryType: 'CRYPTO' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Recipient' });
        const a = await createAffiliate({
            user: u,
            payoutDetails: {} /* no walletAddress */,
        });
        const commissionIds = await seedApprovedCommissions({
            affiliateId: a.id,
            userId: u.id,
            count: 1,
        });

        const res = await createPayout(
            makeAdminRequest(
                'http://localhost/api/admin/payouts',
                { affiliateId: a.id, commissionIds, method: 'USDT_ONCHAIN' },
                admin.id
            )
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/walletAddress/);
    });

    it('crypto path: queues via stub provider, persists providerTaskId, keeps commissions APPROVED', async () => {
        await createProgramSettings({ currency: 'USDT', treasuryType: 'CRYPTO' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Recipient' });
        const a = await createAffiliate({
            user: u,
            payoutDetails: { walletAddress: '0xabc' },
        });
        const commissionIds = await seedApprovedCommissions({
            affiliateId: a.id,
            userId: u.id,
            count: 1,
        });

        const res = await createPayout(
            makeAdminRequest(
                'http://localhost/api/admin/payouts',
                { affiliateId: a.id, commissionIds, method: 'USDT_ONCHAIN' },
                admin.id
            )
        );
        expect(res.status).toBe(200);

        const payouts = await prisma.payout.findMany();
        expect(payouts).toHaveLength(1);
        expect(payouts[0].status).toBe('PROCESSING');
        expect(payouts[0].txStatus).toBe('queued');
        expect(payouts[0].providerTaskId).toMatch(/^stub-/);

        // Commissions are linked to the payout but still APPROVED (will flip
        // to PAID via the callback receiver).
        const commissions = await prisma.commission.findMany({
            where: { id: { in: commissionIds } },
        });
        expect(commissions.every((c) => c.status === 'APPROVED')).toBe(true);
        expect(commissions.every((c) => c.payoutId === payouts[0].id)).toBe(true);
    });

    it('rejects when a commission is still PENDING (within hold period)', async () => {
        await createProgramSettings({ currency: 'USD' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Recipient' });
        const a = await createAffiliate({ user: u });

        // One PENDING (not yet matured), one APPROVED.
        const conv1 = await prisma.conversion.create({
            data: { affiliateId: a.id, eventType: 'PURCHASE', amountCents: 1000, currency: 'USD' },
        });
        const c1 = await prisma.commission.create({
            data: {
                conversionId: conv1.id,
                affiliateId: a.id,
                userId: u.id,
                amountCents: 100,
                rate: 10,
                status: 'PENDING',
                maturesAt: new Date(Date.now() + 86400000),
            },
        });
        const approvedIds = await seedApprovedCommissions({
            affiliateId: a.id,
            userId: u.id,
            count: 1,
        });

        const res = await createPayout(
            makeAdminRequest(
                'http://localhost/api/admin/payouts',
                {
                    affiliateId: a.id,
                    commissionIds: [c1.id, ...approvedIds],
                    method: 'PAYPAL',
                },
                admin.id
            )
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/hold period/);
    });

    it('rejects non-admin requesters', async () => {
        const u = await createUser({ name: 'Aff', role: 'AFFILIATE' });
        const a = await createAffiliate({ user: u });

        const res = await createPayout(
            makeAdminRequest(
                'http://localhost/api/admin/payouts',
                { affiliateId: a.id, commissionIds: ['fake'] },
                u.id
            )
        );
        expect(res.status).toBe(403);
    });
});
