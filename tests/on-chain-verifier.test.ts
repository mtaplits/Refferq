import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyOnChain, explorerUrl } from '@/lib/payouts/on-chain-verifier';

const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const RECIPIENT = 'TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TX_HASH = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function tronscanResponse(overrides: Record<string, unknown> = {}, transferOverrides: Record<string, unknown> = {}): Response {
    return jsonResponse({
        hash: TX_HASH,
        confirmed: true,
        contractRet: 'SUCCESS',
        tokenTransferInfo: {
            contract_address: USDT_TRC20,
            to_address: RECIPIENT,
            amount_str: '12340000', // 12.34 USDT (6 decimals)
            decimals: 6,
            ...transferOverrides,
        },
        ...overrides,
    });
}

describe('on-chain verifier', () => {
    beforeEach(() => {
        delete process.env.TRONSCAN_API_BASE;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('verifies a matching TRC20 USDT transfer', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tronscanResponse());
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result).toEqual({
            verified: true,
            observedAmountCents: 1234,
            observedRecipient: RECIPIENT,
            confirmed: true,
        });
    });

    it('accepts when observed amount exceeds expected (overpayment is OK)', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            tronscanResponse({}, { amount_str: '20000000' }) // 20 USDT
        );
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234, // 12.34 USDT
            network: 'trc20',
        });
        expect(result.verified).toBe(true);
        expect(result.observedAmountCents).toBe(2000);
    });

    it.each(['tron', 'usdttrc20', 'usdt_tron', 'TRC20'])(
        'maps network alias "%s" to TRC20',
        async (network) => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tronscanResponse());
            const result = await verifyOnChain({
                txHash: TX_HASH,
                expectedAddress: RECIPIENT,
                expectedAmountCents: 1234,
                network,
            });
            expect(result.verified).toBe(true);
        }
    );

    it('returns recipient_mismatch when the to_address differs', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            tronscanResponse({}, { to_address: 'TYotherwallet' })
        );
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('recipient_mismatch');
        expect(result.observedRecipient).toBe('TYotherwallet');
    });

    it('returns amount_short when the chain amount is less than expected', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            tronscanResponse({}, { amount_str: '5000000' }) // 5.00 USDT
        );
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234, // expected 12.34 USDT
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('amount_short');
        expect(result.observedAmountCents).toBe(500);
    });

    it('returns wrong_contract when the contract is not USDT TRC20', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            tronscanResponse({}, { contract_address: 'TRyzN0tUSDT0n0nUSDTcontractTron' })
        );
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('wrong_contract');
    });

    it('returns tx_failed when contractRet is not SUCCESS', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            tronscanResponse({ contractRet: 'REVERT' })
        );
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('tx_failed');
    });

    it('returns unconfirmed when the tx has no confirmations', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tronscanResponse({ confirmed: false }));
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('unconfirmed');
        expect(result.confirmed).toBe(false);
    });

    it('returns tx_not_found when Tronscan returns an empty body', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({}));
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('tx_not_found');
    });

    it('returns tx_not_found when Tronscan returns non-2xx', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 502 }));
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('tx_not_found');
    });

    it('returns tx_not_found when fetch rejects (network error)', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ENOTFOUND'));
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('tx_not_found');
    });

    it('returns invalid_response when tokenTransferInfo is missing', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            jsonResponse({ hash: TX_HASH, confirmed: true, contractRet: 'SUCCESS' })
        );
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'trc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('invalid_response');
    });

    it('returns unsupported_network for non-TRC20 networks', async () => {
        const result = await verifyOnChain({
            txHash: TX_HASH,
            expectedAddress: RECIPIENT,
            expectedAmountCents: 1234,
            network: 'usdterc20',
        });
        expect(result.verified).toBe(false);
        expect(result.reason).toBe('unsupported_network');
    });

    it('explorerUrl returns a tronscan link for TRC20', () => {
        expect(explorerUrl('trc20', '0xabc')).toBe('https://tronscan.org/#/transaction/0xabc');
        expect(explorerUrl('tron', '0xabc')).toBe('https://tronscan.org/#/transaction/0xabc');
    });

    it('explorerUrl returns null for unsupported networks', () => {
        expect(explorerUrl('usdterc20', '0xabc')).toBeNull();
    });
});
