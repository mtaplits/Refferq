import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as conversionWebhook } from '@/app/api/webhook/conversion/route';
import { POST as registerRoute } from '@/app/api/auth/register/route';
import {
    createApiKey,
    createCommissionRule,
    createProgramSettings,
    createUser,
    seedReferralChain,
} from './fixtures';

/**
 * Make a NextRequest-shaped object that the route handlers accept. The
 * webhook routes only touch `headers`, `text()`, and `json()` on the
 * request, so a plain Request constructor works.
 */
function makeRequest(url: string, init: RequestInit & { body?: string }): import('next/server').NextRequest {
    return new Request(url, init) as unknown as import('next/server').NextRequest;
}

describe('MLM attribution (Feature D)', () => {
    it('walks the upline chain ADDITIVE-mode and credits all 3 levels', async () => {
        const { A, B, C } = await seedReferralChain();
        await createProgramSettings({
            currency: 'USD',
            treasuryType: 'FIAT',
            mlmEnabled: true,
            mlmMaxLevels: 3,
            mlmCommissionMode: 'ADDITIVE',
        });
        await createCommissionRule({ value: 10, level: 1, isDefault: true });
        await createCommissionRule({ value: 5, level: 2, isDefault: true });
        await createCommissionRule({ value: 2, level: 3, isDefault: true });

        const { rawKey } = await createApiKey(A.user);

        const req = makeRequest('http://localhost/api/webhook/conversion', {
            method: 'POST',
            headers: {
                'x-api-key': rawKey,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                event_type: 'PURCHASE',
                amount_cents: 10_000, // $100
                currency: 'USD',
                customer_email: 'buyer@example.com',
                referral_code: C.affiliate.referralCode,
            }),
        });
        const res = await conversionWebhook(req);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.attributed).toBe(true);

        const commissions = await prisma.commission.findMany({ orderBy: { level: 'asc' } });
        expect(commissions).toHaveLength(3);

        const [l1, l2, l3] = commissions;

        // Level 1 — direct affiliate is C, rate 10%, source is null.
        expect(l1.level).toBe(1);
        expect(l1.affiliateId).toBe(C.affiliate.id);
        expect(l1.rate).toBe(10);
        expect(l1.amountCents).toBe(1000); // 10% of $100
        expect(l1.sourceAffiliateId).toBeNull();

        // Level 2 — B gets 5%, source points back to C.
        expect(l2.level).toBe(2);
        expect(l2.affiliateId).toBe(B.affiliate.id);
        expect(l2.rate).toBe(5);
        expect(l2.amountCents).toBe(500);
        expect(l2.sourceAffiliateId).toBe(C.affiliate.id);

        // Level 3 — A gets 2%, source points back to C.
        expect(l3.level).toBe(3);
        expect(l3.affiliateId).toBe(A.affiliate.id);
        expect(l3.rate).toBe(2);
        expect(l3.amountCents).toBe(200);
        expect(l3.sourceAffiliateId).toBe(C.affiliate.id);
    });

    it('stops at mlmMaxLevels even if the chain is longer', async () => {
        const { A, B, C } = await seedReferralChain();
        await createProgramSettings({
            mlmEnabled: true,
            mlmMaxLevels: 2, // cap
            mlmCommissionMode: 'ADDITIVE',
            currency: 'USD',
        });
        await createCommissionRule({ value: 15, level: 1, isDefault: true });

        const { rawKey } = await createApiKey(A.user);
        const req = makeRequest('http://localhost/api/webhook/conversion', {
            method: 'POST',
            headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
            body: JSON.stringify({
                event_type: 'PURCHASE',
                amount_cents: 10_000,
                currency: 'USD',
                customer_email: 'buyer@example.com',
                referral_code: C.affiliate.referralCode,
            }),
        });
        await conversionWebhook(req);

        const commissions = await prisma.commission.findMany({ orderBy: { level: 'asc' } });
        expect(commissions).toHaveLength(2);
        expect(commissions.map((c) => c.affiliateId)).toEqual([C.affiliate.id, B.affiliate.id]);
        expect(commissions.every((c) => c.level <= 2)).toBe(true);
    });

    it('with mlmEnabled=false produces only the direct (level 1) commission', async () => {
        const { A, B, C } = await seedReferralChain();
        await createProgramSettings({
            mlmEnabled: false, // disabled
            mlmMaxLevels: 5, // ignored
            currency: 'USD',
        });
        await createCommissionRule({ value: 20, level: 1, isDefault: true });

        const { rawKey } = await createApiKey(A.user);
        const req = makeRequest('http://localhost/api/webhook/conversion', {
            method: 'POST',
            headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
            body: JSON.stringify({
                event_type: 'PURCHASE',
                amount_cents: 5_000,
                currency: 'USD',
                customer_email: 'buyer@example.com',
                referral_code: C.affiliate.referralCode,
            }),
        });
        await conversionWebhook(req);

        const commissions = await prisma.commission.findMany();
        expect(commissions).toHaveLength(1);
        expect(commissions[0].level).toBe(1);
        expect(commissions[0].affiliateId).toBe(C.affiliate.id);
        // Suppress unused-var lint on the fixture chain heads.
        void A;
        void B;
    });

    it('rejects a conversion whose currency mismatches the treasury type', async () => {
        const { A, C } = await seedReferralChain();
        await createProgramSettings({
            treasuryType: 'CRYPTO',
            currency: 'USDT',
            mlmEnabled: false,
        });
        await createCommissionRule({ value: 10, level: 1, isDefault: true });
        const { rawKey } = await createApiKey(A.user);

        const req = makeRequest('http://localhost/api/webhook/conversion', {
            method: 'POST',
            headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
            body: JSON.stringify({
                event_type: 'PURCHASE',
                amount_cents: 10_000,
                currency: 'USD', // wrong for a CRYPTO program
                customer_email: 'buyer@example.com',
                referral_code: C.affiliate.referralCode,
            }),
        });
        const res = await conversionWebhook(req);
        expect(res.status).toBe(400);
        const commissions = await prisma.commission.findMany();
        expect(commissions).toHaveLength(0);
    });
});

