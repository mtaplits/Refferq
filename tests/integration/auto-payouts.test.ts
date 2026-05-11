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

describe('Auto-payouts (Feature B)', () => {
    it('FIAT: zeros eligible balances and creates PENDING payouts', async () => {
        await createProgramSettings({
            currency: 'USD',
            treasuryType: 'FIAT',
            minPayoutCents: 50_00, // $50
        });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const u1 = await createUser({ name: 'Above' });
        const a1 = await createAffiliate({ user: u1 });
        await prisma.affiliate.update({ where: { id: a1.id }, data: { balanceCents: 100_00 } });

        const u2 = await createUser({ name: 'Below' });
        const a2 = await createAffiliate({ user: u2 });
        await prisma.affiliate.update({ where: { id: a2.id }, data: { balanceCents: 10_00 } });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.processed).toBe(1);
        expect(body.totalAmountCents).toBe(100_00);

        const payouts = await prisma.payout.findMany();
        expect(payouts).toHaveLength(1);
        expect(payouts[0].status).toBe('PENDING');
        expect(payouts[0].affiliateId).toBe(a1.id);

        const a1After = await prisma.affiliate.findUnique({ where: { id: a1.id } });
        const a2After = await prisma.affiliate.findUnique({ where: { id: a2.id } });
        expect(a1After?.balanceCents).toBe(0);
        expect(a2After?.balanceCents).toBe(10_00); // unchanged
    });

    it('CRYPTO: queues via stub provider, sets PROCESSING + providerTaskId', async () => {
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
        await prisma.affiliate.update({
            where: { id: a.id },
            data: { balanceCents: 200_00 },
        });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.processed).toBe(1);

        const payout = await prisma.payout.findFirst({ where: { affiliateId: a.id } });
        expect(payout?.status).toBe('PROCESSING');
        expect(payout?.method).toBe('USDT_ONCHAIN');
        expect(payout?.txStatus).toBe('queued');
        expect(payout?.providerTaskId).toMatch(/^stub-/);

        const aAfter = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aAfter?.balanceCents).toBe(0); // zeroed up front
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
        await prisma.affiliate.update({
            where: { id: a.id },
            data: { balanceCents: 50_00 },
        });

        const res = await autoPayouts(makeAdminRequest(admin.id));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.processed).toBe(0);
        const skipped = body.results.find((r: { status: string }) => r.status === 'SKIPPED');
        expect(skipped).toBeDefined();
        expect(skipped.error).toMatch(/walletAddress/);

        // Balance untouched.
        const aAfter = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aAfter?.balanceCents).toBe(50_00);

        const payouts = await prisma.payout.findMany();
        expect(payouts).toHaveLength(0);
    });

    it('rejects when CRYPTO program has non-USDT currency', async () => {
        // Force-set a CRYPTO program with the wrong currency by bypassing
        // the settings-route validators (programSettings.update directly).
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
        await prisma.affiliate.update({
            where: { id: a.id },
            data: { balanceCents: 100_00 },
        });

        const res = await autoPayouts(makeAdminRequest(admin.id, { dryRun: true }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.dryRun).toBe(true);
        expect(body.totalAffiliates).toBe(1);
        expect(body.totalAmountCents).toBe(100_00);

        // No payouts created.
        const payouts = await prisma.payout.findMany();
        expect(payouts).toHaveLength(0);
        // Balance unchanged.
        const aAfter = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aAfter?.balanceCents).toBe(100_00);
    });
});
