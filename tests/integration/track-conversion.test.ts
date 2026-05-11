import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as trackRoute } from '@/app/api/track/conversion/route';
import { createAffiliate, createProgramSettings, createUser } from './fixtures';

async function seedIntegrationKey(): Promise<string> {
    const key = `pk_test_${Math.random().toString(36).slice(2, 12)}`;
    const u = await prisma.user.findFirst({ where: { role: 'ADMIN' } }) ?? (await createUser({ name: 'IntKey', role: 'ADMIN' }));
    await prisma.integrationSettings.create({
        data: {
            userId: u.id,
            provider: 'widget',
            publicKey: key,
            isActive: true,
        },
    });
    return key;
}

function trackReq(apiKey: string, body: object) {
    return new Request('http://localhost/api/track/conversion', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/track/conversion — currency vs treasury validation', () => {
    it('rejects USD when the program is CRYPTO', async () => {
        await createProgramSettings({ treasuryType: 'CRYPTO', currency: 'USDT' });
        const apiKey = await seedIntegrationKey();
        const u = await createUser({ name: 'Aff' });
        const a = await createAffiliate({ user: u, referralCode: 'TRK-A' });
        void a;

        const res = await trackRoute(
            trackReq(apiKey, {
                referralCode: 'TRK-A',
                customerEmail: 'b@example.com',
                amount: 100,
                currency: 'USD',
            })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/does not match.*CRYPTO/);

        const conversions = await prisma.conversion.findMany();
        expect(conversions).toHaveLength(0);
    });

    it('accepts USDT when the program is CRYPTO', async () => {
        await createProgramSettings({ treasuryType: 'CRYPTO', currency: 'USDT' });
        const apiKey = await seedIntegrationKey();
        const u = await createUser({ name: 'Aff' });
        await createAffiliate({ user: u, referralCode: 'TRK-OK' });

        const res = await trackRoute(
            trackReq(apiKey, {
                referralCode: 'TRK-OK',
                customerEmail: 'b@example.com',
                amount: 50,
                currency: 'USDT',
            })
        );
        expect(res.status).toBe(200);
        const conv = await prisma.conversion.findFirst();
        expect(conv?.currency).toBe('USDT');
        expect(conv?.amountCents).toBe(5000);
    });

    it('falls back to program currency when none is provided', async () => {
        await createProgramSettings({ treasuryType: 'FIAT', currency: 'INR' });
        const apiKey = await seedIntegrationKey();
        const u = await createUser({ name: 'Aff' });
        await createAffiliate({ user: u, referralCode: 'TRK-FB' });

        const res = await trackRoute(
            trackReq(apiKey, {
                referralCode: 'TRK-FB',
                customerEmail: 'b@example.com',
                amount: 75,
                // currency omitted
            })
        );
        expect(res.status).toBe(200);
        const conv = await prisma.conversion.findFirst();
        expect(conv?.currency).toBe('INR');
    });
});
