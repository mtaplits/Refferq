import type {
    CryptoDisbursementProvider,
    CryptoSendArgs,
    CryptoSendResult,
    CryptoStatus,
} from '../types';
import { CryptoDisbursementError } from '../types';

interface NowPaymentsConfig {
    baseUrl: string;
    apiKey: string;
    email: string;
    password: string;
    network: string;
}

interface JwtCacheEntry {
    token: string;
    expiresAt: number;
}

// Module-level JWT cache: NowPayments JWTs expire in 5 minutes; we cache for 4
// minutes (60s headroom) to avoid clock-skew expirations. A pending refresh
// promise is stored to single-flight concurrent misses.
let jwtCache: JwtCacheEntry | null = null;
let jwtRefreshInFlight: Promise<string> | null = null;

const JWT_TTL_MS = 4 * 60 * 1000;

function readConfig(): NowPaymentsConfig {
    const baseUrl = (process.env.NOWPAYMENTS_BASE_URL || 'https://api.nowpayments.io/v1').replace(/\/$/, '');
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    const email = process.env.NOWPAYMENTS_EMAIL;
    const password = process.env.NOWPAYMENTS_PASSWORD;
    const network = (process.env.NOWPAYMENTS_USDT_NETWORK || 'usdttrc20').toLowerCase();
    if (!apiKey || !email || !password) {
        throw new CryptoDisbursementError(
            'NowPayments is not configured. Set NOWPAYMENTS_API_KEY, NOWPAYMENTS_EMAIL, NOWPAYMENTS_PASSWORD.'
        );
    }
    return { baseUrl, apiKey, email, password, network };
}

function centsToDecimalString(cents: number): string {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / 100);
    const frac = (abs % 100).toString().padStart(2, '0');
    return `${sign}${whole}.${frac}`;
}

async function fetchJwt(cfg: NowPaymentsConfig): Promise<string> {
    const res = await fetch(`${cfg.baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cfg.email, password: cfg.password }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new CryptoDisbursementError(`NowPayments auth failed: HTTP ${res.status} ${text || res.statusText}`);
    }
    const body = (await res.json()) as { token?: string };
    if (!body.token) {
        throw new CryptoDisbursementError('NowPayments auth response missing token');
    }
    return body.token;
}

async function getJwt(cfg: NowPaymentsConfig, force = false): Promise<string> {
    const now = Date.now();
    if (!force && jwtCache && jwtCache.expiresAt > now) {
        return jwtCache.token;
    }
    if (jwtRefreshInFlight) {
        return jwtRefreshInFlight;
    }
    jwtRefreshInFlight = (async () => {
        try {
            const token = await fetchJwt(cfg);
            jwtCache = { token, expiresAt: Date.now() + JWT_TTL_MS };
            return token;
        } finally {
            jwtRefreshInFlight = null;
        }
    })();
    return jwtRefreshInFlight;
}

/** Test-only: clear the module-level JWT cache. */
export function _resetJwtCacheForTests(): void {
    jwtCache = null;
    jwtRefreshInFlight = null;
}

interface PayoutWithdrawalRequest {
    address: string;
    currency: string;
    amount: string;
    ipn_callback_url: string;
    unique_external_id: string;
}

interface PayoutWithdrawalResponse {
    id?: string | number;
    withdrawal_id?: string | number;
    status?: string;
    [k: string]: unknown;
}

interface PayoutCreateResponse {
    id?: string | number;
    batch_withdrawal_id?: string | number;
    withdrawals?: PayoutWithdrawalResponse[];
    [k: string]: unknown;
}

function extractWithdrawalId(body: PayoutCreateResponse): string | null {
    const w = body.withdrawals?.[0];
    if (w) {
        const id = w.id ?? w.withdrawal_id;
        if (id !== undefined && id !== null) return String(id);
    }
    // Some responses may put the id at the top level when batch size is 1.
    const top = body.id ?? body.batch_withdrawal_id;
    return top !== undefined && top !== null ? String(top) : null;
}

export class NowPaymentsProvider implements CryptoDisbursementProvider {
    readonly id = 'nowpayments';
    readonly currency = 'USDT' as const;

    async send(args: CryptoSendArgs): Promise<CryptoSendResult> {
        let cfg: NowPaymentsConfig;
        try {
            cfg = readConfig();
        } catch (err) {
            return {
                taskId: '',
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
            };
        }

        const withdrawal: PayoutWithdrawalRequest = {
            address: args.toAddress,
            currency: cfg.network,
            amount: centsToDecimalString(args.amountCents),
            ipn_callback_url: args.callbackUrl,
            unique_external_id: args.payoutId,
        };

        try {
            // First attempt with cached JWT; one retry on 401 with a forced refresh.
            let res = await this.postPayout(cfg, withdrawal, false);
            if (res.status === 401) {
                res = await this.postPayout(cfg, withdrawal, true);
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return {
                    taskId: '',
                    status: 'failed',
                    error: `NowPayments returned HTTP ${res.status}: ${text || res.statusText}`,
                };
            }
            let body: PayoutCreateResponse;
            try {
                body = (await res.json()) as PayoutCreateResponse;
            } catch (err) {
                return {
                    taskId: '',
                    status: 'failed',
                    error: `NowPayments returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
            const taskId = extractWithdrawalId(body);
            if (!taskId) {
                return {
                    taskId: '',
                    status: 'failed',
                    error: 'NowPayments response missing withdrawal id',
                };
            }
            return { taskId, status: 'queued' };
        } catch (err) {
            return {
                taskId: '',
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    private async postPayout(
        cfg: NowPaymentsConfig,
        withdrawal: PayoutWithdrawalRequest,
        forceJwtRefresh: boolean
    ): Promise<Response> {
        const token = await getJwt(cfg, forceJwtRefresh);
        return fetch(`${cfg.baseUrl}/payout`, {
            method: 'POST',
            headers: {
                'x-api-key': cfg.apiKey,
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ withdrawals: [withdrawal] }),
        });
    }

    async getStatus(taskId: string): Promise<CryptoStatus> {
        let cfg: NowPaymentsConfig;
        try {
            cfg = readConfig();
        } catch {
            return 'pending';
        }
        try {
            let res = await this.getPayout(cfg, taskId, false);
            if (res.status === 401) {
                res = await this.getPayout(cfg, taskId, true);
            }
            if (!res.ok) return 'pending';
            const body = (await res.json()) as { payment_status?: string; status?: string };
            const raw = String(body.payment_status ?? body.status ?? '').toUpperCase();
            if (raw === 'FINISHED') return 'confirmed';
            if (raw === 'FAILED' || raw === 'REJECTED' || raw === 'EXPIRED') return 'failed';
            return 'pending';
        } catch {
            return 'pending';
        }
    }

    private async getPayout(cfg: NowPaymentsConfig, taskId: string, forceJwtRefresh: boolean): Promise<Response> {
        const token = await getJwt(cfg, forceJwtRefresh);
        return fetch(`${cfg.baseUrl}/payout/${encodeURIComponent(taskId)}`, {
            method: 'GET',
            headers: {
                'x-api-key': cfg.apiKey,
                Authorization: `Bearer ${token}`,
            },
        });
    }
}
