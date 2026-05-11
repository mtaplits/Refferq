import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST as recomputeRoute } from '@/app/api/admin/trust/recompute/route';
import { GET as listTrust } from '@/app/api/admin/trust/route';
import {
    createAffiliate,
    createProgramSettings,
    createUser,
} from './fixtures';

function makeAdminRequest(url: string, adminId: string, method = 'POST') {
    return new Request(url, {
        method,
        headers: { 'x-user-id': adminId, 'content-type': 'application/json' },
    }) as unknown as import('next/server').NextRequest;
}

function makeCronRequest(url: string, secret: string) {
    return new Request(url, {
        method: 'POST',
        headers: { 'x-cron-secret': secret, 'content-type': 'application/json' },
    }) as unknown as import('next/server').NextRequest;
}

async function seedApprovedCommissions(opts: { affiliateId: string; userId: string; count: number }) {
    for (let i = 0; i < opts.count; i++) {
        const conv = await prisma.conversion.create({
            data: {
                affiliateId: opts.affiliateId,
                eventType: 'PURCHASE',
                amountCents: 10_000,
                currency: 'USD',
                status: 'APPROVED',
            },
        });
        await prisma.commission.create({
            data: {
                conversionId: conv.id,
                affiliateId: opts.affiliateId,
                userId: opts.userId,
                amountCents: 1_000,
                rate: 10,
                status: 'APPROVED',
                approvedAt: new Date(),
            },
        });
    }
}

describe('Trust recompute (Feature E)', () => {
    it('per-affiliate: computes and upserts a TrustScore row', async () => {
        await createProgramSettings();
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Affiliate' });
        const a = await createAffiliate({ user: u });
        await seedApprovedCommissions({ affiliateId: a.id, userId: u.id, count: 5 });

        const res = await recomputeRoute(
            makeAdminRequest(
                `http://localhost/api/admin/trust/recompute?affiliateId=${a.id}`,
                admin.id
            )
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.result.affiliateId).toBe(a.id);
        expect(body.result.score).toBeGreaterThan(0);

        const row = await prisma.trustScore.findUnique({ where: { affiliateId: a.id } });
        expect(row).not.toBeNull();
        expect(row?.score).toBe(body.result.score);
        expect(row?.tier).toBe(body.result.tier);
    });

    it('per-affiliate: 404 for an unknown affiliate ID', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const res = await recomputeRoute(
            makeAdminRequest('http://localhost/api/admin/trust/recompute?affiliateId=nope', admin.id)
        );
        expect(res.status).toBe(404);
    });

    it('batch: recomputes everyone with approved commissions OR existing TrustScore', async () => {
        await createProgramSettings();
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const u1 = await createUser({ name: 'A' });
        const a1 = await createAffiliate({ user: u1 });
        await seedApprovedCommissions({ affiliateId: a1.id, userId: u1.id, count: 3 });

        const u2 = await createUser({ name: 'B' });
        const a2 = await createAffiliate({ user: u2 });
        // A2 has no commissions but has a pre-existing TrustScore.
        await prisma.trustScore.create({
            data: { affiliateId: a2.id, score: 100, tier: 'NEW' },
        });

        const u3 = await createUser({ name: 'C' });
        const a3 = await createAffiliate({ user: u3 });
        // A3 has neither commissions nor a TrustScore — should be skipped.
        void a3;

        const res = await recomputeRoute(
            makeAdminRequest('http://localhost/api/admin/trust/recompute', admin.id)
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.count).toBe(2);
        const recomputedIds = body.results.map((r: { affiliateId: string }) => r.affiliateId).sort();
        expect(recomputedIds).toEqual([a1.id, a2.id].sort());
    });

    it('accepts cron-secret auth', async () => {
        process.env.CRON_SECRET = 'test-cron-secret-trust';
        await createProgramSettings();
        const u = await createUser({ name: 'A' });
        const a = await createAffiliate({ user: u });
        await seedApprovedCommissions({ affiliateId: a.id, userId: u.id, count: 1 });

        const res = await recomputeRoute(
            makeCronRequest('http://localhost/api/admin/trust/recompute', 'test-cron-secret-trust')
        );
        expect(res.status).toBe(200);
    });

    it('rejects without admin or cron secret', async () => {
        const res = await recomputeRoute(
            new Request('http://localhost/api/admin/trust/recompute', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
            }) as unknown as import('next/server').NextRequest
        );
        expect(res.status).toBe(401);
    });

    it('does NOT attest when env is unset (attestation fields remain null)', async () => {
        // Ensure attestation env is not present.
        delete process.env.EAS_ATTESTER_PRIVATE_KEY;
        delete process.env.EAS_SCHEMA_UID;
        delete process.env.EAS_ATTESTATION_SALT;

        await createProgramSettings({ treasuryType: 'CRYPTO', currency: 'USDT', trustEnabled: true });
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'A' });
        const a = await createAffiliate({ user: u });
        await seedApprovedCommissions({ affiliateId: a.id, userId: u.id, count: 1 });

        await recomputeRoute(
            makeAdminRequest(`http://localhost/api/admin/trust/recompute?affiliateId=${a.id}`, admin.id)
        );

        const row = await prisma.trustScore.findUnique({ where: { affiliateId: a.id } });
        expect(row?.attestationUid).toBeNull();
        expect(row?.attestationSig).toBeNull();
    });
});

describe('GET /api/admin/trust (Feature E)', () => {
    it('lists scores in descending order with optional tier filter', async () => {
        await createProgramSettings();
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const u1 = await createUser({ name: 'Low' });
        const a1 = await createAffiliate({ user: u1 });
        await prisma.trustScore.create({ data: { affiliateId: a1.id, score: 100, tier: 'NEW' } });

        const u2 = await createUser({ name: 'High' });
        const a2 = await createAffiliate({ user: u2 });
        await prisma.trustScore.create({ data: { affiliateId: a2.id, score: 850, tier: 'ELITE' } });

        const all = await listTrust(
            new Request('http://localhost/api/admin/trust', {
                headers: { 'x-user-id': admin.id },
            }) as unknown as import('next/server').NextRequest
        );
        const body = await all.json();
        expect(body.scores).toHaveLength(2);
        expect(body.scores[0].score).toBeGreaterThan(body.scores[1].score);

        const elite = await listTrust(
            new Request('http://localhost/api/admin/trust?tier=ELITE', {
                headers: { 'x-user-id': admin.id },
            }) as unknown as import('next/server').NextRequest
        );
        const eliteBody = await elite.json();
        expect(eliteBody.scores).toHaveLength(1);
        expect(eliteBody.scores[0].tier).toBe('ELITE');
    });
});
