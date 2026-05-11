import { describe, expect, it } from 'vitest';
import { StubProvider } from '@/lib/crypto-disbursement/providers/stub';

describe('stub crypto provider (Feature B)', () => {
    it('returns a queued task ID and never throws', async () => {
        const p = new StubProvider();
        const res = await p.send({
            toAddress: '0x0000000000000000000000000000000000000000',
            amountCents: 12345,
            payoutId: 'p1',
            callbackUrl: 'https://example.com/cb',
        });
        expect(res.status).toBe('queued');
        expect(res.taskId).toMatch(/^stub-[0-9a-f]{16}$/);
    });

    it('reports pending status for any task ID', async () => {
        const p = new StubProvider();
        expect(await p.getStatus('anything')).toBe('pending');
    });

    it('exposes its id and currency', () => {
        const p = new StubProvider();
        expect(p.id).toBe('stub');
        expect(p.currency).toBe('USDT');
    });
});
