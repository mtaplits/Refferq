import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

async function verifyAffiliate(request: NextRequest) {
    const userId = request.headers.get('x-user-id');
    if (!userId) return { error: 'Unauthorized', status: 401 as const };
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { affiliate: true },
    });
    if (!user || user.status !== 'ACTIVE') {
        return { error: 'Forbidden', status: 403 as const };
    }
    if (!user.affiliate) {
        return { error: 'No affiliate profile', status: 403 as const };
    }
    return { user, affiliate: user.affiliate };
}

export async function GET(request: NextRequest) {
    const auth = await verifyAffiliate(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const earnings = await prisma.creditEarning.findMany({
        where: { affiliateId: auth.affiliate.id },
        include: {
            bucket: {
                select: {
                    id: true,
                    name: true,
                    description: true,
                    creditType: true,
                    externalSaasName: true,
                    externalSaasUrl: true,
                },
            },
        },
        orderBy: { earnedAt: 'desc' },
    });
    return NextResponse.json({ earnings });
}
