import type { CryptoDisbursementProvider } from './types';
import { ShkeeperProvider } from './providers/shkeeper';
import { StubProvider } from './providers/stub';

export * from './types';

let cached: CryptoDisbursementProvider | null = null;

/**
 * Lazy-singleton accessor for the configured crypto-disbursement provider.
 * Reads `CRYPTO_DISBURSEMENT_PROVIDER` from env (default: 'shkeeper'). Use
 * `'stub'` for local dev so the payout flow runs without a real network.
 */
export function getProvider(): CryptoDisbursementProvider {
    if (cached) return cached;
    const choice = (process.env.CRYPTO_DISBURSEMENT_PROVIDER || 'shkeeper').toLowerCase();
    switch (choice) {
        case 'stub':
            cached = new StubProvider();
            break;
        case 'shkeeper':
        default:
            cached = new ShkeeperProvider();
            break;
    }
    return cached;
}

/** Test-only: drop the cached provider so a new env value takes effect. */
export function _resetProviderForTests(): void {
    cached = null;
}
