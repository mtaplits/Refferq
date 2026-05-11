import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { GET as redirectRoute } from '@/app/r/[code]/route';
import { createAffiliate, createUser } from './fixtures';

function clickReq(code: string, target?: string) {
    const url = target
        ? `http://localhost/r/${code}?dest=${encodeURIComponent(target)}`
        : `http://localhost/r/${code}`;
    return new Request(url, {
        method: 'GET',
        headers: {
            'x-forwarded-for': '1.2.3.4',
            'user-agent': 'integration-test',
        },
    }) as unknown as import('next/server').NextRequest;
}

describe('GET /r/[code] — click bucket reuse', () => {
    it('multiple clicks reuse a single click-bucket Referral row', async () => {
        const u = await createUser({ name: 'Aff' });
        const a = await createAffiliate({ user: u, referralCode: 'CLICK-CODE' });

        // Five clicks from this code.
        for (let i = 0; i < 5; i++) {
            await redirectRoute(clickReq('CLICK-CODE'), {
                params: Promise.resolve({ code: 'CLICK-CODE' }),
            });
        }

        // ReferralClick gets one row per click — that's the right granularity.
        const clicks = await prisma.referralClick.findMany();
        expect(clicks).toHaveLength(5);

        // Referrals gets exactly one row (the click bucket), NOT five.
        const referrals = await prisma.referral.findMany();
        expect(referrals).toHaveLength(1);
        expect(referrals[0].affiliateId).toBe(a.id);
        expect(referrals[0].leadEmail).toMatch(/^__clicks__@CLICK-CODE\./);
        expect(referrals[0].leadName).toBe('Click Bucket');

        // All clicks attach to that one bucket.
        expect(clicks.every((c) => c.referralId === referrals[0].id)).toBe(true);
    });

    it('different affiliates each get their own click bucket', async () => {
        const u1 = await createUser({ name: 'A' });
        await createAffiliate({ user: u1, referralCode: 'A-CODE' });
        const u2 = await createUser({ name: 'B' });
        await createAffiliate({ user: u2, referralCode: 'B-CODE' });

        await redirectRoute(clickReq('A-CODE'), { params: Promise.resolve({ code: 'A-CODE' }) });
        await redirectRoute(clickReq('A-CODE'), { params: Promise.resolve({ code: 'A-CODE' }) });
        await redirectRoute(clickReq('B-CODE'), { params: Promise.resolve({ code: 'B-CODE' }) });

        const referrals = await prisma.referral.findMany();
        expect(referrals).toHaveLength(2);
        // Two click-buckets, one per affiliate.
        expect(new Set(referrals.map((r) => r.leadEmail)).size).toBe(2);
    });

    it('does not create a click-bucket for unknown referral codes', async () => {
        // The route redirects but should not pollute Referrals for codes
        // that don't resolve to a real affiliate.
        const res = await redirectRoute(clickReq('NONEXISTENT'), {
            params: Promise.resolve({ code: 'NONEXISTENT' }),
        });
        // It returns a redirect (3xx) to the fallback URL.
        expect([301, 302, 303, 307, 308]).toContain(res.status);

        const referrals = await prisma.referral.findMany();
        expect(referrals).toHaveLength(0);
    });
});
