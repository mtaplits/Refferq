import { prisma } from './prisma';
import { isCryptoCurrency } from './currency-allowlist';

const CURRENCY_SYMBOLS: Record<string, string> = {
    'USD': '$',
    'EUR': '€',
    'INR': '₹',
    'GBP': '£',
    'BGN': 'лв.',
    'CAD': 'CA$',
    'AUD': 'A$',
    'USDT': 'USDT',
};

export function getSymbolForCurrency(currency: string): string {
    return CURRENCY_SYMBOLS[currency] || currency;
}

export async function getCurrencySymbol(): Promise<string> {
    try {
        const settings = await prisma.programSettings.findFirst();
        const currency = settings?.currency || 'USD';
        return getSymbolForCurrency(currency);
    } catch (error) {
        console.error('Failed to fetch currency symbol:', error);
        return '$';
    }
}

/**
 * Format an amount in cents to a human-readable string.
 *
 * - Fiat currencies are prefixed with their symbol: `$100.00`, `₹100.00`.
 * - Crypto currencies are suffixed with their code: `100.00 USDT`.
 *
 * Both forms use 2-decimal precision (matches our `*Cents` accounting).
 * For backwards compatibility, the second argument may be either a currency
 * code (preferred) or a raw symbol string.
 */
export function formatCurrency(cents: number, currencyOrSymbol: string): string {
    const amount = cents / 100;
    const formatted = amount.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

    if (isCryptoCurrency(currencyOrSymbol)) {
        return `${formatted} ${currencyOrSymbol}`;
    }

    // Treat as a fiat code if it matches our map, otherwise pass through
    // as a raw symbol/prefix (preserves existing call sites that pass `$`, `₹`, etc.).
    const symbol = CURRENCY_SYMBOLS[currencyOrSymbol] ?? currencyOrSymbol;
    return `${symbol}${formatted}`;
}

export async function formatAmount(cents: number): Promise<string> {
    const settings = await prisma.programSettings.findFirst().catch(() => null);
    const currency = settings?.currency || 'USD';
    return formatCurrency(cents, currency);
}
