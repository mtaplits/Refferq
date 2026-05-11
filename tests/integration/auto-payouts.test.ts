import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as autoPayouts } from '@/app/api/admin/payouts/auto/route';
import {
    createAffiliate,
    createProgramSettings,
    createUser,
} from './fixtures';

function makeAdminRequest(adminId: string, body: object = {}) {
    return new Request('http://localhost/api/admin/payouts/auto', {
        method: 'POST',
        headers: { 'x-user-id': adminId, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

/**
 * Seed APPROVED commissions for an affiliate AND mirror the balance.
 * Auto-payouts reads `commission` rows directly (not just balance), so
 * tests need to maintain the `balance = sum(APPROVED w/ payoutId=null)`
 * invariant.
 */
async function seedApprovedCommissions(opts: { affiliateId: string; userId: string; amountCents: number; count?: number }) {
    const each = Math.floor(opts.amountCents / (opts.count ?? 1));
    for (let i = 0; i < (opts.count ?? 1); i++) {
        const conv = await prisma.conversion.create({
            data: { affiliateId: opts.affiliateId, eventType: 'PURCHASE', amountCents: each, currency: 'USD', status: 'APPROVED' },
        });
        await prisma.commission.create({
            data: {
                conversionId: conv.id,
                affiliateId: opts.affiliateId,
                userId: opts.userId,
                amountCents: each,
                rate: 10,
                status: 'APPROVED',
                approvedAt: new Date(),
            },
        });
    }
    await prisma.affiliate.update({
        where: { id: opts.affiliateId },
        data: { balanceCents: { increment: each * (opts.count ?? 1) } },
    });
}

describe('Auto-payouts (Feature B)', () => {
    it('FIAT: links APPROVED commissions, marks PAID, decrements balance', async () => {
        await createProgramSettings({
            currency: 'USD',
            treasuryType: 'FIAT',
            minPayoutCents: 50_00,
        });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const u1 = await createUser({ name: 'Above' });
        const a1 = await createAffiliate({ user: u1 });
        await seedApprovedCommissions({ affiliateId: a1.id, userId: u1.id, amountCents: 100_00, count: 2 });

        const u2 = await createUser({ name: 'Below' });
        const a2 = await createAffiliate({ user: u2 });
        await seedApprovedCommissions({ affiliateId: a2.id, userId: u2.id, amountCents: 10_00, count: 1 });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.processed).toBe(1);
        expect(body.totalAmountCents).toBe(100_00);

        const payouts = await prisma.payout.findMany();
        expect(payouts).toHaveLength(1);
        expect(payouts[0].status).toBe('PENDING');
        expect(payouts[0].affiliateId).toBe(a1.id);
        expect(payouts[0].commissionCount).toBe(2);

        // Eligible affiliate: balance decremented, commissions PAID + linked.
        const a1After = await prisma.affiliate.findUnique({ where: { id: a1.id } });
        expect(a1After?.balanceCents).toBe(0);
        const a1Commissions = await prisma.commission.findMany({ where: { affiliateId: a1.id } });
        expect(a1Commissions.every((c) => c.status === 'PAID')).toBe(true);
        expect(a1Commissions.every((c) => c.payoutId === payouts[0].id)).toBe(true);

        // Below-threshold affiliate: untouched.
        const a2After = await prisma.affiliate.findUnique({ where: { id: a2.id } });
        expect(a2After?.balanceCents).toBe(10_00);
        const a2Commissions = await prisma.commission.findMany({ where: { affiliateId: a2.id } });
        expect(a2Commissions.every((c) => c.status === 'APPROVED')).toBe(true);
        expect(a2Commissions.every((c) => c.payoutId === null)).toBe(true);
    });

    it('CRYPTO: queues via stub provider; commissions stay APPROVED, balance decrements', async () => {
        await createProgramSettings({
            currency: 'USDT',
            treasuryType: 'CRYPTO',
            minPayoutCents: 50_00,
        });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Recipient' });
        const a = await createAffiliate({
            user: u,
            payoutDetails: { walletAddress: '0xabc' },
        });
        await seedApprovedCommissions({ affiliateId: a.id, userId: u.id, amountCents: 200_00, count: 2 });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.processed).toBe(1);

        const payout = await prisma.payout.findFirst({ where: { affiliateId: a.id } });
        expect(payout?.status).toBe('PROCESSING');
        expect(payout?.method).toBe('USDT_ONCHAIN');
        expect(payout?.txStatus).toBe('queued');
        expect(payout?.providerTaskId).toMatch(/^stub-/);
        expect(payout?.amountCents).toBe(200_00);

        const aAfter = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aAfter?.balanceCents).toBe(0);

        const cs = await prisma.commission.findMany({ where: { affiliateId: a.id } });
        expect(cs.every((c) => c.status === 'APPROVED')).toBe(true);
        expect(cs.every((c) => c.payoutId === payout?.id)).toBe(true);
    });

    it('CRYPTO: skips affiliates missing walletAddress', async () => {
        await createProgramSettings({
            currency: 'USDT',
            treasuryType: 'CRYPTO',
            minPayoutCents: 10_00,
        });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'NoWallet' });
        const a = await createAffiliate({ user: u, payoutDetails: {} });
        await seedApprovedCommissions({ affiliateId: a.id, userId: u.id, amountCents: 50_00, count: 1 });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.processed).toBe(0);
        const skipped = body.results.find((r: { status: string }) => r.status === 'SKIPPED');
        expect(skipped).toBeDefined();
        expect(skipped.error).toMatch(/walletAddress/);

        // Balance + commissions untouched.
        const aAfter = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aAfter?.balanceCents).toBe(50_00);
        const cs = await prisma.commission.findMany({ where: { affiliateId: a.id } });
        expect(cs.every((c) => c.payoutId === null)).toBe(true);
    });

    it('skips affiliates whose balance is above threshold but have no unlinked APPROVED commissions', async () => {
        // This is the legacy-data case: balance is positive but no commissions
        // exist (e.g. seeded directly). New invariant requires commissions.
        await createProgramSettings({ currency: 'USD', minPayoutCents: 10_00 });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Stale' });
        const a = await createAffiliate({ user: u });
        await prisma.affiliate.update({ where: { id: a.id }, data: { balanceCents: 100_00 } });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        const body = await res.json();
        expect(body.processed).toBe(0);
        // Balance preserved (not zeroed) — old code would have wrongly paid.
        const aAfter = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aAfter?.balanceCents).toBe(100_00);
    });

    it('rejects when CRYPTO program has non-USDT currency', async () => {
        await createProgramSettings({ currency: 'USDT', treasuryType: 'CRYPTO' });
        await prisma.programSettings.updateMany({ data: { currency: 'BOGUS' } });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        expect(res.status).toBe(400);
    });

    it('dryRun returns eligibility info without creating payouts', async () => {
        await createProgramSettings({ currency: 'USD', minPayoutCents: 10_00 });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Eligible' });
        const a = await createAffiliate({ user: u });
        await seedApprovedCommissions({ affiliateId: a.id, userId: u.id, amountCents: 100_00, count: 1 });

        const res = await autoPayouts(makeAdminRequest(admin.id, { dryRun: true }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.dryRun).toBe(true);
        expect(body.totalAffiliates).toBe(1);
        expect(body.totalAmountCents).toBe(100_00);

        // No payouts created.
        const payouts = await prisma.payout.findMany();
        expect(payouts).toHaveLength(0);
        // Balance + commissions unchanged.
        const aAfter = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aAfter?.balanceCents).toBe(100_00);
        const cs = await prisma.commission.findMany({ where: { affiliateId: a.id } });
        expect(cs.every((c) => c.payoutId === null)).toBe(true);
    });
});
