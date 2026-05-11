import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { z } from 'zod';

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

const redeemSchema = z.object({
    unlockCode: z.string().min(1),
});

export async function POST(request: NextRequest) {
    const auth = await verifyAffiliate(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = redeemSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }

    const earning = await prisma.creditEarning.findUnique({
        where: { unlockCode: parsed.data.unlockCode },
        include: { bucket: true },
    });
    if (!earning) {
        return NextResponse.json({ error: 'Unlock code not found' }, { status: 404 });
    }
    if (earning.affiliateId !== auth.affiliate.id) {
        // Don't leak existence: same 404 response as unknown code.
        return NextResponse.json({ error: 'Unlock code not found' }, { status: 404 });
    }
    if (earning.status === 'REDEEMED') {
        return NextResponse.json({ error: 'Already redeemed' }, { status: 409 });
    }
    if (earning.status === 'REVOKED') {
        return NextResponse.json({ error: 'Credit has been revoked' }, { status: 409 });
    }
    if (earning.status === 'EXPIRED' || (earning.expiresAt && earning.expiresAt.getTime() < Date.now())) {
        return NextResponse.json({ error: 'Credit has expired' }, { status: 409 });
    }

    const now = new Date();
    const updated = await prisma.creditEarning.update({
        where: { id: earning.id },
        data: { status: 'REDEEMED', redeemedAt: now },
    });

    // INTERNAL_REFFERQ credits should apply a benefit (e.g. extend a plan)
    // to the affiliate's own Refferq account. This codebase doesn't currently
    // model an affiliate subscription/plan, so the actual benefit application
    // is a TODO until that model exists. EXTERNAL_SAAS credits are
    // self-attested: the affiliate copies the unlock code to a 3rd-party
    // product; we just track the redemption here.
    // TODO(refferq-plan): when an Affiliate subscription model exists, apply
    // INTERNAL_REFFERQ benefits in a transaction with this status flip.

    await logAuditAction({
        actorId: auth.user.id,
        action: 'REDEEM_CREDIT',
        objectType: 'CREDIT_EARNING',
        objectId: earning.id,
        payload: {
            unlockCode: earning.unlockCode,
            creditType: earning.bucket.creditType,
            bucketName: earning.bucket.name,
        },
    });

    return NextResponse.json({ earning: updated });
}
