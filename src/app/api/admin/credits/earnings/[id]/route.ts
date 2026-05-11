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
    status: z.enum(['EARNED', 'REDEEMED', 'EXPIRED', 'REVOKED']),
    note: z.string().optional(),
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
    const data: Record<string, unknown> = { status: parsed.data.status };
    if (parsed.data.status === 'REDEEMED') data.redeemedAt = new Date();
    const earning = await prisma.creditEarning.update({ where: { id }, data });
    await logAuditAction({
        actorId: auth.user.id,
        action: 'UPDATE_CREDIT_STATUS',
        objectType: 'CREDIT_EARNING',
        objectId: id,
        payload: { newStatus: parsed.data.status, note: parsed.data.note },
    });
    return NextResponse.json({ earning });
}
