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

const updateSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    externalSaasName: z.string().nullable().optional(),
    externalSaasUrl: z.string().url().nullable().optional(),
    triggerValue: z.number().int().min(0).nullable().optional(),
    expiresAfterDays: z.number().int().min(0).nullable().optional(),
    minTrustTier: z.enum(['NEW', 'BUILDING', 'TRUSTED', 'ELITE']).nullable().optional(),
    isActive: z.boolean().optional(),
});

export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { id } = await ctx.params;
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }
    const bucket = await prisma.creditBucket.update({ where: { id }, data: parsed.data });
    await logAuditAction({
        actorId: auth.user.id,
        action: 'UPDATE_CREDIT_BUCKET',
        objectType: 'CREDIT_BUCKET',
        objectId: id,
        payload: parsed.data as Record<string, unknown>,
    });
    return NextResponse.json({ bucket });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { id } = await ctx.params;
    // Block deletion if any earnings reference this bucket; soft-deactivate instead.
    const refCount = await prisma.creditEarning.count({ where: { bucketId: id } });
    if (refCount > 0) {
        const bucket = await prisma.creditBucket.update({
            where: { id },
            data: { isActive: false },
        });
        return NextResponse.json({
            bucket,
            message: `Bucket has ${refCount} earnings — marked inactive instead of deleted.`,
        });
    }
    await prisma.creditBucket.delete({ where: { id } });
    await logAuditAction({
        actorId: auth.user.id,
        action: 'DELETE_CREDIT_BUCKET',
        objectType: 'CREDIT_BUCKET',
        objectId: id,
        payload: {},
    });
    return NextResponse.json({ success: true });
}
