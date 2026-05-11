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

function authResponse(token = 'jwt-test-token'): Response {
    return jsonResponse({ token });
}

describe('NowPaymentsProvider', () => {
    beforeEach(() => {
        setEnv();
        _resetJwtCacheForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('exposes its id and currency', () => {
        const p = new NowPaymentsProvider();
        expect(p.id).toBe('nowpayments');
        expect(p.currency).toBe('USDT');
    });

    it('returns queued + the withdrawal id on a successful send', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(authResponse())
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'wd-123', status: 'WAITING' }] }));

        const res = await new NowPaymentsProvider().send({
            toAddress: 'TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            amountCents: 1234,
            payoutId: 'payout-abc',
            callbackUrl: 'https://example.com/cb',
        });

        expect(res).toEqual({ taskId: 'wd-123', status: 'queued' });
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // First call: auth
        expect(fetchSpy.mock.calls[0][0]).toBe('https://api.nowpayments.test/v1/auth');
        // Second call: payout, with x-api-key + Bearer JWT
        const payoutCall = fetchSpy.mock.calls[1];
        expect(payoutCall[0]).toBe('https://api.nowpayments.test/v1/payout');
        const init = payoutCall[1] as RequestInit;
        const headers = init.headers as Record<string, string>;
        expect(headers['x-api-key']).toBe('api-key-test');
        expect(headers.Authorization).toBe('Bearer jwt-test-token');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
            withdrawals: [
                {
                    address: 'TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                    currency: 'usdttrc20',
                    amount: '12.34',
                    ipn_callback_url: 'https://example.com/cb',
                    unique_external_id: 'payout-abc',
                },
            ],
        });
    });

    it('returns failed when config is incomplete', async () => {
        delete process.env.NOWPAYMENTS_API_KEY;
        const res = await new NowPaymentsProvider().send({
            toAddress: 'TXanything',
            amountCents: 100,
            payoutId: 'p1',
            callbackUrl: 'https://example.com/cb',
        });
        expect(res.status).toBe('failed');
        expect(res.error).toContain('NOWPAYMENTS_API_KEY');
    });

    it('returns failed on a non-2xx payout response', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(authResponse())
            .mockResolvedValueOnce(new Response('not enough balance', { status: 422 }));

        const res = await new NowPaymentsProvider().send({
            toAddress: 'TXany',
            amountCents: 100,
            payoutId: 'p1',
            callbackUrl: 'https://example.com/cb',
        });
        expect(res.status).toBe('failed');
        expect(res.error).toMatch(/HTTP 422/);
    });

    it('returns failed when the payout response is missing a withdrawal id', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(authResponse())
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [] }));

        const res = await new NowPaymentsProvider().send({
            toAddress: 'TXany',
            amountCents: 100,
            payoutId: 'p1',
            callbackUrl: 'https://example.com/cb',
        });
        expect(res.status).toBe('failed');
        expect(res.error).toMatch(/missing withdrawal id/);
    });

    it('refreshes the JWT and retries when payout returns 401', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            // initial auth → JWT-1
            .mockResolvedValueOnce(authResponse('jwt-1'))
            // payout with JWT-1 → 401
            .mockResolvedValueOnce(new Response('expired', { status: 401 }))
            // forced re-auth → JWT-2
            .mockResolvedValueOnce(authResponse('jwt-2'))
            // payout with JWT-2 → success
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'wd-9' }] }));

        const res = await new NowPaymentsProvider().send({
            toAddress: 'TXany',
            amountCents: 100,
            payoutId: 'p1',
            callbackUrl: 'https://example.com/cb',
        });
        expect(res).toEqual({ taskId: 'wd-9', status: 'queued' });
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        // The second payout attempt should carry the new JWT.
        const secondPayoutInit = fetchSpy.mock.calls[3][1] as RequestInit;
        const secondPayoutHeaders = secondPayoutInit.headers as Record<string, string>;
        expect(secondPayoutHeaders.Authorization).toBe('Bearer jwt-2');
    });

    it('extracts withdrawal id from a top-level response shape too', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(authResponse())
            .mockResolvedValueOnce(jsonResponse({ id: 4242, batch_withdrawal_id: 4242 }));

        const res = await new NowPaymentsProvider().send({
            toAddress: 'TXany',
            amountCents: 100,
            payoutId: 'p1',
            callbackUrl: 'https://example.com/cb',
        });
        expect(res).toEqual({ taskId: '4242', status: 'queued' });
    });

    it.each([
        ['FINISHED', 'confirmed'],
        ['FAILED', 'failed'],
        ['REJECTED', 'failed'],
        ['EXPIRED', 'failed'],
        ['WAITING', 'pending'],
        ['PROCESSING', 'pending'],
        ['SENDING', 'pending'],
        ['SOMETHING_NEW', 'pending'],
        ['', 'pending'],
    ])('getStatus maps NowPayments "%s" → "%s"', async (rawStatus, expected) => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(authResponse())
            .mockResolvedValueOnce(jsonResponse({ payment_status: rawStatus }));
        const status = await new NowPaymentsProvider().getStatus('wd-1');
        expect(status).toBe(expected);
    });

    it('getStatus returns pending when the API call errors', async () => {
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(authResponse())
            .mockRejectedValueOnce(new Error('network down'));
        const status = await new NowPaymentsProvider().getStatus('wd-1');
        expect(status).toBe('pending');
    });

    it('formats odd cent amounts correctly (1 cent, 100 cent boundaries)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy
            .mockResolvedValueOnce(authResponse())
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'a' }] }))
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'b' }] }))
            .mockResolvedValueOnce(jsonResponse({ withdrawals: [{ id: 'c' }] }));

        const p = new NowPaymentsProvider();
        await p.send({ toAddress: 'TX', amountCents: 1, payoutId: 'a', callbackUrl: 'http://cb' });
        await p.send({ toAddress: 'TX', amountCents: 100, payoutId: 'b', callbackUrl: 'http://cb' });
        await p.send({ toAddress: 'TX', amountCents: 999_99, payoutId: 'c', callbackUrl: 'http://cb' });

        const amounts = [1, 2, 3].map((i) => JSON.parse((fetchSpy.mock.calls[i][1] as RequestInit).body as string).withdrawals[0].amount);
        expect(amounts).toEqual(['0.01', '1.00', '999.99']);
    });
});
