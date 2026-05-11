import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as refundWebhook } from '@/app/api/webhook/refund/route';
import { POST as adminRefund } from '@/app/api/admin/refunds/route';
import {
    createAffiliate,
    createApiKey,
    createProgramSettings,
    createUser,
} from './fixtures';

function webhookReq(body: object, opts: { apiKey?: string; signature?: string; secret?: string } = {}) {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
    if (opts.signature) headers['x-webhook-signature'] = opts.signature;
    if (opts.secret && !opts.signature) {
        const sig = crypto.createHmac('sha256', opts.secret).update(raw).digest('hex');
        headers['x-webhook-signature'] = `sha256=${sig}`;
    }
    return new Request('http://localhost/api/webhook/refund', {
        method: 'POST',
        headers,
        body: raw,
    }) as unknown as import('next/server').NextRequest;
}

async function createConversionWithCommissions(opts: {
    affiliateId: string;
    userId: string;
    customerEmail: string;
    commissionCount?: number;
    commissionStatus?: 'PENDING' | 'APPROVED' | 'PAID';
    commissionAmountCents?: number;
}) {
    const conv = await prisma.conversion.create({
        data: {
            affiliateId: opts.affiliateId,
            eventType: 'PURCHASE',
            amountCents: 10_000,
            currency: 'USD',
            eventMetadata: { customerEmail: opts.customerEmail },
        },
    });
    const cs = [];
    for (let i = 0; i < (opts.commissionCount ?? 1); i++) {
        const c = await prisma.commission.create({
            data: {
                conversionId: conv.id,
                affiliateId: opts.affiliateId,
                userId: opts.userId,
                amountCents: opts.commissionAmountCents ?? 1_000,
                rate: 10,
                status: opts.commissionStatus ?? 'APPROVED',
                approvedAt: opts.commissionStatus !== 'PENDING' ? new Date() : null,
                paidAt: opts.commissionStatus === 'PAID' ? new Date() : null,
            },
        });
        cs.push(c);
    }
    return { conversion: conv, commissions: cs };
}

