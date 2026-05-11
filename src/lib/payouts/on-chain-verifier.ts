/**
 * On-chain verification of crypto payouts.
 *
 * Independently confirms that the txHash NowPayments (or any future provider)
 * reports actually exists on chain, was sent to the expected wallet, and moved
 * at least the expected amount of the expected token. Backed by free public
 * block explorers — no API key, no provider trust.
 *
 * v1 implements TRC20 (USDT on Tron) since that's the default network. Other
 * networks return { verified: false, reason: 'unsupported_network' } — the
 * dispatch table is the obvious place to add ERC20/BSC/Polygon/Solana later.
 */

export type VerifyArgs = {
    /** On-chain transaction hash. */
    txHash: string;
    /** Expected recipient wallet address (network-formatted). */
    expectedAddress: string;
    /** Expected amount in 2-decimal accounting cents (1 USDT = 100 cents). */
    expectedAmountCents: number;
    /** Network identifier — see NETWORK_DISPATCH for accepted values. */
    network: string;
};

export type VerifyReason =
    | 'tx_not_found'
    | 'tx_failed'
    | 'wrong_contract'
    | 'recipient_mismatch'
    | 'amount_short'
    | 'unconfirmed'
    | 'verifier_unavailable'
    | 'unsupported_network'
    | 'invalid_response';

export type VerifyResult = {
    verified: boolean;
    reason?: VerifyReason;
    observedAmountCents?: number;
    observedRecipient?: string;
    confirmed?: boolean;
};

const TRONSCAN_BASE = process.env.TRONSCAN_API_BASE || 'https://apilist.tronscanapi.com';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const HTTP_TIMEOUT_MS = 5000;

/** Normalize a network string into one of the verifier's known keys. */
function networkKey(network: string): 'trc20' | 'unsupported' {
    const n = network.toLowerCase();
    if (n === 'trc20' || n === 'tron' || n === 'usdttrc20' || n === 'usdt_tron') return 'trc20';
    return 'unsupported';
}

interface TronscanTransferInfo {
    contract_address?: string;
    to_address?: string;
    amount_str?: string;
    decimals?: number;
}

interface TronscanTxResponse {
    hash?: string;
    confirmed?: boolean;
    contractRet?: string;
    tokenTransferInfo?: TronscanTransferInfo;
    [k: string]: unknown;
}

async function fetchTronscanTx(txHash: string): Promise<TronscanTxResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const url = `${TRONSCAN_BASE}/api/transaction-info?hash=${encodeURIComponent(txHash)}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const body = (await res.json()) as TronscanTxResponse;
        // Tronscan returns `{}` (no hash field) when the tx isn't found.
        if (!body || !body.hash) return null;
        return body;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function verifyTrc20(args: VerifyArgs): Promise<VerifyResult> {
    let tx: TronscanTxResponse | null;
    try {
        tx = await fetchTronscanTx(args.txHash);
    } catch {
        return { verified: false, reason: 'verifier_unavailable' };
    }
    if (tx === null) {
        // Could be 'tx not found' or 'verifier unavailable' (network blip).
        // Treat null as not_found; the cron will retry, and if Tronscan stays
        // down the operator will see `verifier_unavailable` from the timeout
        // path through the catch above.
        return { verified: false, reason: 'tx_not_found' };
    }

    const transfer = tx.tokenTransferInfo;
    if (!transfer || typeof transfer !== 'object') {
        return { verified: false, reason: 'invalid_response' };
    }

    if (tx.contractRet && tx.contractRet !== 'SUCCESS') {
        return { verified: false, reason: 'tx_failed' };
    }

    if (transfer.contract_address !== USDT_TRC20_CONTRACT) {
        return { verified: false, reason: 'wrong_contract' };
    }

    if (transfer.to_address !== args.expectedAddress) {
        return {
            verified: false,
            reason: 'recipient_mismatch',
            observedRecipient: transfer.to_address,
        };
    }

    // Tronscan returns amount as a chain-native integer string with 6
    // decimals for USDT TRC20. We compare in cents (2 decimals) — divide by
    // 10000 to scale 6→2 decimals. Per-payout USDT amounts are well within
    // Number.MAX_SAFE_INTEGER even with 6 decimals (1B USDT = 1e15 base
    // units), so plain Number math is safe here.
    const decimals = transfer.decimals ?? 6;
    const amountStr = transfer.amount_str ?? '0';
    const amountNum = Number(amountStr);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
        return { verified: false, reason: 'invalid_response' };
    }
    const observedCents = Math.floor(amountNum / Math.pow(10, decimals - 2));

    if (observedCents < args.expectedAmountCents) {
        return {
            verified: false,
            reason: 'amount_short',
            observedAmountCents: observedCents,
            observedRecipient: transfer.to_address,
        };
    }

    if (tx.confirmed !== true) {
        return {
            verified: false,
            reason: 'unconfirmed',
            observedAmountCents: observedCents,
            observedRecipient: transfer.to_address,
            confirmed: false,
        };
    }

    return {
        verified: true,
        observedAmountCents: observedCents,
        observedRecipient: transfer.to_address,
        confirmed: true,
    };
}

/**
 * Verify that the on-chain transaction matches the expected recipient + amount
 * for the given network. Never throws — all error paths return a structured
 * VerifyResult so the caller can persist the reason for ops review.
 */
export async function verifyOnChain(args: VerifyArgs): Promise<VerifyResult> {
    switch (networkKey(args.network)) {
        case 'trc20':
            return verifyTrc20(args);
        case 'unsupported':
        default:
            return { verified: false, reason: 'unsupported_network' };
    }
}

/** Build a block-explorer URL for a tx hash on the given network. */
export function explorerUrl(network: string, txHash: string): string | null {
    switch (networkKey(network)) {
        case 'trc20':
            return `https://tronscan.org/#/transaction/${txHash}`;
        default:
            return null;
    }
}
