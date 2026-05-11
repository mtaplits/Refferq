import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import {
    GET as listBuckets,
    POST as createBucket,
} from '@/app/api/admin/credits/buckets/route';
import {
    PUT as updateBucket,
    DELETE as deleteBucket,
} from '@/app/api/admin/credits/buckets/[id]/route';
import {
    GET as listEarnings,
    POST as issueEarning,
} from '@/app/api/admin/credits/earnings/route';
import { PUT as updateEarning } from '@/app/api/admin/credits/earnings/[id]/route';
import { createAffiliate, createUser } from './fixtures';

function adminReq(url: string, adminId: string, init: RequestInit & { body?: string } = {}) {
    return new Request(url, {
        method: init.method ?? 'GET',
        headers: { 'x-user-id': adminId, 'content-type': 'application/json', ...(init.headers ?? {}) },
        body: init.body,
    }) as unknown as import('next/server').NextRequest;
}

describe('Admin credits bucket CRUD (Feature C)', () => {
    it('creates and lists buckets', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });

        const create = await createBucket(
            adminReq('http://localhost/api/admin/credits/buckets', admin.id, {
                method: 'POST',
                body: JSON.stringify({
                    name: '1 Free Month',
                    creditType: 'EXTERNAL_SAAS',
                    externalSaasName: 'Acme',
                    triggerType: 'MILESTONE_REFERRALS',
                    triggerValue: 5,
                }),
            })
        );
        expect(create.status).toBe(201);
        const created = await create.json();
        expect(created.bucket.name).toBe('1 Free Month');

        const list = await listBuckets(
            adminReq('http://localhost/api/admin/credits/buckets', admin.id)
        );
        const listBody = await list.json();
        expect(listBody.buckets).toHaveLength(1);
    });

    it('rejects EXTERNAL_SAAS without externalSaasName', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const res = await createBucket(
            adminReq('http://localhost/api/admin/credits/buckets', admin.id, {
                method: 'POST',
                body: JSON.stringify({
                    name: 'No name',
                    creditType: 'EXTERNAL_SAAS',
                    triggerType: 'MANUAL_ADMIN',
                }),
            })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/externalSaasName/);
    });

    it('rejects MILESTONE_REFERRALS without triggerValue', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const res = await createBucket(
            adminReq('http://localhost/api/admin/credits/buckets', admin.id, {
                method: 'POST',
                body: JSON.stringify({
                    name: 'No threshold',
                    creditType: 'INTERNAL_REFFERQ',
                    triggerType: 'MILESTONE_REFERRALS',
                    // missing triggerValue
                }),
            })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/triggerValue/);
    });

    it('updates an existing bucket', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const bucket = await prisma.creditBucket.create({
            data: {
                name: 'Orig',
                creditType: 'INTERNAL_REFFERQ',
                triggerType: 'MANUAL_ADMIN',
            },
        });
        const res = await updateBucket(
            adminReq(`http://localhost/api/admin/credits/buckets/${bucket.id}`, admin.id, {
                method: 'PUT',
                body: JSON.stringify({ name: 'Updated', isActive: false }),
            }),
            { params: Promise.resolve({ id: bucket.id }) }
        );
        expect(res.status).toBe(200);
        const after = await prisma.creditBucket.findUnique({ where: { id: bucket.id } });
        expect(after?.name).toBe('Updated');
        expect(after?.isActive).toBe(false);
    });

    it('deactivates instead of deleting when earnings exist', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        const bucket = await prisma.creditBucket.create({
            data: {
                name: 'Has earnings',
                creditType: 'INTERNAL_REFFERQ',
                triggerType: 'MANUAL_ADMIN',
            },
        });
        await prisma.creditEarning.create({
            data: {
                affiliateId: a.id,
                bucketId: bucket.id,
                unlockCode: 'REFQ-TEST-CODE-NEXX',
                status: 'EARNED',
            },
        });

        const res = await deleteBucket(
            adminReq(`http://localhost/api/admin/credits/buckets/${bucket.id}`, admin.id, {
                method: 'DELETE',
            }),
            { params: Promise.resolve({ id: bucket.id }) }
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.bucket.isActive).toBe(false);

        const still = await prisma.creditBucket.findUnique({ where: { id: bucket.id } });
        expect(still).not.toBeNull();
    });

    it('deletes outright when no earnings reference the bucket', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const bucket = await prisma.creditBucket.create({
            data: {
                name: 'Empty',
                creditType: 'INTERNAL_REFFERQ',
                triggerType: 'MANUAL_ADMIN',
            },
        });
        const res = await deleteBucket(
            adminReq(`http://localhost/api/admin/credits/buckets/${bucket.id}`, admin.id, {
                method: 'DELETE',
            }),
            { params: Promise.resolve({ id: bucket.id }) }
        );
        expect(res.status).toBe(200);
        const after = await prisma.creditBucket.findUnique({ where: { id: bucket.id } });
        expect(after).toBeNull();
    });
});