describe('POST /api/webhook/refund (clawback)', () => {
    it('cancels PENDING commissions without touching balance', async () => {
        await createProgramSettings();
        const u = await createUser({ name: 'Owner' });
        const a = await createAffiliate({ user: u });
        const { rawKey } = await createApiKey(u);
        await createConversionWithCommissions({
            affiliateId: a.id,
            userId: u.id,
            customerEmail: 'buyer@example.com',
            commissionStatus: 'PENDING',
        });

        const res = await refundWebhook(
            webhookReq(
                { customer_email: 'buyer@example.com', amount_cents: 10_000, reason: 'unhappy' },
                { apiKey: rawKey }
            )
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reversed).toBe(1);

        const c = await prisma.commission.findFirst();
        expect(c?.status).toBe('CANCELLED');
        expect(c?.clawbackNote).toMatch(/unhappy/);

        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aff?.balanceCents).toBe(0); // never went up, never deducted
    });

    it('APPROVED commission: clawback decrements balance', async () => {
        await createProgramSettings();
        const u = await createUser({ name: 'Owner' });
        const a = await createAffiliate({ user: u });
        await prisma.affiliate.update({ where: { id: a.id }, data: { balanceCents: 5_000 } });
        const { rawKey } = await createApiKey(u);
        await createConversionWithCommissions({
            affiliateId: a.id,
            userId: u.id,
            customerEmail: 'buyer@example.com',
            commissionStatus: 'APPROVED',
        });

        await refundWebhook(
            webhookReq(
                { customer_email: 'buyer@example.com', amount_cents: 10_000 },
                { apiKey: rawKey }
            )
        );

        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        // Balance was 5000, commission was 1000 → after clawback: 4000.
        expect(aff?.balanceCents).toBe(4_000);
        const c = await prisma.commission.findFirst();
        expect(c?.status).toBe('CANCELLED');
    });

    it('PAID commission: flips to CLAWBACK and deducts balance (negative allowed)', async () => {
        await createProgramSettings();
        const u = await createUser({ name: 'Owner' });
        const a = await createAffiliate({ user: u });
        // Balance is 0 (already paid out). Clawback should create negative balance.
        const { rawKey } = await createApiKey(u);
        await createConversionWithCommissions({
            affiliateId: a.id,
            userId: u.id,
            customerEmail: 'buyer@example.com',
            commissionStatus: 'PAID',
        });

        await refundWebhook(
            webhookReq(
                { customer_email: 'buyer@example.com', amount_cents: 10_000 },
                { apiKey: rawKey }
            )
        );

        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aff?.balanceCents).toBe(-1_000); // offset against next payout
        const c = await prisma.commission.findFirst();
        expect(c?.status).toBe('CLAWBACK');
    });

    it('MLM: reverses ALL commissions for the conversion (every upline level)', async () => {
        await createProgramSettings({ mlmEnabled: true, mlmMaxLevels: 3, mlmCommissionMode: 'ADDITIVE' });
        const u1 = await createUser({ name: 'Lvl1' });
        const a1 = await createAffiliate({ user: u1, referralCode: 'L1-CODE' });
        const u2 = await createUser({ name: 'Lvl2' });
        const a2 = await createAffiliate({ user: u2, referredById: a1.id });
        const u3 = await createUser({ name: 'Lvl3' });
        const a3 = await createAffiliate({ user: u3, referredById: a2.id });

        // Seed balances representing the chain having been credited.
        await prisma.affiliate.update({ where: { id: a1.id }, data: { balanceCents: 500 } });
        await prisma.affiliate.update({ where: { id: a2.id }, data: { balanceCents: 500 } });
        await prisma.affiliate.update({ where: { id: a3.id }, data: { balanceCents: 1_000 } });

        // One conversion with three commissions (one per level).
        const conv = await prisma.conversion.create({
            data: {
                affiliateId: a3.id,
                eventType: 'PURCHASE',
                amountCents: 10_000,
                currency: 'USD',
                eventMetadata: { customerEmail: 'buyer@example.com' },
            },
        });
        await prisma.commission.create({
            data: {
                conversionId: conv.id, affiliateId: a3.id, userId: u3.id,
                amountCents: 1_000, rate: 10, level: 1, status: 'APPROVED', approvedAt: new Date(),
            },
        });
        await prisma.commission.create({
            data: {
                conversionId: conv.id, affiliateId: a2.id, userId: u2.id, sourceAffiliateId: a3.id,
                amountCents: 500, rate: 5, level: 2, status: 'APPROVED', approvedAt: new Date(),
            },
        });
        await prisma.commission.create({
            data: {
                conversionId: conv.id, affiliateId: a1.id, userId: u1.id, sourceAffiliateId: a3.id,
                amountCents: 500, rate: 5, level: 3, status: 'APPROVED', approvedAt: new Date(),
            },
        });

        const { rawKey } = await createApiKey(u1);
        const res = await refundWebhook(
            webhookReq(
                { customer_email: 'buyer@example.com', amount_cents: 10_000 },
                { apiKey: rawKey }
            )
        );
        const body = await res.json();
        expect(body.reversed).toBe(3); // all 3 levels reversed

        const aff1 = await prisma.affiliate.findUnique({ where: { id: a1.id } });
        const aff2 = await prisma.affiliate.findUnique({ where: { id: a2.id } });
        const aff3 = await prisma.affiliate.findUnique({ where: { id: a3.id } });
        expect(aff1?.balanceCents).toBe(0);
        expect(aff2?.balanceCents).toBe(0);
        expect(aff3?.balanceCents).toBe(0);

        const conversionAfter = await prisma.conversion.findUnique({ where: { id: conv.id } });
        expect(conversionAfter?.status).toBe('REJECTED');
    });

    it('idempotency: re-runs do not double-deduct', async () => {
        await createProgramSettings();
        const u = await createUser({ name: 'Owner' });
        const a = await createAffiliate({ user: u });
        await prisma.affiliate.update({ where: { id: a.id }, data: { balanceCents: 5_000 } });
        const { rawKey } = await createApiKey(u);
        await createConversionWithCommissions({
            affiliateId: a.id,
            userId: u.id,
            customerEmail: 'buyer@example.com',
            commissionStatus: 'APPROVED',
        });

        await refundWebhook(webhookReq({ customer_email: 'buyer@example.com', amount_cents: 10_000 }, { apiKey: rawKey }));
        await refundWebhook(webhookReq({ customer_email: 'buyer@example.com', amount_cents: 10_000 }, { apiKey: rawKey }));

        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        // Decrement happens once; second call sees CANCELLED and skips.
        expect(aff?.balanceCents).toBe(4_000);
    });

    it('rejects calls without API key or webhook signature', async () => {
        const res = await refundWebhook(webhookReq({ customer_email: 'x@y.com' }));
        expect(res.status).toBe(401);
    });

    it('accepts a valid HMAC signature when WEBHOOK_SECRET is set', async () => {
        process.env.WEBHOOK_SECRET = 'test-webhook-secret-refund';
        await createProgramSettings();
        const u = await createUser({ name: 'Owner' });
        const a = await createAffiliate({ user: u });
        await prisma.affiliate.update({ where: { id: a.id }, data: { balanceCents: 5_000 } });
        await createConversionWithCommissions({
            affiliateId: a.id,
            userId: u.id,
            customerEmail: 'sig@example.com',
            commissionStatus: 'APPROVED',
        });

        const res = await refundWebhook(
            webhookReq(
                { customer_email: 'sig@example.com', amount_cents: 10_000 },
                { secret: 'test-webhook-secret-refund' }
            )
        );
        expect(res.status).toBe(200);
        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aff?.balanceCents).toBe(4_000);

        // Cleanup so other tests aren't affected.
        delete process.env.WEBHOOK_SECRET;
    });

    it('returns success with reversed:0 when no matching conversion', async () => {
        const u = await createUser({ name: 'Owner' });
        const { rawKey } = await createApiKey(u);
        const res = await refundWebhook(
            webhookReq({ customer_email: 'nobody@example.com', amount_cents: 10_000 }, { apiKey: rawKey })
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.reversed).toBe(0);
    });
});

