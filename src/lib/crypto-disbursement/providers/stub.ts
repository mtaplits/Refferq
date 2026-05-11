import crypto from 'crypto';
import type {
    CryptoDisbursementProvider,
    CryptoSendArgs,
    CryptoSendResult,
    CryptoStatus,
} from '../types';

/**
 * Dev / test no-op provider. Doesn't talk to any network; returns a fake
 * task ID and reports `pending` from `getStatus`. Useful for local end-to-end
 * testing of the payout state machine without making any real provider call.
 */
export class StubProvider implements CryptoDisbursementProvider {
    readonly id = 'stub';
    readonly currency = 'USDT' as const;

    async send(_args: CryptoSendArgs): Promise<CryptoSendResult> {
        const taskId = `stub-${crypto.randomBytes(8).toString('hex')}`;
        return { taskId, status: 'queued' };
    }

    async getStatus(_taskId: string): Promise<CryptoStatus> {
        return 'pending';
    }
}
