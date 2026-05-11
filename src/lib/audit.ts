import { prisma } from './prisma';

/**
 * `AuditLog.actorId` is a FK to `User.id`. For system-originated audits
 * (cron jobs, webhook callbacks, etc.) there's no human user — we use
 * stable conventional IDs starting with "system". This helper upserts
 * those rows lazily on first use so the FK constraint is satisfied
 * without requiring an operator to seed them.
 *
 * Idempotent and cheap: the upsert no-ops once the row exists.
 */
async function ensureSystemActor(actorId: string): Promise<void> {
    if (!actorId.startsWith('system')) return;
    await prisma.user.upsert({
        where: { id: actorId },
        create: {
            id: actorId,
            email: `${actorId}@refferq.internal`,
            name: actorId
                .split('-')
                .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
                .join(' '),
            password: 'unused',
            role: 'ADMIN',
            status: 'ACTIVE',
        },
        update: {},
    });
}

/**
 * Consistently logs administrative actions to the AuditLog table.
 *
 * Auto-creates a placeholder `User` row for system-prefixed actor IDs so
 * webhook/cron-initiated audits don't fail on the actorId FK constraint.
 */
export async function logAuditAction(data: {
    actorId: string;
    action: string;
    objectType: string;
    objectId: string;
    payload?: any;
}) {
    try {
        await ensureSystemActor(data.actorId);
        return await prisma.auditLog.create({
            data: {
                actorId: data.actorId,
                action: data.action,
                objectType: data.objectType,
                objectId: data.objectId,
                payload: data.payload || {},
            },
        });
    } catch (error) {
        console.error('Failed to log audit action:', error);
        // We don't want to fail the main action if auditing fails.
    }
}
