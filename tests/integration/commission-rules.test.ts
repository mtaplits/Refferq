import { describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import {
    POST as createRule,
    PUT as updateRule,
} from '@/app/api/admin/commission-rules/route';
import { createCommissionRule, createProgramSettings, createUser } from './fixtures';

function makeAdminRequest(url: string, body: object, adminId: string, method = 'POST') {
    return new Request(url, {
        method,
        headers: { 'x-user-id': adminId, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('SPLIT-mode rule validation (Feature D)', () => {
    it('accepts a level-2 rate at or below the level-1 rate', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        await createProgramSettings({ mlmCommissionMode: 'SPLIT_FROM_DIRECT' });
        await createCommissionRule({ value: 15, level: 1, isDefault: true });

        const res = await createRule(
            makeAdminRequest('http://localhost/api/admin/commission-rules', {
                name: 'L2-OK',
                type: 'PERCENTAGE',
                value: 10,
                level: 2,
                isDefault: true,
            }, admin.id)
        );
        expect(res.status).toBe(201);

        const rules = await prisma.commissionRule.findMany({ orderBy: { level: 'asc' } });
        expect(rules).toHaveLength(2);
        expect(rules[1].value).toBe(10);
    });

    it('rejects a level-2 rate that pushes total over the level-1 rate', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        await createProgramSettings({ mlmCommissionMode: 'SPLIT_FROM_DIRECT' });
        await createCommissionRule({ value: 15, level: 1, isDefault: true });

        const res = await createRule(
            makeAdminRequest('http://localhost/api/admin/commission-rules', {
                name: 'L2-TOO-BIG',
                type: 'PERCENTAGE',
                value: 20, // > 15% level-1 rate
                level: 2,
                isDefault: true,
            }, admin.id)
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(String(body.error)).toMatch(/SPLIT_FROM_DIRECT/);

        // No new rule should have been created.
        const rules = await prisma.commissionRule.findMany();
        expect(rules).toHaveLength(1);
    });

    it('rejects when the SUM of level-2+ rates would exceed level-1', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        await createProgramSettings({ mlmCommissionMode: 'SPLIT_FROM_DIRECT' });
        await createCommissionRule({ value: 15, level: 1, isDefault: true });
        await createCommissionRule({ value: 8, level: 2, isDefault: true });

        // 8% + 8% = 16% > 15%
        const res = await createRule(
            makeAdminRequest('http://localhost/api/admin/commission-rules', {
                name: 'L3-OVER-SUM',
                type: 'PERCENTAGE',
                value: 8,
                level: 3,
                isDefault: true,
            }, admin.id)
        );
        expect(res.status).toBe(400);
    });

    it('does not enforce sum rule when mode is ADDITIVE', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        await createProgramSettings({ mlmCommissionMode: 'ADDITIVE' });
        await createCommissionRule({ value: 15, level: 1, isDefault: true });

        const res = await createRule(
            makeAdminRequest('http://localhost/api/admin/commission-rules', {
                name: 'L2-ADDITIVE',
                type: 'PERCENTAGE',
                value: 25, // would fail SPLIT but is fine for ADDITIVE
                level: 2,
                isDefault: true,
            }, admin.id)
        );
        expect(res.status).toBe(201);
    });

    it('on update, excludes the rule being edited from the sum check', async () => {
        const admin = await createUser({ name: 'Admin', role: 'ADMIN' });
        await createProgramSettings({ mlmCommissionMode: 'SPLIT_FROM_DIRECT' });
        await createCommissionRule({ value: 15, level: 1, isDefault: true });
        const level2 = await createCommissionRule({ value: 5, level: 2, isDefault: true });

        // Bump level-2 from 5% to 10% — still ≤ level-1 of 15%, so OK.
        const res = await updateRule(
            makeAdminRequest('http://localhost/api/admin/commission-rules', {
                id: level2.id,
                value: 10,
            }, admin.id, 'PUT')
        );
        expect(res.status).toBe(200);
        const updated = await prisma.commissionRule.findUnique({ where: { id: level2.id } });
        expect(updated?.value).toBe(10);
    });
});
