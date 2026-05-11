import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id')!;
    
    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        affiliate: true
      }
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 401 }
      );
    }

    if (user.role !== 'AFFILIATE') {
      return NextResponse.json(
        { error: 'Access denied. Affiliate role required.' },
        { status: 403 }
      );
    }

    if (!user.affiliate) {
      return NextResponse.json(
        { error: 'Affiliate profile not found' },
        { status: 404 }
      );
    }

    // Get payouts for this affiliate
    const payouts = await prisma.payout.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        commissions: true
      }
    });

    return NextResponse.json({
      success: true,
      payouts: payouts.map(p => ({
        id: p.id,
        amount: p.amountCents,
        status: p.status,
        method: p.method,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.processedAt?.toISOString() || null,
        txHash: p.txHash,
        onChainVerified: p.onChainVerified,
        onChainVerifiedAt: p.onChainVerifiedAt?.toISOString() || null
      }))
    });
  } catch (error) {
    console.error('Affiliate payouts API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch payouts' },
      { status: 500 }
    );
  }
}
