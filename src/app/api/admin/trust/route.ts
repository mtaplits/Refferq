import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

async function verifyAdmin(request: NextRequest) {
    const userId = request.headers.get('x-user-id');
    if (!userId) return { error: 'Unauthorized', status: 401 as const };
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'ADMIN' || user.status !== 'ACTIVE') {
        return { error: 'Forbidden', status: 403 as const };
    }
    return { user };
}

/**
 * GET /api/admin/trust — list all trust scores with affiliate context.
 *
 * The recompute endpoint at /api/admin/trust/recompute is the POST counterpart.
 */
export async function GET(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const url = new URL(request.url);
    const tier = url.searchParams.get('tier') ?? undefined;

    const scores = await prisma.trustScore.findMany({
        where: tier ? { tier: tier as 'NEW' | 'BUILDING' | 'TRUSTED' | 'ELITE' } : undefined,
        include: {
            affiliate: {
                select: {
                    id: true,
                    referralCode: true,
                    balanceCents: true,
                    user: { select: { email: true, name: true } },
                    _count: { select: { commissions: true, downline: true } },
                },
            },
        },
        orderBy: { score: 'desc' },
        take: 500,
    });

    return NextResponse.json({ scores });
}
