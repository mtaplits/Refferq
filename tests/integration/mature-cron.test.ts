import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as matureRoute } from '@/app/api/admin/commissions/mature/route';
import { createAffiliate, createUser } from './fixtures';

function cronReq(secret: string) {
    return new Request('http://localhost/api/admin/commissions/mature', {
        method: 'POST',
        headers: { 'x-cron-secret': secret, 'content-type': 'application/json' },
    }) as unknown as import('next/server').NextRequest;
}

describe('Mature commissions cron — edge cases (Feature C/E)', () => {
    it('returns "No commissions to mature" when nothing is pending', async () => {
        process.env.CRON_SECRET = 'test-mature-cron';
        const res = await matureRoute(cronReq('test-mature-cron'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.matured).toBe(0);
        expect(body.message).toMatch(/No commissions to mature/i);
    });

    it('skips PENDING commissions that have not yet matured', async () => {
        process.env.CRON_SECRET = 'test-mature-cron';
        const u = await createUser({ name: 'Future' });
        const a = await createAffiliate({ user: u });
        const conv = await prisma.conversion.create({
            data: { affiliateId: a.id, eventType: 'PURCHASE', amountCents: 1000, currency: 'USD' },
        });
        await prisma.commission.create({
            data: {
                conversionId: conv.id,
                affiliateId: a.id,
                userId: u.id,
                amountCents: 100,
                rate: 10,
                status: 'PENDING',
                maturesAt: new Date(Date.now() + 86_400_000), // tomorrow
            },
        });

        const res = await matureRoute(cronReq('test-mature-cron'));
        const body = await res.json();
        expect(body.matured).toBe(0);

        const c = await prisma.commission.findFirst();
        expect(c?.status).toBe('PENDING');
        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aff?.balanceCents).toBe(0);
    });

    it('matures multiple commissions for the same affiliate and credits balance once', async () => {
        process.env.CRON_SECRET = 'test-mature-cron';
        const u = await createUser({ name: 'Bulk' });
        const a = await createAffiliate({ user: u });
        const past = new Date(Date.now() - 60_000);
        for (let i = 0; i < 3; i++) {
            const conv = await prisma.conversion.create({
                data: { affiliateId: a.id, eventType: 'PURCHASE', amountCents: 1000, currency: 'USD' },
            });
            await prisma.commission.create({
                data: {
                    conversionId: conv.id,
                    affiliateId: a.id,
                    userId: u.id,
                    amountCents: 100,
                    rate: 10,
                    status: 'PENDING',
                    maturesAt: past,
                },
            });
        }

        const res = await matureRoute(cronReq('test-mature-cron'));
        const body = await res.json();
        expect(body.matured).toBe(3);
        expect(body.affiliatesUpdated).toBe(1);

        const aff = await prisma.affiliate.findUnique({ where: { id: a.id } });
        expect(aff?.balanceCents).toBe(300);

        const matured = await prisma.commission.findMany();
        expect(matured.every((c) => c.status === 'APPROVED')).toBe(true);
    });

    it('rejects without admin auth or cron secret', async () => {
        const res = await matureRoute(
            new Request('http://localhost/api/admin/commissions/mature', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
            }) as unknown as import('next/server').NextRequest
        );
        expect(res.status).toBe(401);
    });
});
