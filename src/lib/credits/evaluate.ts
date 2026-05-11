import { prisma } from '@/lib/prisma';
import crypto from 'crypto';
import type { CreditBucket, CreditEarning, TrustTier } from '@prisma/client';

const TIER_RANK: Record<TrustTier, number> = {
    NEW: 0,
    BUILDING: 1,
    TRUSTED: 2,
    ELITE: 3,
};

/**
 * RFC 4648 base32 alphabet, minus visually-ambiguous chars (0/O, 1/I, etc.).
 * 32 chars * 16 bits = 80-bit unlock codes — plenty for our scale.
 */
const BASE32_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function encodeBase32(bytes: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return out;
}

function chunk4(s: string): string {
    const parts: string[] = [];
    for (let i = 0; i < s.length; i += 4) parts.push(s.slice(i, i + 4));
    return parts.join('-');
}

export function generateUnlockCode(): string {
    // 8 random bytes → 13 base32 chars → take 12 and group as 3×4.
    const bytes = crypto.randomBytes(8);
    const code = encodeBase32(bytes).slice(0, 12);
    return `REFQ-${chunk4(code)}`;
}

async function generateUniqueUnlockCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateUnlockCode();
        const exists = await prisma.creditEarning.findUnique({ where: { unlockCode: code } });
        if (!exists) return code;
    }
    throw new Error('Could not generate a unique unlock code after 5 attempts');
}

interface EvaluateContext {
    /** Optional override for the affiliate's tier (lets the maturation cron
     *  pass in a freshly recomputed tier without re-querying). */
    tier?: TrustTier;
}

export interface CreditEarningResult {
    earned: CreditEarning[];
    skipped: { bucketId: string; reason: string }[];
}

/**
 * Evaluate milestone-based credit buckets for a single affiliate and
 * create CreditEarning rows for any newly-crossed thresholds. Idempotent:
 * a bucket that was already earned does not fire again.
 *
 * Manual-admin buckets are skipped here; they are issued via the
 * /api/admin/credits/earnings endpoint instead.
 */
export async function evaluateCredits(
    affiliateId: string,
    ctx: EvaluateContext = {}
): Promise<CreditEarningResult> {
    const earned: CreditEarning[] = [];
    const skipped: { bucketId: string; reason: string }[] = [];

    const [affiliate, buckets, approvedCommissions, existingEarnings] = await Promise.all([
        prisma.affiliate.findUnique({
            where: { id: affiliateId },
            select: {
                id: true,
                trustScore: { select: { tier: true } },
            },
        }),
        prisma.creditBucket.findMany({
            where: {
                isActive: true,
                triggerType: { in: ['MILESTONE_REFERRALS', 'MILESTONE_EARNINGS'] },
            },
        }),
        prisma.commission.findMany({
            where: {
                affiliateId,
                status: { in: ['APPROVED', 'PAID'] },
            },
            select: { id: true, amountCents: true },
        }),
        prisma.creditEarning.findMany({
            where: { affiliateId },
            select: { bucketId: true },
        }),
    ]);

    if (!affiliate) return { earned, skipped };

    const earnedBucketIds = new Set(existingEarnings.map((e) => e.bucketId));
    const approvedReferralCount = approvedCommissions.length;
    const approvedEarningsCents = approvedCommissions.reduce((acc, c) => acc + c.amountCents, 0);

    const currentTier: TrustTier = ctx.tier ?? affiliate.trustScore?.tier ?? 'NEW';

    for (const bucket of buckets) {
        if (earnedBucketIds.has(bucket.id)) {
            skipped.push({ bucketId: bucket.id, reason: 'already_earned' });
            continue;
        }

        // Trust gating (Feature E hook)
        if (bucket.minTrustTier && TIER_RANK[currentTier] < TIER_RANK[bucket.minTrustTier]) {
            skipped.push({ bucketId: bucket.id, reason: 'trust_tier_below_minimum' });
            continue;
        }

        const threshold = bucket.triggerValue ?? 0;
        let crossed = false;
        if (bucket.triggerType === 'MILESTONE_REFERRALS') {
            crossed = approvedReferralCount >= threshold;
        } else if (bucket.triggerType === 'MILESTONE_EARNINGS') {
            crossed = approvedEarningsCents >= threshold;
        }
        if (!crossed) {
            skipped.push({ bucketId: bucket.id, reason: 'threshold_not_met' });
            continue;
        }

        const unlockCode = await generateUniqueUnlockCode();
        const expiresAt =
            bucket.expiresAfterDays !== null && bucket.expiresAfterDays !== undefined
                ? new Date(Date.now() + bucket.expiresAfterDays * 24 * 60 * 60 * 1000)
                : null;
        const triggerNote =
            bucket.triggerType === 'MILESTONE_REFERRALS'
                ? `Earned at ${approvedReferralCount} approved referrals (threshold ${threshold})`
                : `Earned at $${(approvedEarningsCents / 100).toFixed(2)} approved earnings (threshold $${(threshold / 100).toFixed(2)})`;

        const row = await prisma.creditEarning.create({
            data: {
                affiliateId,
                bucketId: bucket.id,
                unlockCode,
                status: 'EARNED',
                expiresAt,
                triggerNote,
            },
        });
        earned.push(row);
    }

    return { earned, skipped };
}

/**
 * Manually issue a credit from a MANUAL_ADMIN bucket. Used by the admin
 * "issue credit" endpoint. Validates bucket type to avoid bypassing the
 * milestone gating for non-manual buckets.
 */
export async function issueManualCredit(args: {
    affiliateId: string;
    bucketId: string;
    triggerNote?: string;
}): Promise<CreditEarning> {
    const bucket = await prisma.creditBucket.findUnique({ where: { id: args.bucketId } });
    if (!bucket) throw new Error('Bucket not found');
    if (!bucket.isActive) throw new Error('Bucket is inactive');
    if (bucket.triggerType !== 'MANUAL_ADMIN') {
        throw new Error('Bucket is not configured for manual admin issuance');
    }
    const unlockCode = await generateUniqueUnlockCode();
    const expiresAt =
        bucket.expiresAfterDays !== null && bucket.expiresAfterDays !== undefined
            ? new Date(Date.now() + bucket.expiresAfterDays * 24 * 60 * 60 * 1000)
            : null;
    return prisma.creditEarning.create({
        data: {
            affiliateId: args.affiliateId,
            bucketId: bucket.id,
            unlockCode,
            status: 'EARNED',
            expiresAt,
            triggerNote: args.triggerNote ?? 'Manually issued by admin',
        },
    });
}
