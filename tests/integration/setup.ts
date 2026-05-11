import { afterAll, beforeEach } from 'vitest';
import { prisma } from '@/lib/prisma';

// ─── Safety: refuse to truncate anything that isn't the test DB ───
function assertTestDatabase(): void {
    const url = process.env.DATABASE_URL ?? '';
    if (!url.includes('refferq_test')) {
        throw new Error(
            `Integration tests must run against a DB whose URL contains "refferq_test". Got: ${url}`
        );
    }
}

assertTestDatabase();

/**
 * Tables in dependency order — children first, then parents. We truncate
 * everything except the Prisma internals between tests so each test starts
 * from a known-empty state.
 */
const TRUNCATE_SQL = `
    TRUNCATE TABLE
        "audit_logs",
        "trust_scores",
        "credit_earnings",
        "credit_buckets",
        "transactions",
        "commissions",
        "conversions",
        "referral_clicks",
        "referrals",
        "payouts",
        "commission_rules",
        "program_settings",
        "programs",
        "partner_groups",
        "coupons",
        "invoices",
        "api_usage_logs",
        "api_keys",
        "rate_limit_entries",
        "email_logs",
        "email_templates",
        "integration_settings",
        "webhook_logs",
        "webhooks",
        "saved_reports",
        "scheduled_reports",
        "resources",
        "otps",
        "team_members",
        "affiliates",
        "users"
    RESTART IDENTITY CASCADE;
`;

beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE_SQL);
    // Several routes (conversion webhook, mature cron, NowPayments IPN callback)
    // write AuditLog entries with system-actor IDs. AuditLog.actorId has an
    // FK to users, so we ensure those system users exist for every test.
    await prisma.user.createMany({
        data: [
            { id: 'system', email: 'system@refferq.test', name: 'System', password: 'unused', role: 'ADMIN', status: 'ACTIVE' },
            { id: 'system-cron', email: 'system-cron@refferq.test', name: 'System Cron', password: 'unused', role: 'ADMIN', status: 'ACTIVE' },
            { id: 'system-webhook', email: 'system-webhook@refferq.test', name: 'System Webhook', password: 'unused', role: 'ADMIN', status: 'ACTIVE' },
        ],
    });
});

afterAll(async () => {
    await prisma.$disconnect();
});
