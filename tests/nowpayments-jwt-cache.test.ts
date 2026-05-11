import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    NowPaymentsProvider,
    _resetJwtCacheForTests,
} from '@/lib/crypto-disbursement/providers/nowpayments';

function setEnv() {
    process.env.NOWPAYMENTS_BASE_URL = 'https://api.nowpayments.test/v1';
    process.env.NOWPAYMENTS_API_KEY = 'api-key-test';
    process.env.NOWPAYMENTS_EMAIL = 'ops@example.com';
    process.env.NOWPAYMENTS_PASSWORD = 'pw';
    process.env.NOWPAYMENTS_USDT_NETWORK = 'usdttrc20';
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('NowPayments JWT cache', () => {
    beforeEach(() => {
        setEnv();
        _resetJwtCacheForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reuses a cached JWT across consecutive sends within the TTL', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            // first send: auth + payout
            .mockResolvedValueOnce(jsonResponse({ token: 'jwt-1' }))
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'a' }] }))
            // second send: ONLY payout (no extra auth call expected)
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'b' }] }));

        const p = new NowPaymentsProvider();
        await p.send({ toAddress: 'TX', amountCents: 100, payoutId: 'a', callbackUrl: 'http://cb' });
        await p.send({ toAddress: 'TX', amountCents: 100, payoutId: 'b', callbackUrl: 'http://cb' });

        expect(fetchSpy).toHaveBeenCalledTimes(3);
        const authCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/auth'));
        expect(authCalls).toHaveLength(1);
    });

    it('single-flights concurrent JWT misses', async () => {
        // Auth call resolves once, but slowly; if not single-flighted, we'd see
        // multiple /auth calls.
        let resolveAuth: (r: Response) => void = () => {};
        const authPending = new Promise<Response>((resolve) => {
            resolveAuth = resolve;
        });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockReturnValueOnce(authPending)
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'a' }] }))
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'b' }] }));

        const p = new NowPaymentsProvider();
        const sendA = p.send({ toAddress: 'TX', amountCents: 100, payoutId: 'a', callbackUrl: 'http://cb' });
        const sendB = p.send({ toAddress: 'TX', amountCents: 100, payoutId: 'b', callbackUrl: 'http://cb' });

        // Let the microtask queue run so both sends have time to request a JWT.
        await Promise.resolve();
        resolveAuth(jsonResponse({ token: 'jwt-shared' }));

        const [resA, resB] = await Promise.all([sendA, sendB]);
        expect(resA.status).toBe('queued');
        expect(resB.status).toBe('queued');

        const authCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/auth'));
        expect(authCalls).toHaveLength(1);
    });

    it('throws via failed send when /auth returns non-2xx', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('bad creds', { status: 401 }));

        const res = await new NowPaymentsProvider().send({
            toAddress: 'TX',
            amountCents: 100,
            payoutId: 'p1',
            callbackUrl: 'http://cb',
        });
        expect(res.status).toBe('failed');
        expect(res.error).toMatch(/auth failed/i);
    });

    it('forces a refresh when a payout call returns 401', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ token: 'jwt-old' }))
            .mockResolvedValueOnce(new Response('expired', { status: 401 }))
            .mockResolvedValueOnce(jsonResponse({ token: 'jwt-new' }))
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'x' }] }));

        await new NowPaymentsProvider().send({
            toAddress: 'TX',
            amountCents: 100,
            payoutId: 'p1',
            callbackUrl: 'http://cb',
        });

        const authCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/auth'));
        expect(authCalls).toHaveLength(2); // initial + forced refresh
    });
});
