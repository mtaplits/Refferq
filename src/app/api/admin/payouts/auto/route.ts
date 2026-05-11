import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getProvider } from '@/lib/crypto-disbursement';


async function verifyAdmin(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id');
    if (!userId) return null;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'ADMIN') return null;
    return user;
  } catch (_e) { return null; }
}

// POST - Process auto-payouts for all eligible affiliates
export async function POST(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const { dryRun = false } = await request.json().catch(() => ({ dryRun: false }));

    // Get program settings for min payout threshold + treasury type
    const settings = await prisma.programSettings.findFirst();
    const minPayoutCents = settings?.minPayoutCents || 100000; // Default ₹1000
    const treasuryType = (settings?.treasuryType ?? 'FIAT') as 'FIAT' | 'CRYPTO';
    const isCryptoProgram = treasuryType === 'CRYPTO';

    if (isCryptoProgram && settings?.currency !== 'USDT') {
      return NextResponse.json(
        { success: false, error: 'CRYPTO programs must have currency=USDT for auto-payouts' },
        { status: 400 }
      );
    }

    // Find all affiliates with balance above minimum payout threshold
    // Status check is on User model, not Affiliate
    const eligibleAffiliates = await prisma.affiliate.findMany({
      where: {
        balanceCents: { gte: minPayoutCents },
        user: { status: 'ACTIVE' },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    if (eligibleAffiliates.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No affiliates eligible for auto-payout',
        processed: 0,
        totalAmountCents: 0,
      });
    }

    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        eligible: eligibleAffiliates.map(a => ({
          id: a.id,
          name: a.user.name,
          email: a.user.email,
          balanceCents: a.balanceCents,
        })),
        totalAffiliates: eligibleAffiliates.length,
        totalAmountCents: eligibleAffiliates.reduce((s, a) => s + a.balanceCents, 0),
      });
    }

    // Process payouts
    const results: Array<{
      affiliateId: string;
      name: string;
      payoutId?: string;
      amountCents?: number;
      status: string;
      error?: string;
    }> = [];
    let totalProcessed = 0;
    let totalAmountCents = 0;

    for (const affiliate of eligibleAffiliates) {
      try {
        // Read the unpayed APPROVED commissions — these are what the
        // affiliate's balance represents. Linking them to the payout (vs
        // just zeroing balance) eliminates the double-pay race that the
        // old "zero balance" pattern allowed.
        const approvedCommissions = await prisma.commission.findMany({
          where: {
            affiliateId: affiliate.id,
            status: 'APPROVED',
            payoutId: null,
          },
          select: { id: true, amountCents: true },
        });
        if (approvedCommissions.length === 0) {
          results.push({
            affiliateId: affiliate.id,
            name: affiliate.user.name,
            status: 'SKIPPED',
            error: 'No unlinked APPROVED commissions',
          });
          continue;
        }
        const commissionIds = approvedCommissions.map((c) => c.id);
        const payoutAmountCents = approvedCommissions.reduce(
          (s, c) => s + c.amountCents,
          0
        );
        // Re-check the threshold against the actual commission sum (the
        // earlier balanceCents filter could be stale by now).
        if (payoutAmountCents < minPayoutCents) {
          results.push({
            affiliateId: affiliate.id,
            name: affiliate.user.name,
            status: 'SKIPPED',
            error: 'Commission sum below minPayoutCents',
          });
          continue;
        }

        // ─── CRYPTO branch: validate wallet, queue with provider ───
        if (isCryptoProgram) {
          const payoutDetails = (affiliate.payoutDetails as Record<string, unknown> | null) ?? {};
          const walletAddress = typeof payoutDetails.walletAddress === 'string' ? payoutDetails.walletAddress : '';
          if (!walletAddress) {
            results.push({
              affiliateId: affiliate.id,
              name: affiliate.user.name,
              status: 'SKIPPED',
              error: 'Missing walletAddress in payoutDetails',
            });
            continue;
          }

          // Atomic invariant: link commissions to payout + decrement balance
          // by their exact sum. Commissions stay APPROVED until the SHKeeper
          // callback flips them to PAID; on provider failure we revert both.
          const payout = await prisma.payout.create({
            data: {
              affiliateId: affiliate.id,
              userId: affiliate.user.id,
              amountCents: payoutAmountCents,
              commissionCount: commissionIds.length,
              status: 'PROCESSING',
              method: 'USDT_ONCHAIN',
              notes: 'Auto-payout (crypto)',
              createdBy: admin.id,
            },
          });
          await prisma.commission.updateMany({
            where: { id: { in: commissionIds } },
            data: { payoutId: payout.id, updatedAt: new Date() },
          });
          await prisma.affiliate.update({
            where: { id: affiliate.id },
            data: { balanceCents: { decrement: payoutAmountCents } },
          });

          try {
            const provider = getProvider();
            const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || '';
            const callbackSecret = process.env.SHKEEPER_CALLBACK_SECRET || '';
            const callbackUrl = `${baseUrl}/api/webhook/payout-status${callbackSecret ? `?secret=${encodeURIComponent(callbackSecret)}` : ''}`;
            const sendResult = await provider.send({
              toAddress: walletAddress,
              amountCents: payoutAmountCents,
              payoutId: payout.id,
              callbackUrl,
            });

            if (sendResult.status === 'failed') {
              // Refund: unlink commissions and re-credit balance.
              await prisma.commission.updateMany({
                where: { payoutId: payout.id },
                data: { payoutId: null, updatedAt: new Date() },
              });
              await prisma.affiliate.update({
                where: { id: affiliate.id },
                data: { balanceCents: { increment: payoutAmountCents } },
              });
              await prisma.payout.update({
                where: { id: payout.id },
                data: {
                  status: 'FAILED',
                  txStatus: 'failed',
                  providerError: sendResult.error ?? 'provider rejected',
                },
              });
              results.push({
                affiliateId: affiliate.id,
                name: affiliate.user.name,
                payoutId: payout.id,
                status: 'FAILED',
                error: sendResult.error,
              });
              continue;
            }

            await prisma.payout.update({
              where: { id: payout.id },
              data: {
                providerTaskId: sendResult.taskId,
                txStatus: sendResult.status,
              },
            });
          } catch (cryptoErr) {
            // Same refund path as a rejected provider response.
            await prisma.commission.updateMany({
              where: { payoutId: payout.id },
              data: { payoutId: null, updatedAt: new Date() },
            });
            await prisma.affiliate.update({
              where: { id: affiliate.id },
              data: { balanceCents: { increment: payoutAmountCents } },
            });
            await prisma.payout.update({
              where: { id: payout.id },
              data: {
                status: 'FAILED',
                txStatus: 'failed',
                providerError: cryptoErr instanceof Error ? cryptoErr.message : String(cryptoErr),
              },
            });
            results.push({
              affiliateId: affiliate.id,
              name: affiliate.user.name,
              payoutId: payout.id,
              status: 'FAILED',
              error: cryptoErr instanceof Error ? cryptoErr.message : String(cryptoErr),
            });
            continue;
          }

          await prisma.auditLog.create({
            data: {
              action: 'AUTO_PAYOUT_CRYPTO_QUEUED',
              actorId: admin.id,
              objectType: 'payout',
              objectId: payout.id,
              payload: { affiliateId: affiliate.id, amountCents: payoutAmountCents, commissionCount: commissionIds.length },
            },
          });
          results.push({
            affiliateId: affiliate.id,
            name: affiliate.user.name,
            payoutId: payout.id,
            amountCents: payoutAmountCents,
            status: 'QUEUED',
          });
          totalProcessed++;
          totalAmountCents += payoutAmountCents;
          continue;
        }

        // ─── FIAT branch: link commissions, mark PAID, decrement balance ───
        const payout = await prisma.payout.create({
          data: {
            affiliateId: affiliate.id,
            userId: affiliate.user.id,
            amountCents: payoutAmountCents,
            commissionCount: commissionIds.length,
            status: 'PENDING',
            method: 'AUTO',
            notes: 'Auto-payout processed',
            createdBy: admin.id,
          },
        });
        await prisma.commission.updateMany({
          where: { id: { in: commissionIds } },
          data: {
            status: 'PAID',
            payoutId: payout.id,
            paidAt: new Date(),
            updatedAt: new Date(),
          },
        });
        await prisma.affiliate.update({
          where: { id: affiliate.id },
          data: { balanceCents: { decrement: payoutAmountCents } },
        });

        await prisma.auditLog.create({
          data: {
            action: 'AUTO_PAYOUT_CREATED',
            actorId: admin.id,
            objectType: 'payout',
            objectId: payout.id,
            payload: {
              affiliateId: affiliate.id,
              amountCents: payoutAmountCents,
              commissionCount: commissionIds.length,
            },
          },
        });

        results.push({
          affiliateId: affiliate.id,
          name: affiliate.user.name,
          payoutId: payout.id,
          amountCents: payoutAmountCents,
          status: 'CREATED',
        });

        totalProcessed++;
        totalAmountCents += payoutAmountCents;
      } catch (err) {
        results.push({
          affiliateId: affiliate.id,
          name: affiliate.user.name,
          status: 'FAILED',
          error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: `Auto-payout processed for ${totalProcessed} affiliates`,
      processed: totalProcessed,
      totalAmountCents,
      results,
    });
  } catch (error) {
    console.error('Auto-payout error:', error);
    return NextResponse.json({ success: false, error: 'Failed to process auto-payouts' }, { status: 500 });
  }
}

