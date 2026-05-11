import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as redeemRoute } from '@/app/api/affiliate/credits/redeem/route';
import { GET as listOwn } from '@/app/api/affiliate/credits/route';
import { createAffiliate, createUser } from './fixtures';

function affiliateReq(url: string, userId: string, init: RequestInit & { body?: string } = {}) {
    return new Request(url, {
        method: init.method ?? 'GET',
        headers: { 'x-user-id': userId, 'content-type': 'application/json' },
        body: init.body,
    }) as unknown as import('next/server').NextRequest;
}

async function seedCredit(opts: {
    affiliateId: string;
    unlockCode: string;
    status?: 'EARNED' | 'REDEEMED' | 'EXPIRED' | 'REVOKED';
    expiresAt?: Date | null;
}) {
    const bucket = await prisma.creditBucket.create({
        data: {
            name: 'Test Bucket',
            creditType: 'EXTERNAL_SAAS',
            externalSaasName: 'Acme',
            triggerType: 'MANUAL_ADMIN',
        },
    });
    return prisma.creditEarning.create({
        data: {
            affiliateId: opts.affiliateId,
            bucketId: bucket.id,
            unlockCode: opts.unlockCode,
            status: opts.status ?? 'EARNED',
            expiresAt: opts.expiresAt ?? null,
        },
    });
}

describe('Affiliate credits redeem (Feature C)', () => {
    it('redeems an EARNED credit (flips to REDEEMED, sets redeemedAt)', async () => {
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        const credit = await seedCredit({ affiliateId: a.id, unlockCode: 'REFQ-RDM1-WORK-2345' });

        const res = await redeemRoute(
            affiliateReq('http://localhost/api/affiliate/credits/redeem', u.id, {
                method: 'POST',
                body: JSON.stringify({ unlockCode: 'REFQ-RDM1-WORK-2345' }),
            })
        );
        expect(res.status).toBe(200);
        const after = await prisma.creditEarning.findUnique({ where: { id: credit.id } });
        expect(after?.status).toBe('REDEEMED');
        expect(after?.redeemedAt).toBeInstanceOf(Date);
    });

    it('returns 409 when re-redeeming the same code', async () => {
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        await seedCredit({ affiliateId: a.id, unlockCode: 'REFQ-RDM2-TWICE-2345', status: 'REDEEMED' });

        const res = await redeemRoute(
            affiliateReq('http://localhost/api/affiliate/credits/redeem', u.id, {
                method: 'POST',
                body: JSON.stringify({ unlockCode: 'REFQ-RDM2-TWICE-2345' }),
            })
        );
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(String(body.error)).toMatch(/already redeemed/i);
    });

    it('returns 409 for REVOKED credits', async () => {
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        await seedCredit({ affiliateId: a.id, unlockCode: 'REFQ-RDM3-REVK-2345', status: 'REVOKED' });

        const res = await redeemRoute(
            affiliateReq('http://localhost/api/affiliate/credits/redeem', u.id, {
                method: 'POST',
                body: JSON.stringify({ unlockCode: 'REFQ-RDM3-REVK-2345' }),
            })
        );
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(String(body.error)).toMatch(/revoked/i);
    });

    it('returns 409 for expired credits (past expiresAt)', async () => {
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        await seedCredit({
            affiliateId: a.id,
            unlockCode: 'REFQ-RDM4-EXPD-2345',
            expiresAt: new Date(Date.now() - 60_000),
        });

        const res = await redeemRoute(
            affiliateReq('http://localhost/api/affiliate/credits/redeem', u.id, {
                method: 'POST',
                body: JSON.stringify({ unlockCode: 'REFQ-RDM4-EXPD-2345' }),
            })
        );
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(String(body.error)).toMatch(/expired/i);
    });

    it('returns 404 (same as unknown) when the code belongs to a different affiliate', async () => {
        const owner = await createUser({ name: 'Owner' });
        const ownerAff = await createAffiliate({ user: owner });
        const other = await createUser({ name: 'Other' });
        await createAffiliate({ user: other });
        await seedCredit({ affiliateId: ownerAff.id, unlockCode: 'REFQ-RDM5-OTHR-2345' });

        // 'other' tries to redeem owner's code.
        const res = await redeemRoute(
            affiliateReq('http://localhost/api/affiliate/credits/redeem', other.id, {
                method: 'POST',
                body: JSON.stringify({ unlockCode: 'REFQ-RDM5-OTHR-2345' }),
            })
        );
        // The route returns 404 to avoid leaking the code's existence.
        expect(res.status).toBe(404);
    });

    it('lists only the calling affiliate\'s credits', async () => {
        const u1 = await createUser({ name: 'A' });
        const a1 = await createAffiliate({ user: u1 });
        const u2 = await createUser({ name: 'B' });
        const a2 = await createAffiliate({ user: u2 });
        await seedCredit({ affiliateId: a1.id, unlockCode: 'REFQ-LIST-OWNA-2345' });
        await seedCredit({ affiliateId: a2.id, unlockCode: 'REFQ-LIST-OWNB-2345' });

        const res = await listOwn(affiliateReq('http://localhost/api/affiliate/credits', u1.id));
        const body = await res.json();
        expect(body.earnings).toHaveLength(1);
        expect(body.earnings[0].unlockCode).toBe('REFQ-LIST-OWNA-2345');
    });

    it('rejects requests without x-user-id', async () => {
        const res = await redeemRoute(
            new Request('http://localhost/api/affiliate/credits/redeem', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ unlockCode: 'REFQ-XXXX-XXXX-XXXX' }),
            }) as unknown as import('next/server').NextRequest
        );
        expect(res.status).toBe(401);
    });
});
