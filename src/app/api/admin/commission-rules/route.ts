import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { commissionRuleSchema } from '@/lib/validations';

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
 * Validate that adding/updating this rule does not violate SPLIT_FROM_DIRECT
 * mode constraints — namely, the sum of all PERCENTAGE-type default rates
 * across levels must not exceed the level-1 default rate.
 *
 * Returns null on OK, otherwise a human-readable reason string.
 */
async function validateSplitMode(args: {
    excludeRuleId?: string | null;
    level: number;
    type: 'PERCENTAGE' | 'FIXED';
    value: number;
    isDefault: boolean;
    isActive: boolean;
}): Promise<string | null> {
    const settings = await prisma.programSettings.findFirst();
    const mode = settings?.mlmCommissionMode ?? 'ADDITIVE';
    if (mode !== 'SPLIT_FROM_DIRECT') return null;
    if (!args.isDefault || !args.isActive) return null;
    if (args.type !== 'PERCENTAGE') return null;

    const existingRules = await prisma.commissionRule.findMany({
        where: {
            isDefault: true,
            isActive: true,
            type: 'PERCENTAGE',
            ...(args.excludeRuleId ? { NOT: { id: args.excludeRuleId } } : {}),
        },
        select: { level: true, value: true },
    });

    const byLevel = new Map<number, number>();
    for (const r of existingRules) {
        const cur = byLevel.get(r.level) ?? 0;
        // Within a level, multiple defaults shouldn't exist, but if they do, take the max conservatively.
        byLevel.set(r.level, Math.max(cur, r.value));
    }
    // Apply the candidate rule on top.
    const candidateExisting = byLevel.get(args.level) ?? 0;
    byLevel.set(args.level, Math.max(candidateExisting, args.value));

    const levelOneRate = byLevel.get(1) ?? 0;
    if (levelOneRate <= 0) {
        return 'Cannot configure level-2+ rules without a level-1 default rule in SPLIT_FROM_DIRECT mode';
    }
    let sumAboveLevelOne = 0;
    for (const [level, val] of byLevel.entries()) {
        if (level >= 2) sumAboveLevelOne += val;
    }
    if (sumAboveLevelOne > levelOneRate) {
        return `SPLIT_FROM_DIRECT mode: sum of level-2+ rates (${sumAboveLevelOne}%) cannot exceed level-1 rate (${levelOneRate}%)`;
    }
    return null;
}

export async function GET(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const rules = await prisma.commissionRule.findMany({
        orderBy: [{ level: 'asc' }, { createdAt: 'desc' }],
    });
    return NextResponse.json({ rules });
}

export async function POST(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = commissionRuleSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }
    const violation = await validateSplitMode({
        excludeRuleId: null,
        level: parsed.data.level,
        type: parsed.data.type,
        value: parsed.data.value,
        isDefault: parsed.data.isDefault,
        isActive: parsed.data.isActive,
    });
    if (violation) {
        return NextResponse.json({ error: violation }, { status: 400 });
    }
    const rule = await prisma.commissionRule.create({ data: parsed.data });
    await logAuditAction({
        actorId: auth.user.id,
        action: 'CREATE_COMMISSION_RULE',
        objectType: 'COMMISSION_RULE',
        objectId: rule.id,
        payload: { ...parsed.data },
    });
    return NextResponse.json({ rule }, { status: 201 });
}

export async function PUT(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsedBody = body as { id?: string } & Record<string, unknown>;
    const id = parsedBody.id;
    if (!id || typeof id !== 'string') {
        return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }
    const parsed = commissionRuleSchema.partial().safeParse(parsedBody);
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }
    const existing = await prisma.commissionRule.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

    const merged = {
        level: parsed.data.level ?? existing.level,
        type: (parsed.data.type ?? existing.type) as 'PERCENTAGE' | 'FIXED',
        value: parsed.data.value ?? existing.value,
        isDefault: parsed.data.isDefault ?? existing.isDefault,
        isActive: parsed.data.isActive ?? existing.isActive,
    };
    const violation = await validateSplitMode({
        excludeRuleId: id,
        ...merged,
    });
    if (violation) {
        return NextResponse.json({ error: violation }, { status: 400 });
    }

    const rule = await prisma.commissionRule.update({ where: { id }, data: parsed.data });
    await logAuditAction({
        actorId: auth.user.id,
        action: 'UPDATE_COMMISSION_RULE',
        objectType: 'COMMISSION_RULE',
        objectId: id,
        payload: parsed.data as Record<string, unknown>,
    });
    return NextResponse.json({ rule });
}

export async function DELETE(request: NextRequest) {
    const auth = await verifyAdmin(request);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
    await prisma.commissionRule.delete({ where: { id } });
    await logAuditAction({
        actorId: auth.user.id,
        action: 'DELETE_COMMISSION_RULE',
        objectType: 'COMMISSION_RULE',
        objectId: id,
        payload: {},
    });
    return NextResponse.json({ success: true });
}
