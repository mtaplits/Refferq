import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { issueManualCredit } from '@/lib/credits/evaluate';
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

const issueSchema = z.object({
    affiliateId: z.string().min(1),
    bucketId: z.string().min(1),
    triggerNote: z.string().optional(),
});

export async function GET(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const url = new URL(request.url);
    const affiliateId = url.searchParams.get('affiliateId') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const bucketId = url.searchParams.get('bucketId') ?? undefined;

    const earnings = await prisma.creditEarning.findMany({
        where: {
            ...(affiliateId ? { affiliateId } : {}),
            ...(status ? { status: status as 'EARNED' | 'REDEEMED' | 'EXPIRED' | 'REVOKED' } : {}),
            ...(bucketId ? { bucketId } : {}),
        },
        include: {
            bucket: { select: { id: true, name: true, creditType: true, externalSaasName: true } },
            affiliate: { select: { id: true, referralCode: true, user: { select: { email: true, name: true } } } },
        },
        orderBy: { earnedAt: 'desc' },
        take: 500,
    });
    return NextResponse.json({ earnings });
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
    const parsed = issueSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }
    try {
        const earning = await issueManualCredit(parsed.data);
        await logAuditAction({
            actorId: auth.user.id,
            action: 'ISSUE_CREDIT',
            objectType: 'CREDIT_EARNING',
            objectId: earning.id,
            payload: { affiliateId: earning.affiliateId, bucketId: earning.bucketId, unlockCode: earning.unlockCode },
        });
        return NextResponse.json({ earning }, { status: 201 });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to issue credit' },
            { status: 400 }
        );
    }
}