describe('POST /api/admin/refunds (manual admin refund)', () => {
    it('refunds a transaction and reverses ONLY its linked commissions', async () => {
        await createProgramSettings();
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Aff' });
        const a = await createAffiliate({ user: u });
        await prisma.affiliate.update({ where: { id: a.id }, data: { balanceCents: 10_000 } });

        // Build the proper Transaction → Conversion → Commission chain.
        const ref = await prisma.referral.create({
            data: { affiliateId: a.id, leadName: 'L', leadEmail: 'l@example.com' },
        });
        const conv = await prisma.conversion.create({
            data: { affiliateId: a.id, eventType: 'PURCHASE', amountCents: 10_000, currency: 'USD', status: 'APPROVED' },
        });
        const c = await prisma.commission.create({
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

        // ALSO seed an UNRELATED conversion + commission for the same affiliate
        // — the old code would have picked an arbitrary one and reversed it.
        // The new code must NOT touch this.
        const otherConv = await prisma.conversion.create({
            data: { affiliateId: a.id, eventType: 'PURCHASE', amountCents: 5_000, currency: 'USD', status: 'APPROVED' },
        });
        const otherCommission = await prisma.commission.create({
            data: {
                conversionId: otherConv.id,
                affiliateId: a.id,
                userId: u.id,
                amountCents: 500,
                rate: 10,
                status: 'APPROVED',
                approvedAt: new Date(),
            },
        });

        const tx = await prisma.transaction.create({
            data: {
                referralId: ref.id,
                affiliateId: a.id,
                conversionId: conv.id, // <-- the FK that pins this to the right commission
                customerName: 'C',
                customerEmail: 'c@example.com',
                amountCents: 10_000,
                commissionCents: 1_000,
                commissionRate: 0.1,
                status: 'COMPLETED',
                createdBy: admin.id,
            },
        });

        const res = await adminRefund(
            new Request('http://localhost/api/admin/refunds', {
                method: 'POST',
                headers: { 'x-user-id': admin.id, 'content-type': 'application/json' },
                body: JSON.stringify({ transactionId: tx.id, reason: 'customer asked' }),
            }) as unknown as import('next/server').NextRequest
        );
        expect(res.status).toBe(200);

        const txAfter = await prisma.transaction.findUnique({ where: { id: tx.id } });
        expect(txAfter?.status).toBe('REFUNDED');
        expect(txAfter?.description).toMatch(/REFUNDED/);

        const cAfter = await prisma.commission.findUnique({ where: { id: c.id } });
        expect(cAfter?.status).toBe('CANCELLED');

        // Unrelated commission stayed APPROVED.
        const otherAfter = await prisma.commission.findUnique({ where: { id: otherCommission.id } });
        expect(otherAfter?.status).toBe('APPROVED');

        // Balance decremented by exactly 1_000 (the linked commission), not 500.
        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aff?.balanceCents).toBe(9_000);

        // Conversion flipped to REJECTED.
        const convAfter = await prisma.conversion.findUnique({ where: { id: conv.id } });
        expect(convAfter?.status).toBe('REJECTED');
    });

    it('reverses ALL MLM-level commissions for a linked conversion', async () => {
        await createProgramSettings({ mlmEnabled: true, mlmMaxLevels: 3 });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u1 = await createUser({ name: 'L1' });
        const a1 = await createAffiliate({ user: u1 });
        const u2 = await createUser({ name: 'L2' });
        const a2 = await createAffiliate({ user: u2, referredById: a1.id });
        const u3 = await createUser({ name: 'L3-direct' });
        const a3 = await createAffiliate({ user: u3, referredById: a2.id });

        await prisma.affiliate.update({ where: { id: a1.id }, data: { balanceCents: 200 } });
        await prisma.affiliate.update({ where: { id: a2.id }, data: { balanceCents: 500 } });
        await prisma.affiliate.update({ where: { id: a3.id }, data: { balanceCents: 1_000 } });

        const ref = await prisma.referral.create({
            data: { affiliateId: a3.id, leadName: 'L', leadEmail: 'l@example.com' },
        });
        const conv = await prisma.conversion.create({
            data: { affiliateId: a3.id, eventType: 'PURCHASE', amountCents: 10_000, currency: 'USD', status: 'APPROVED' },
        });
        // 3 commissions, one per level.
        await prisma.commission.create({ data: { conversionId: conv.id, affiliateId: a3.id, userId: u3.id, amountCents: 1_000, rate: 10, level: 1, status: 'APPROVED', approvedAt: new Date() } });
        await prisma.commission.create({ data: { conversionId: conv.id, affiliateId: a2.id, userId: u2.id, sourceAffiliateId: a3.id, amountCents: 500, rate: 5, level: 2, status: 'APPROVED', approvedAt: new Date() } });
        await prisma.commission.create({ data: { conversionId: conv.id, affiliateId: a1.id, userId: u1.id, sourceAffiliateId: a3.id, amountCents: 200, rate: 2, level: 3, status: 'APPROVED', approvedAt: new Date() } });

        const tx = await prisma.transaction.create({
            data: {
                referralId: ref.id,
                affiliateId: a3.id,
                conversionId: conv.id,
                customerName: 'C',
                customerEmail: 'c@example.com',
                amountCents: 10_000,
                commissionCents: 1_000,
                commissionRate: 0.1,
                status: 'COMPLETED',
                createdBy: admin.id,
            },
        });

        await adminRefund(
            new Request('http://localhost/api/admin/refunds', {
                method: 'POST',
                headers: { 'x-user-id': admin.id, 'content-type': 'application/json' },
                body: JSON.stringify({ transactionId: tx.id }),
            }) as unknown as import('next/server').NextRequest
        );

        // All three commissions CANCELLED.
        const all = await prisma.commission.findMany({ where: { conversionId: conv.id } });
        expect(all.every((c) => c.status === 'CANCELLED')).toBe(true);

        // Each upline's balance decremented by their own commission amount.
        const aff1 = await prisma.affiliate.findUnique({ where: { id: a1.id } });
        const aff2 = await prisma.affiliate.findUnique({ where: { id: a2.id } });
        const aff3 = await prisma.affiliate.findUnique({ where: { id: a3.id } });
        expect(aff1?.balanceCents).toBe(0);
        expect(aff2?.balanceCents).toBe(0);
        expect(aff3?.balanceCents).toBe(0);
    });

    it('refuses to double-refund the same transaction', async () => {
        await createProgramSettings();
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Aff' });
        const a = await createAffiliate({ user: u });
        const ref = await prisma.referral.create({
            data: { affiliateId: a.id, leadName: 'L', leadEmail: 'l@example.com' },
        });
        const tx = await prisma.transaction.create({
            data: {
                referralId: ref.id,
                affiliateId: a.id,
                customerName: 'C',
                customerEmail: 'c@example.com',
                amountCents: 10_000,
                commissionCents: 1_000,
                commissionRate: 0.1,
                status: 'REFUNDED',
                createdBy: admin.id,
            },
        });

        const res = await adminRefund(
            new Request('http://localhost/api/admin/refunds', {
                method: 'POST',
                headers: { 'x-user-id': admin.id, 'content-type': 'application/json' },
                body: JSON.stringify({ transactionId: tx.id }),
            }) as unknown as import('next/server').NextRequest
        );
        expect(res.status).toBe(400);
    });
});