describe('Admin credits earnings (Feature C)', () => {
    it('manual issuance creates an EARNED row with unlock code', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        const bucket = await prisma.creditBucket.create({
            data: {
                name: 'Manual',
                creditType: 'INTERNAL_REFFERQ',
                triggerType: 'MANUAL_ADMIN',
            },
        });

        const res = await issueEarning(
            adminReq('http://localhost/api/admin/credits/earnings', admin.id, {
                method: 'POST',
                body: JSON.stringify({ affiliateId: a.id, bucketId: bucket.id }),
            })
        );
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.earning.affiliateId).toBe(a.id);
        expect(body.earning.unlockCode).toMatch(/^REFQ-/);
    });

    it('rejects manual issuance against a milestone bucket', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        const bucket = await prisma.creditBucket.create({
            data: {
                name: 'Milestone-only',
                creditType: 'INTERNAL_REFFERQ',
                triggerType: 'MILESTONE_REFERRALS',
                triggerValue: 10,
            },
        });

        const res = await issueEarning(
            adminReq('http://localhost/api/admin/credits/earnings', admin.id, {
                method: 'POST',
                body: JSON.stringify({ affiliateId: a.id, bucketId: bucket.id }),
            })
        );
        expect(res.status).toBe(400);
    });

    it('lists earnings with bucket + affiliate context', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        const bucket = await prisma.creditBucket.create({
            data: { name: 'B', creditType: 'INTERNAL_REFFERQ', triggerType: 'MANUAL_ADMIN' },
        });
        await prisma.creditEarning.create({
            data: { affiliateId: a.id, bucketId: bucket.id, unlockCode: 'REFQ-LIST-CODE-XXYY', status: 'EARNED' },
        });

        const res = await listEarnings(
            adminReq('http://localhost/api/admin/credits/earnings', admin.id)
        );
        const body = await res.json();
        expect(body.earnings).toHaveLength(1);
        expect(body.earnings[0].bucket.name).toBe('B');
        expect(body.earnings[0].affiliate.user.email).toBe(u.email);
    });

    it('updates an earning status (sets redeemedAt on REDEEMED)', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        const u = await createUser({ name: 'Earner' });
        const a = await createAffiliate({ user: u });
        const bucket = await prisma.creditBucket.create({
            data: { name: 'B', creditType: 'INTERNAL_REFFERQ', triggerType: 'MANUAL_ADMIN' },
        });
        const e = await prisma.creditEarning.create({
            data: { affiliateId: a.id, bucketId: bucket.id, unlockCode: 'REFQ-UPDT-XYZ1-2345', status: 'EARNED' },
        });

        const res = await updateEarning(
            adminReq(`http://localhost/api/admin/credits/earnings/${e.id}`, admin.id, {
                method: 'PUT',
                body: JSON.stringify({ status: 'REDEEMED' }),
            }),
            { params: Promise.resolve({ id: e.id }) }
        );
        expect(res.status).toBe(200);
        const after = await prisma.creditEarning.findUnique({ where: { id: e.id } });
        expect(after?.status).toBe('REDEEMED');
        expect(after?.redeemedAt).toBeInstanceOf(Date);
    });
});
