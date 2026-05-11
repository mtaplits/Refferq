import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';


async function verifyAdmin(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id');
    if (!userId) return null;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'ADMIN') return null;
    return user;
  } catch (_e) { return null; }
}

// POST - Process a refund for a transaction
// Automatically reverses associated commissions
export async function POST(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const { transactionId, reason } = await request.json();

    if (!transactionId) {
      return NextResponse.json({ success: false, error: 'Transaction ID is required' }, { status: 400 });
    }

    // Get transaction with its linked conversion + commissions. The
    // Transaction → Conversion → Commission chain is what makes refunds
    // accurate: we reverse EXACTLY the commissions this transaction
    // generated (including every MLM level), not an arbitrary commission
    // for the affiliate.
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        conversion: {
          include: { commissions: true },
        },
      },
    });

    if (!transaction) {
      return NextResponse.json({ success: false, error: 'Transaction not found' }, { status: 404 });
    }

    if (transaction.status === 'REFUNDED') {
      return NextResponse.json({ success: false, error: 'Transaction already refunded' }, { status: 400 });
    }

    const linkedCommissions = transaction.conversion?.commissions ?? [];

    const results = {
      transactionRefunded: false,
      commissionsReversed: 0,
      reversedAmountCents: 0,
      deductedAmountCents: 0,
      reversedCommissionIds: [] as string[],
      perCommission: [] as Array<{ id: string; affiliateId: string; previousStatus: string; newStatus: string; amountCents: number }>,
    };

    // 1. Mark transaction as REFUNDED
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'REFUNDED',
        description: `${transaction.description || ''} [REFUNDED: ${reason || 'No reason provided'}]`.trim(),
      },
    });
    results.transactionRefunded = true;

    // 2. Reverse each linked commission. Same per-status semantics as the
    //    public refund webhook so behavior is consistent across paths:
    //      PENDING  → CANCELLED, no balance change
    //      APPROVED → CANCELLED, decrement balance
    //      PAID     → CLAWBACK,  decrement balance (may go negative)
    for (const commission of linkedCommissions) {
      if (commission.status === 'CANCELLED' || commission.status === 'CLAWBACK') {
        results.perCommission.push({
          id: commission.id,
          affiliateId: commission.affiliateId,
          previousStatus: commission.status,
          newStatus: commission.status,
          amountCents: 0,
        });
        continue;
      }

      let newStatus: 'CANCELLED' | 'CLAWBACK' = 'CANCELLED';
      let shouldDecrement = false;

      if (commission.status === 'APPROVED') {
        newStatus = 'CANCELLED';
        shouldDecrement = true;
      } else if (commission.status === 'PAID') {
        newStatus = 'CLAWBACK';
        shouldDecrement = true;
      }

      await prisma.commission.update({
        where: { id: commission.id },
        data: {
          status: newStatus,
          clawbackNote: `Admin refund: ${reason || 'No reason provided'} (tx ${transactionId})`,
        },
      });

      if (shouldDecrement) {
        await prisma.affiliate.update({
          where: { id: commission.affiliateId },
          data: { balanceCents: { decrement: commission.amountCents } },
        });
        results.deductedAmountCents += commission.amountCents;
      }

      results.commissionsReversed += 1;
      results.reversedAmountCents += commission.amountCents;
      results.reversedCommissionIds.push(commission.id);
      results.perCommission.push({
        id: commission.id,
        affiliateId: commission.affiliateId,
        previousStatus: commission.status,
        newStatus,
        amountCents: commission.amountCents,
      });
    }

    // 3. Mark the conversion as REJECTED so downstream views/aggregations
    //    don't double-count it.
    if (transaction.conversionId) {
      await prisma.conversion.update({
        where: { id: transaction.conversionId },
        data: { status: 'REJECTED' },
      });
    }

    // 4. Create audit log
    await prisma.auditLog.create({
      data: {
        actorId: admin.id,
        action: 'TRANSACTION_REFUNDED',
        objectType: 'transaction',
        objectId: transactionId,
        payload: {
          reason: reason || 'No reason provided',
          transactionAmountCents: transaction.amountCents,
          commissionsReversed: results.commissionsReversed,
          reversedAmountCents: results.reversedAmountCents,
          deductedAmountCents: results.deductedAmountCents,
          perCommission: results.perCommission,
        },
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Refund processed successfully',
      results,
    });
  } catch (error) {
    console.error('Refund processing error:', error);
    return NextResponse.json({ success: false, error: 'Failed to process refund' }, { status: 500 });
  }
}

// GET - List refunded transactions
export async function GET(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const transactions = await prisma.transaction.findMany({
      where: { status: 'REFUNDED' },
      include: { affiliate: { include: { user: { select: { name: true, email: true } } } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return NextResponse.json({
      success: true,
      transactions,
      count: transactions.length,
    });
  } catch (error) {
    console.error('Failed to fetch refunded transactions:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch refunds' }, { status: 500 });
  }
}
