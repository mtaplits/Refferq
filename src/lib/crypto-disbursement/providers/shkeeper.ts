import type {
    CryptoDisbursementProvider,
    CryptoSendArgs,
    CryptoSendResult,
    CryptoStatus,
} from '../types';
import { CryptoDisbursementError } from '../types';

interface ShkeeperConfig {
    baseUrl: string;
    username: string;
    password: string;
    network: string; // e.g. 'usdt_tron', 'usdt_eth', 'usdt_polygon'
}

function readConfig(): ShkeeperConfig {
    const baseUrl = process.env.SHKEEPER_BASE_URL?.replace(/\/$/, '');
    const username = process.env.SHKEEPER_USERNAME;
    const password = process.env.SHKEEPER_PASSWORD;
    const network = process.env.SHKEEPER_USDT_NETWORK || 'usdt_tron';
    if (!baseUrl || !username || !password) {
        throw new CryptoDisbursementError(
            'SHKeeper is not configured. Set SHKEEPER_BASE_URL, SHKEEPER_USERNAME, SHKEEPER_PASSWORD, SHKEEPER_USDT_NETWORK.'
        );
    }
    return { baseUrl, username, password, network };
}

function authHeader(cfg: ShkeeperConfig): string {
    const token = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    return `Basic ${token}`;
}

function centsToDecimalString(cents: number): string {
    // SHKeeper accepts the amount as a human-readable decimal string ("12.34").
    // Internal scaling to chain-native base units (6 decimals for USDT) is
    // handled by SHKeeper itself.
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / 100);
    const frac = (abs % 100).toString().padStart(2, '0');
    return `${sign}${whole}.${frac}`;
}

export class ShkeeperProvider implements CryptoDisbursementProvider {
    readonly id = 'shkeeper';
    readonly currency = 'USDT' as const;

    async send(args: CryptoSendArgs): Promise<CryptoSendResult> {
        const cfg = readConfig();
        const url = `${cfg.baseUrl}/api/v1/${cfg.network}/multipayout`;

        const payload = [
            {
                amount: centsToDecimalString(args.amountCents),
                dest: args.toAddress,
                callback_url: args.callbackUrl,
                external_id: args.payoutId,
            },
        ];

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: authHeader(cfg),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });
        } catch (err) {
            return {
                taskId: '',
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
            };
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return {
                taskId: '',
                status: 'failed',
                error: `SHKeeper returned HTTP ${res.status}: ${text || res.statusText}`,
            };
        }

        let body: unknown;
        try {
            body = await res.json();
        } catch (err) {
            return {
                taskId: '',
                status: 'failed',
                error: `SHKeeper returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
            };
        }

        // SHKeeper's multipayout returns a task descriptor per entry. We sent
        // one entry, so we expect either an array of length 1 or a single
        // object; defensive about either shape.
        const first = Array.isArray(body) ? body[0] : (body as Record<string, unknown>);
        if (!first || typeof first !== 'object') {
            return { taskId: '', status: 'failed', error: 'Unexpected SHKeeper response shape' };
        }
        const obj = first as Record<string, unknown>;
        const taskId = (obj.task_id ?? obj.id ?? obj.taskId ?? '') as string;
        if (!taskId) {
            return { taskId: '', status: 'failed', error: 'SHKeeper response missing task_id' };
        }
        return { taskId, status: 'queued' };
    }

    async getStatus(taskId: string): Promise<CryptoStatus> {
        const cfg = readConfig();
        const url = `${cfg.baseUrl}/api/v1/${cfg.network}/task/${encodeURIComponent(taskId)}`;
        let res: Response;
        try {
            res = await fetch(url, {
                method: 'GET',
                headers: { Authorization: authHeader(cfg) },
            });
        } catch {
            return 'pending';
        }
        if (!res.ok) return 'pending';
        let body: Record<string, unknown>;
        try {
            body = (await res.json()) as Record<string, unknown>;
        } catch {
            return 'pending';
        }
        const status = String(body.status ?? '').toLowerCase();
        if (status === 'confirmed' || status === 'paid' || status === 'success') return 'confirmed';
        if (status === 'failed' || status === 'error') return 'failed';
        return 'pending';
    }
}