describe('Signup cycle protection (Feature D)', () => {
    it('wires referredById when registering with a valid referrer code', async () => {
        const u = await createUser({ name: 'Sponsor' });
        const sponsor = await prisma.affiliate.create({
            data: { userId: u.id, referralCode: 'SPONSOR-1', payoutDetails: {} },
        });

        const req = makeRequest('http://localhost/api/auth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
            body: JSON.stringify({
                email: 'new@example.com',
                name: 'New Affiliate',
                referrerCode: 'SPONSOR-1',
            }),
        });
        const res = await registerRoute(req);
        expect(res.status).toBe(200);

        const created = await prisma.affiliate.findFirst({
            where: { userId: { not: u.id } },
        });
        expect(created).not.toBeNull();
        expect(created?.referredById).toBe(sponsor.id);
    });

    it('rejects self-referral (registrant email matches referrer code owner)', async () => {
        const u = await createUser({ name: 'SelfRefer', email: 'me@example.com' });
        await prisma.affiliate.create({
            data: { userId: u.id, referralCode: 'SELF-CODE', payoutDetails: {} },
        });

        const req = makeRequest('http://localhost/api/auth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.2' },
            body: JSON.stringify({
                email: 'me@example.com',
                name: 'SelfRefer',
                referrerCode: 'SELF-CODE',
            }),
        });
        const res = await registerRoute(req);
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.message ?? body.error).toMatch(/already exists|cannot refer yourself/i);
    });

    it('rejects an invalid referrer code', async () => {
        const req = makeRequest('http://localhost/api/auth/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.3' },
            body: JSON.stringify({
                email: 'good@example.com',
                name: 'Good',
                referrerCode: 'NOT-A-REAL-CODE',
            }),
        });
        const res = await registerRoute(req);
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.message ?? body.error).toMatch(/invalid referrer/i);

        // No affiliate row should have been created.
        const affs = await prisma.affiliate.findMany();
        expect(affs).toHaveLength(0);
    });
});
