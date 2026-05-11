import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { PUT as updateSettings } from '@/app/api/admin/settings/route';
import {
    createAffiliate,
    createProgramSettings,
    createUser,
} from './fixtures';

function adminPut(adminId: string, body: object) {
    return new Request('http://localhost/api/admin/settings', {
        method: 'PUT',
        headers: { 'x-user-id': adminId, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('PUT /api/admin/settings — treasury lock + cross-validation (Feature A)', () => {
    it('locks treasury switch once any Conversion row exists', async () => {
        await createProgramSettings({ treasuryType: 'FIAT', currency: 'USD' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Aff' });
        const a = await createAffiliate({ user: u });
        await prisma.conversion.create({
            data: {
                affiliateId: a.id,
                eventType: 'PURCHASE',
                amountCents: 100,
                currency: 'USD',
                status: 'PENDING',
            },
        });

        const res = await updateSettings(
            adminPut(admin.id, { treasuryType: 'CRYPTO', currency: 'USDT' })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/locked/i);

        // Settings unchanged.
        const after = await prisma.programSettings.findFirst();
        expect(after?.treasuryType).toBe('FIAT');
        expect(after?.currency).toBe('USD');
    });

    it('allows treasury switch with confirmTreasuryMigration override', async () => {
        await createProgramSettings({ treasuryType: 'FIAT', currency: 'USD' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Aff' });
        const a = await createAffiliate({ user: u });
        await prisma.conversion.create({
            data: {
                affiliateId: a.id,
                eventType: 'PURCHASE',
                amountCents: 100,
                currency: 'USD',
                status: 'PENDING',
            },
        });

        const res = await updateSettings(
            adminPut(admin.id, {
                treasuryType: 'CRYPTO',
                currency: 'USDT',
                confirmTreasuryMigration: true,
            })
        );
        expect(res.status).toBe(200);

        const after = await prisma.programSettings.findFirst();
        expect(after?.treasuryType).toBe('CRYPTO');
        expect(after?.currency).toBe('USDT');
    });

    it('rejects currency that mismatches the (new) treasury type', async () => {
        await createProgramSettings({ treasuryType: 'FIAT', currency: 'USD' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        // No conversions yet, so the treasury lock doesn't kick in. But
        // CRYPTO + USD is still invalid by the cross-validation.
        const res = await updateSettings(
            adminPut(admin.id, { treasuryType: 'CRYPTO', currency: 'USD' })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/does not match treasury/);
    });

    it('rejects currency that mismatches the (existing) treasury type when only currency is changed', async () => {
        await createProgramSettings({ treasuryType: 'FIAT', currency: 'USD' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const res = await updateSettings(adminPut(admin.id, { currency: 'USDT' }));
        expect(res.status).toBe(400);
    });

    it('partial update of unrelated fields still passes validation', async () => {
        await createProgramSettings({ treasuryType: 'CRYPTO', currency: 'USDT', productName: 'Old' });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const res = await updateSettings(adminPut(admin.id, { productName: 'New' }));
        expect(res.status).toBe(200);

        const after = await prisma.programSettings.findFirst();
        expect(after?.productName).toBe('New');
        expect(after?.treasuryType).toBe('CRYPTO');
        expect(after?.currency).toBe('USDT');
    });

    it('persists MLM and trust multiplier fields', async () => {
        await createProgramSettings();
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const res = await updateSettings(
            adminPut(admin.id, {
                mlmEnabled: true,
                mlmMaxLevels: 5,
                mlmCommissionMode: 'SPLIT_FROM_DIRECT',
                trustEnabled: true,
                trustEliteHoldPctOff: 90,
                trustEliteCommissionBoost: 3.5,
            })
        );
        expect(res.status).toBe(200);

        const after = await prisma.programSettings.findFirst();
        expect(after?.mlmEnabled).toBe(true);
        expect(after?.mlmMaxLevels).toBe(5);
        expect(after?.mlmCommissionMode).toBe('SPLIT_FROM_DIRECT');
        expect(after?.trustEliteHoldPctOff).toBe(90);
        expect(after?.trustEliteCommissionBoost).toBeCloseTo(3.5);
    });

    it('blocks unauthenticated callers', async () => {
        const res = await updateSettings(
            new Request('http://localhost/api/admin/settings', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ productName: 'X' }),
            }) as unknown as import('next/server').NextRequest
        );
        expect(res.status === 403 || res.status === 500).toBe(true);
    });
});
