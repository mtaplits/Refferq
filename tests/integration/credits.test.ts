import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as matureRoute } from '@/app/api/admin/commissions/mature/route';
import { evaluateCredits } from '@/lib/credits/evaluate';
import {
    createAffiliate,
    createProgramSettings,
    createUser,
} from './fixtures';

function makeCronRequest(url: string, cronSecret: string) {
    return new Request(url, {
        method: 'POST',
        headers: { 'x-cron-secret': cronSecret, 'content-type': 'application/json' },
    }) as unknown as import('next/server').NextRequest;
}

async function seedApprovedCommissions(affiliateId: string, userId: string, count: number) {
    // We seed PENDING commissions whose maturesAt is in the past so the cron
    // matures them. A throwaway Conversion is created per row to satisfy the FK.
    const past = new Date(Date.now() - 60 * 1000);
    for (let i = 0; i < count; i++) {
        const conv = await prisma.conversion.create({
            data: {
                affiliateId,
                eventType: 'PURCHASE',
                amountCents: 10_000,
                currency: 'USD',
                status: 'PENDING',
            },
        });
        await prisma.commission.create({
            data: {
                conversionId: conv.id,
                affiliateId,
                userId,
                amountCents: 1_000,
                rate: 10,
                status: 'PENDING',
                maturesAt: past,
            },
        });
    }
}

describe('Credit milestones (Feature C) via mature cron', () => {
    it('issues exactly one CreditEarning when a MILESTONE_REFERRALS threshold is crossed', async () => {
        process.env.CRON_SECRET = 'test-cron-secret';
        await createProgramSettings({ currency: 'USD' });

        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });

        // 5 commissions, all matured. Bucket fires at 5 approved referrals.
        await seedApprovedCommissions(a.id, u.id, 5);
        await prisma.creditBucket.create({
            data: {
                name: '1 Free Month',
                creditType: 'EXTERNAL_SAAS',
                externalSaasName: 'Acme',
                triggerType: 'MILESTONE_REFERRALS',
                triggerValue: 5,
            },
        });

        const res = await matureRoute(
            makeCronRequest('http://localhost/api/admin/commissions/mature', 'test-cron-secret')
        );
        expect(res.status).toBe(200);

        const earnings = await prisma.creditEarning.findMany();
        expect(earnings).toHaveLength(1);
        expect(earnings[0].affiliateId).toBe(a.id);
        expect(earnings[0].unlockCode).toMatch(/^REFQ-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
        expect(earnings[0].status).toBe('EARNED');
    });

    it('does not duplicate when mature runs again (idempotency)', async () => {
        process.env.CRON_SECRET = 'test-cron-secret';
        await createProgramSettings({ currency: 'USD' });
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });

        await seedApprovedCommissions(a.id, u.id, 5);
        await prisma.creditBucket.create({
            data: {
                name: '1 Free Month',
                creditType: 'EXTERNAL_SAAS',
                externalSaasName: 'Acme',
                triggerType: 'MILESTONE_REFERRALS',
                triggerValue: 5,
            },
        });

        // First run earns 1; second run should be a no-op.
        await matureRoute(makeCronRequest('http://localhost/api/admin/commissions/mature', 'test-cron-secret'));
        // The first run will have approved commissions; the second has no PENDING
        // rows to mature, but evaluateCredits is still invoked over the affiliate
        // set with matured commissions. We add a fresh PENDING (already matured)
        // to force evaluateCredits to be re-invoked.
        await seedApprovedCommissions(a.id, u.id, 1);
        await matureRoute(makeCronRequest('http://localhost/api/admin/commissions/mature', 'test-cron-secret'));

        const earnings = await prisma.creditEarning.findMany();
        expect(earnings).toHaveLength(1);
    });

    it('respects minTrustTier on credit buckets (trust gating)', async () => {
        process.env.CRON_SECRET = 'test-cron-secret';
        await createProgramSettings({ currency: 'USD', trustEnabled: true });

        const u = await createUser({ name: 'NewEarner' });
        const a = await createAffiliate({ user: u });
        // Affiliate hits the threshold but has no TrustScore row → tier defaults to NEW.
        // Bucket requires TRUSTED → should NOT fire.

        const bucket = await prisma.creditBucket.create({
            data: {
                name: 'Premium credit',
                creditType: 'EXTERNAL_SAAS',
                externalSaasName: 'Acme',
                triggerType: 'MILESTONE_REFERRALS',
                triggerValue: 1,
                minTrustTier: 'TRUSTED',
            },
        });

        // Affiliate has 1 approved commission — well above the threshold of 1.
        await prisma.conversion.create({
            data: {
                id: 'conv-1',
                affiliateId: a.id,
                eventType: 'PURCHASE',
                amountCents: 1000,
                currency: 'USD',
                status: 'APPROVED',
            },
        });
        await prisma.commission.create({
            data: {
                conversionId: 'conv-1',
                affiliateId: a.id,
                userId: u.id,
                amountCents: 100,
                rate: 10,
                status: 'APPROVED',
                approvedAt: new Date(),
            },
        });

        const result = await evaluateCredits(a.id);
        expect(result.earned).toHaveLength(0);
        expect(result.skipped.some((s) => s.bucketId === bucket.id && s.reason === 'trust_tier_below_minimum')).toBe(true);

        // Promote the affiliate to TRUSTED and re-run.
        await prisma.trustScore.create({
            data: {
                affiliateId: a.id,
                score: 600,
                tier: 'TRUSTED',
            },
        });

        const result2 = await evaluateCredits(a.id);
        expect(result2.earned).toHaveLength(1);
        expect(result2.earned[0].bucketId).toBe(bucket.id);
    });
});