// GET - Get auto-payout configuration and status
export async function GET(request: NextRequest) {
  const admin = await verifyAdmin(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const settings = await prisma.programSettings.findFirst();

    // Count eligible affiliates
    const minPayoutCents = settings?.minPayoutCents || 100000;
    const eligibleCount = await prisma.affiliate.count({
      where: {
        balanceCents: { gte: minPayoutCents },
        user: { status: 'ACTIVE' },
      },
    });

    const totalPendingBalance = await prisma.affiliate.aggregate({
      where: {
        balanceCents: { gte: minPayoutCents },
        user: { status: 'ACTIVE' },
      },
      _sum: { balanceCents: true },
    });

    // Recent auto-payouts
    const recentPayouts = await prisma.payout.findMany({
      where: { notes: { contains: 'Auto-payout' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        affiliate: {
          include: { user: { select: { name: true, email: true } } },
        },
      },
    });

    return NextResponse.json({
      success: true,
      config: {
        minPayoutCents,
        payoutFrequency: settings?.payoutFrequency || 'MONTHLY',
        autoPayoutsEnabled: settings?.autoApprovePayouts || false,
      },
      stats: {
        eligibleAffiliates: eligibleCount,
        totalPendingCents: totalPendingBalance._sum?.balanceCents || 0,
      },
      recentPayouts,
    });
  } catch (error) {
    console.error('Auto-payout config error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch config' }, { status: 500 });
  }
}
