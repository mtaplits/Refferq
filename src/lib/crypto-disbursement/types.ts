export type CryptoSendStatus = 'queued' | 'broadcast' | 'confirmed' | 'failed';

export interface CryptoSendArgs {
    /** Destination wallet address (EVM or chain-specific, depending on adapter). */
    toAddress: string;
    /** Amount in 2-decimal accounting cents (1 USDT = 100 cents). */
    amountCents: number;
    /** Refferq payout ID — passed through as the provider's external_id for idempotency. */
    payoutId: string;
    /** URL the provider should POST status updates to. */
    callbackUrl: string;
}

export interface CryptoSendResult {
    /** Provider-side task / job ID, used to query status later. */
    taskId: string;
    /** Initial status after the queue call. */
    status: 'queued' | 'failed';
    /** On `failed`, a human-readable error message. */
    error?: string;
}

export type CryptoStatus = 'pending' | 'confirmed' | 'failed';

export interface CryptoDisbursementProvider {
    /** Stable adapter identifier, e.g. 'shkeeper' or 'stub'. */
    readonly id: string;
    /** Currency code this adapter operates in (currently only USDT). */
    readonly currency: 'USDT';

    /** Enqueue a payout. The provider is expected to broadcast asynchronously
     *  and POST status updates to `callbackUrl`. */
    send(args: CryptoSendArgs): Promise<CryptoSendResult>;

    /** Look up the current state of a queued task. Used as a fallback by the
     *  reconcile cron when callbacks are missed. */
    getStatus(taskId: string): Promise<CryptoStatus>;
}

export class CryptoDisbursementError extends Error {
    constructor(
        message: string,
        readonly cause?: unknown
    ) {
        super(message);
        this.name = 'CryptoDisbursementError';
    }
}
