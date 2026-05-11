import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import {
  isValidCurrencyForTreasury,
  type TreasuryType,
} from '@/lib/currency-allowlist';


export async function GET(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id')!;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    // Get program settings
    let programSettings = await prisma.programSettings.findFirst();

    // If no settings exist, create default settings
    if (!programSettings) {
      programSettings = await prisma.programSettings.create({
        data: {
          programId: `prg_${Date.now()}`,
          productName: 'BsBot',
          programName: "BsBot's Affiliate Program",
          websiteUrl: 'https://kyns.com',
          currency: 'INR',
          portalSubdomain: 'bsbot.tolt.io',
          minimumPayoutThreshold: 0,
          payoutTerm: 'NET-15',
          commissionHoldDays: 30
        }
      });
    }

    // Get all commission rules
    const commissionRules = await prisma.commissionRule.findMany({
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({
      success: true,
      settings: {
        ...programSettings,
        commissionRules: commissionRules.map(rule => ({
          id: rule.id,
          name: rule.name,
          type: rule.type,
          value: rule.value,
          conditions: rule.conditions,
          isDefault: rule.isDefault,
          isActive: rule.isActive,
          createdAt: rule.createdAt
        }))
      }
    });

  } catch (error) {
    console.error('Settings API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch settings' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id')!;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    const body = await request.json();

    // Get existing settings or create new one
    let programSettings = await prisma.programSettings.findFirst();

    if (!programSettings) {
      programSettings = await prisma.programSettings.create({
        data: {
          programId: `prg_${Date.now()}`,
          productName: 'BsBot',
          programName: "BsBot's Affiliate Program",
          websiteUrl: 'https://kyns.com',
          currency: 'INR',
          portalSubdomain: 'bsbot.tolt.io'
        }
      });
    }

    // Update program settings — only allow specific fields (prevent mass assignment)
    const allowedFields = [
      'programName', 'productName', 'websiteUrl', 'currency', 'portalSubdomain',
      'companyName', 'companyLogo', 'primaryColor', 'secondaryColor',
      'cookieDuration', 'minimumPayout', 'payoutFrequency', 'autoApprove',
      'commissionType', 'commissionValue', 'brandingEnabled', 'commissionHoldDays',
      // Feature A — treasury
      'treasuryType',
      // Feature D — MLM
      'mlmEnabled', 'mlmMaxLevels', 'mlmCommissionMode',
      // Feature E — trust multipliers
      'trustEnabled',
      'trustNewHoldPctOff', 'trustBuildingHoldPctOff', 'trustTrustedHoldPctOff', 'trustEliteHoldPctOff',
      'trustNewCommissionBoost', 'trustBuildingCommissionBoost', 'trustTrustedCommissionBoost', 'trustEliteCommissionBoost',
    ];
    const sanitizedData: Record<string, any> = {};
    for (const key of allowedFields) {
      if (key in body && body[key] !== undefined) {
        sanitizedData[key] = body[key];
      }
    }

    // ─── Treasury lock + cross-validation ───
    // 1. If treasuryType is changing AND any Conversion already exists for this
    //    program, reject — switching treasury invalidates the bookkeeping.
    //    An admin override (`confirmTreasuryMigration: true`) bypasses this.
    // 2. The chosen currency must match the (possibly new) treasury type.
    const nextTreasury: TreasuryType =
      (sanitizedData.treasuryType ?? programSettings.treasuryType ?? 'FIAT') as TreasuryType;
    const nextCurrency: string = sanitizedData.currency ?? programSettings.currency;

    if (
      'treasuryType' in sanitizedData &&
      sanitizedData.treasuryType !== programSettings.treasuryType &&
      !body.confirmTreasuryMigration
    ) {
      const conversionCount = await prisma.conversion.count();
      if (conversionCount > 0) {
        return NextResponse.json(
          {
            error:
              'Treasury type is locked — this program already has conversion activity. Pass `confirmTreasuryMigration: true` to override.',
          },
          { status: 400 }
        );
      }
    }

    if (!isValidCurrencyForTreasury(nextCurrency, nextTreasury)) {
      return NextResponse.json(
        {
          error: `Currency ${nextCurrency} does not match treasury type ${nextTreasury}`,
        },
        { status: 400 }
      );
    }

    const updatedSettings = await prisma.programSettings.update({
      where: { id: programSettings.id },
      data: sanitizedData
    });

    // Log the action
    await logAuditAction({
      actorId: user.id,
      action: 'UPDATE_SETTINGS',
      objectType: 'PROGRAM_SETTINGS',
      objectId: updatedSettings.id,
      payload: sanitizedData
    });

    // Clear cache. revalidateTag must run inside a Next.js request context
    // (it reads the static-generation store from AsyncLocalStorage). When
    // invoked from a test or background job, it throws — so we guard with
    // try/catch and let the save succeed regardless.
    try {
      revalidateTag('platform-settings', 'default');
      revalidateTag('program-settings', 'default');
    } catch (err) {
      console.warn('revalidateTag skipped (out of Next request context?):', err);
    }

    return NextResponse.json({
      success: true,
      message: 'Settings updated successfully',
      settings: updatedSettings
    });

  } catch (error) {
    console.error('Settings update API error:', error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = request.headers.get('x-user-id')!;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { action, ruleData } = body;

    if (action === 'create') {
      // Create new commission rule
      const { name, type, value, conditions, isDefault, level } = ruleData;

      if (!name || !type || value === undefined) {
        return NextResponse.json(
          { error: 'Name, type, and value are required' },
          { status: 400 }
        );
      }

      const ruleLevel = typeof level === 'number' && level >= 1 ? Math.floor(level) : 1;

      // If setting as default, unset other defaults at the same level
      if (isDefault) {
        await prisma.commissionRule.updateMany({
          where: { isDefault: true, level: ruleLevel },
          data: { isDefault: false }
        });
      }

      const newRule = await prisma.commissionRule.create({
        data: {
          name,
          type,
          value,
          level: ruleLevel,
          conditions: conditions || {},
          isDefault: isDefault || false,
          isActive: true
        }
      });

      // Log the action
      await logAuditAction({
        actorId: user.id,
        action: 'CREATE_COMMISSION_RULE',
        objectType: 'COMMISSION_RULE',
        objectId: newRule.id,
        payload: ruleData
      });

      // Clear cache
      try { revalidateTag('program-settings', 'default'); } catch { /* not in request context */ }

      return NextResponse.json({
        success: true,
        message: 'Commission rule created successfully',
        rule: newRule
      });
    }

    if (action === 'update') {
      // Update existing commission rule
      const { id, ...updates } = ruleData;

      if (!id) {
        return NextResponse.json(
          { error: 'Rule ID is required for update' },
          { status: 400 }
        );
      }

      // If setting as default, unset other defaults
      if (updates.isDefault) {
        await prisma.commissionRule.updateMany({
          where: {
            id: { not: id },
            isDefault: true
          },
          data: { isDefault: false }
        });
      }

      const updatedRule = await prisma.commissionRule.update({
        where: { id },
        data: updates
      });

      // Clear cache
      try { revalidateTag('program-settings', 'default'); } catch { /* not in request context */ }

      return NextResponse.json({
        success: true,
        message: 'Commission rule updated successfully',
        rule: updatedRule
      });
    }

    if (action === 'delete') {
      // Delete commission rule
      const { id } = ruleData;

      if (!id) {
        return NextResponse.json(
          { error: 'Rule ID is required for deletion' },
          { status: 400 }
        );
      }

      await prisma.commissionRule.delete({
        where: { id }
      });

      // Clear cache
      try { revalidateTag('program-settings', 'default'); } catch { /* not in request context */ }

      return NextResponse.json({
        success: true,
        message: 'Commission rule deleted successfully'
      });
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );

  } catch (error) {
    console.error('Settings API error:', error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}