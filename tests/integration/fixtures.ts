import { prisma } from '@/lib/prisma';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Affiliate, User, ProgramSettings, Prisma } from '@prisma/client';

/**
 * Helpers for seeding integration-test fixtures. Each helper inserts the
 * minimum rows needed so the route under test can run. Tests are isolated
 * by the truncate hook in setup.ts.
 */

let userCounter = 0;
function uniqueEmail(prefix: string): string {
    userCounter += 1;
    return `${prefix}-${Date.now()}-${userCounter}@test.local`;
}

export async function createUser(opts: {
    name: string;
    email?: string;
    role?: 'ADMIN' | 'AFFILIATE';
    status?: 'ACTIVE' | 'PENDING' | 'INACTIVE' | 'SUSPENDED';
}): Promise<User> {
    return prisma.user.create({
        data: {
            email: opts.email ?? uniqueEmail(opts.name.toLowerCase()),
            name: opts.name,
            password: await bcrypt.hash('test-password', 4),
            role: opts.role ?? 'AFFILIATE',
            status: opts.status ?? 'ACTIVE',
        },
    });
}

export async function createAffiliate(opts: {
    user: User;
    referredById?: string;
    referralCode?: string;
    payoutDetails?: Record<string, unknown>;
}): Promise<Affiliate> {
    return prisma.affiliate.create({
        data: {
            userId: opts.user.id,
            referralCode: opts.referralCode ?? `AFF-${opts.user.id.slice(-6).toUpperCase()}`,
            referredById: opts.referredById,
            payoutDetails: (opts.payoutDetails ?? {}) as Prisma.InputJsonValue,
        },
    });
}

/** Seed a chain A → B → C where A is the root upline, C is the leaf. */
export async function seedReferralChain(): Promise<{
    A: { user: User; affiliate: Affiliate };
    B: { user: User; affiliate: Affiliate };
    C: { user: User; affiliate: Affiliate };
}> {
    const uA = await createUser({ name: 'Alice' });
    const aA = await createAffiliate({ user: uA, referralCode: 'A-ROOT' });
    const uB = await createUser({ name: 'Bob' });
    const aB = await createAffiliate({ user: uB, referralCode: 'B-MID', referredById: aA.id });
    const uC = await createUser({ name: 'Carol' });
    const aC = await createAffiliate({ user: uC, referralCode: 'C-LEAF', referredById: aB.id });
    return {
        A: { user: uA, affiliate: aA },
        B: { user: uB, affiliate: aB },
        C: { user: uC, affiliate: aC },
    };
}

export async function createProgramSettings(
    overrides: Partial<Prisma.ProgramSettingsUncheckedCreateInput> = {}
): Promise<ProgramSettings> {
    return prisma.programSettings.create({
        data: {
            programId: `prg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            productName: 'Test Product',
            programName: 'Test Program',
            websiteUrl: 'https://test.local',
            portalSubdomain: `test-${Math.random().toString(36).slice(2, 6)}.test.local`,
            currency: 'USD',
            commissionHoldDays: 30,
            ...overrides,
        },
    });
}

export async function createCommissionRule(opts: {
    name?: string;
    type?: 'PERCENTAGE' | 'FIXED';
    value: number;
    level?: number;
    isDefault?: boolean;
}) {
    return prisma.commissionRule.create({
        data: {
            name: opts.name ?? `rule-L${opts.level ?? 1}`,
            type: opts.type ?? 'PERCENTAGE',
            value: opts.value,
            level: opts.level ?? 1,
            isDefault: opts.isDefault ?? true,
            isActive: true,
        },
    });
}

/** Seed an active API key the webhook route can use to authenticate. */
export async function createApiKey(
    user: User
): Promise<{ rawKey: string; record: Awaited<ReturnType<typeof prisma.apiKey.create>> }> {
    const rawKey = `rfq_test_${crypto.randomBytes(16).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const record = await prisma.apiKey.create({
        data: {
            name: 'integration-test',
            keyHash,
            prefix: rawKey.slice(0, 8),
            userId: user.id,
            scopes: ['write'],
            isActive: true,
        },
    });
    return { rawKey, record };
}

/** Make x-user-id headers for the routes that look up the admin role. */
export function adminAuthHeaders(adminUserId: string): Record<string, string> {
    return { 'x-user-id': adminUserId, 'content-type': 'application/json' };
}
