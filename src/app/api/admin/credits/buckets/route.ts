import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { z } from 'zod';

async function verifyAdmin(request: NextRequest) {
    const userId = request.headers.get('x-user-id');
    if (!userId) return { error: 'Unauthorized', status: 401 as const };
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'ADMIN' || user.status !== 'ACTIVE') {
        return { error: 'Forbidden', status: 403 as const };
    }
    return { user };
}

const bucketSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    creditType: z.enum(['INTERNAL_REFFERQ', 'EXTERNAL_SAAS']),
    externalSaasName: z.string().optional(),
    externalSaasUrl: z.string().url().optional(),
    triggerType: z.enum(['MILESTONE_REFERRALS', 'MILESTONE_EARNINGS', 'MANUAL_ADMIN']),
    triggerValue: z.number().int().min(0).nullable().optional(),
    expiresAfterDays: z.number().int().min(0).nullable().optional(),
    minTrustTier: z.enum(['NEW', 'BUILDING', 'TRUSTED', 'ELITE']).nullable().optional(),
    programId: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const buckets = await prisma.creditBucket.findMany({
        orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ buckets });
}

export async function POST(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = bucketSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }
    const data = parsed.data;
    if (data.creditType === 'EXTERNAL_SAAS' && !data.externalSaasName) {
        return NextResponse.json(
            { error: 'externalSaasName is required for EXTERNAL_SAAS credits' },
            { status: 400 }
        );
    }
    if (
        (data.triggerType === 'MILESTONE_REFERRALS' || data.triggerType === 'MILESTONE_EARNINGS') &&
        (data.triggerValue === undefined || data.triggerValue === null)
    ) {
        return NextResponse.json(
            { error: 'triggerValue is required for milestone-based buckets' },
            { status: 400 }
        );
    }
    const bucket = await prisma.creditBucket.create({ data });
    await logAuditAction({
        actorId: auth.user.id,
        action: 'CREATE_CREDIT_BUCKET',
        objectType: 'CREDIT_BUCKET',
        objectId: bucket.id,
        payload: { name: bucket.name, creditType: bucket.creditType, triggerType: bucket.triggerType },
    });
    return NextResponse.json({ bucket }, { status: 201 });
}
