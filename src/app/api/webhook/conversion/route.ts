import { NextRequest, NextResponse } from 'next/server';
import { db, prisma } from '@/lib/prisma';
import { isValidCurrencyForTreasury } from '@/lib/currency-allowlist';
import { multipliersFor } from '@/lib/trust/tiers';
import { tierOf } from '@/lib/trust/compute';
import type { Affiliate, CommissionRule, TrustTier } from '@prisma/client';
import crypto from 'crypto';

// ─── Webhook Signature Verification ────────────────────────────
function verifyWebhookSignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_e) {
    return false;
  }
}

async function verifyApiKey(request: NextRequest): Promise<boolean> {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return false;

  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const key = await prisma.apiKey.findFirst({
    where: { keyHash, isActive: true }
  }).catch(() => null);

  return !!key;
}

function computeAmount(baseCents: number, rule: { type: string; value: number } | null, defaultRate = 15): number {
  if (!rule) {
    // legacy default: 15% percentage
    return Math.floor((baseCents * defaultRate) / 100);
  }
  if (rule.type === 'PERCENTAGE') {
    return Math.floor((baseCents * rule.value) / 100);
  }
  if (rule.type === 'FIXED') {
    return rule.value;
  }
  return 0;
}

export async function POST(request: NextRequest) {
  try {
    // ─── Authentication ───
    const rawBody = await request.text();
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const signature = request.headers.get('x-webhook-signature') || request.headers.get('x-refferq-signature');

    let authenticated = false;
    const apiKey = request.headers.get('x-api-key');
    if (apiKey) {
      authenticated = await verifyApiKey(request);
    }
    if (!authenticated && webhookSecret && signature) {
      authenticated = verifyWebhookSignature(rawBody, signature, webhookSecret);
    }

    if (!authenticated) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized: Valid API key or webhook signature required' },
        { status: 401 }
      );
    }

    const body = JSON.parse(rawBody);
    const {
      event_type,
      amount_cents,
      currency: bodyCurrency,
      customer_email,
      attribution_key,
      referral_code,
      event_metadata = {},
    } = body;

    if (!event_type || !customer_email) {
      return NextResponse.json(
        { success: false, message: 'Event type and customer email are required' },
        { status: 400 }
      );
    }

    // ─── Program settings (treasury, MLM, trust, hold) ───
    const settings = await prisma.programSettings.findFirst();
    const programCurrency = settings?.currency || 'USD';
    const treasuryType = (settings?.treasuryType ?? 'FIAT') as 'FIAT' | 'CRYPTO';
    const currency = bodyCurrency || programCurrency;

    if (!isValidCurrencyForTreasury(currency, treasuryType)) {
      return NextResponse.json(
        {
          success: false,
          message: `Currency ${currency} does not match program treasury type ${treasuryType}`,
        },
        { status: 400 }
      );
    }

    let attributionMethod = 'none';
    if (attribution_key) {
      attributionMethod = 'attribution_key';
    }

    let directAffiliate: Awaited<ReturnType<typeof db.getAffiliateByReferralCode>> = null;
    if (referral_code) {
      directAffiliate = await db.getAffiliateByReferralCode(referral_code);
      attributionMethod = 'referral_code';
    }

    if (!directAffiliate) {
      console.log('Conversion received but no affiliate attribution found:', {
        event_type,
        customer_email,
        attribution_key,
        referral_code,
      });
      return NextResponse.json({
        success: true,
        message: 'Conversion logged (no attribution)',
        attributed: false,
      });
    }

    // ─── Create conversion record ───
    const conversion = await db.createConversion({
      affiliateId: directAffiliate.id,
      eventType: event_type,
      amountCents: amount_cents || 0,
      currency,
      eventMetadata: {
        ...event_metadata,
        customerEmail: customer_email,
        attributionMethod,
        attributionKey: attribution_key,
        referralCode: referral_code,
      },
    });

    // ─── Build upline chain (Feature D — MLM) ───
    const mlmEnabled = settings?.mlmEnabled ?? false;
    const maxLevels = mlmEnabled ? Math.max(1, settings?.mlmMaxLevels ?? 1) : 1;

    interface ChainNode {
      affiliate: Pick<Affiliate, 'id' | 'userId' | 'referredById'>;
      level: number;
    }
    const chain: ChainNode[] = [];
    const visited = new Set<string>();
    let cursor: Pick<Affiliate, 'id' | 'userId' | 'referredById'> | null = {
      id: directAffiliate.id,
      userId: directAffiliate.userId,
      referredById: (directAffiliate as Affiliate).referredById ?? null,
    };
    let level = 1;
    while (cursor && level <= maxLevels && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      chain.push({ affiliate: cursor, level });
      if (level >= maxLevels || !cursor.referredById) break;
      cursor = await prisma.affiliate.findUnique({
        where: { id: cursor.referredById },
        select: { id: true, userId: true, referredById: true },
      });
      level++;
    }

    // ─── Per-level commission rules ───
    const rulesByLevel = new Map<number, CommissionRule | null>();
    const levelsNeeded = Array.from(new Set(chain.map((c) => c.level)));
    await Promise.all(
      levelsNeeded.map(async (lvl) => {
        const rule = await prisma.commissionRule.findFirst({
          where: { level: lvl, isDefault: true, isActive: true },
        });
        rulesByLevel.set(lvl, rule);
      })
    );
    // Fallback: if no level-1 rule, fall back to any active default rule (legacy behavior)
    if (!rulesByLevel.get(1)) {
      const fallback = await prisma.commissionRule.findFirst({
        where: { isDefault: true, isActive: true },
      });
      rulesByLevel.set(1, fallback);
    }

    // ─── Hold period & trust (Feature E) ───
    const holdDays = settings?.commissionHoldDays ?? 30;

    // ─── Create one commission per upline level ───
    const commissionsCreated: { id: string; affiliateId: string; level: number; amountCents: number; rate: number }[] = [];

    for (const { affiliate: a, level: lvl } of chain) {
      const baseRule = rulesByLevel.get(lvl) ?? rulesByLevel.get(1) ?? null;
      const tier: TrustTier = await tierOf(a.id);
      const { holdPctOff, commissionBoost } = multipliersFor(tier, settings);

      const baseRate = baseRule?.value ?? 15;
      const effectiveRate = baseRule?.type === 'FIXED' ? baseRate : baseRate + commissionBoost;
      const amt =
        baseRule?.type === 'FIXED'
          ? baseRule.value
          : Math.floor(((amount_cents || 0) * Math.max(0, effectiveRate)) / 100);

      const effectiveHoldDays = Math.max(0, holdDays * (1 - Math.max(0, Math.min(100, holdPctOff)) / 100));
      const maturesAt = new Date(Date.now() + effectiveHoldDays * 24 * 60 * 60 * 1000);

      const created = await prisma.commission.create({
        data: {
          conversionId: conversion.id,
          affiliateId: a.id,
          userId: a.userId,
          amountCents: amt,
          rate: effectiveRate,
          status: 'PENDING',
          maturesAt,
          level: lvl,
          sourceAffiliateId: lvl > 1 ? directAffiliate.id : null,
        },
      });

      commissionsCreated.push({
        id: created.id,
        affiliateId: a.id,
        level: lvl,
        amountCents: amt,
        rate: effectiveRate,
      });
    }

    // ─── Audit log ───
    await db.createAuditLog({
      actorId: 'system',
      action: 'conversion_tracked',
      objectType: 'conversion',
      objectId: conversion.id,
      payload: {
        event_type,
        amount_cents,
        currency,
        treasury_type: treasuryType,
        attributionMethod,
        mlm_enabled: mlmEnabled,
        mlm_levels: chain.length,
        commissions: commissionsCreated,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Conversion tracked successfully',
      attributed: true,
      conversion,
      commissions: commissionsCreated,
      attributionMethod,
    });
  } catch (error) {
    console.error('Conversion webhook error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to process conversion' },
      { status: 500 }
    );
  }
}
