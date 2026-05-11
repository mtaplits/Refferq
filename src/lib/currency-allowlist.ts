export const FIAT_CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'BGN'] as const;
export const CRYPTO_CURRENCIES = ['USDT'] as const;
export const ALL_CURRENCIES = [...FIAT_CURRENCIES, ...CRYPTO_CURRENCIES] as const;

export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];
export type CryptoCurrency = (typeof CRYPTO_CURRENCIES)[number];
export type Currency = (typeof ALL_CURRENCIES)[number];

export type TreasuryType = 'FIAT' | 'CRYPTO';

export const FIAT_PAYOUT_METHODS = [
    'PAYPAL',
    'BANK_TRANSFER',
    'STRIPE',
    'WISE',
    'BANK_CSV',
    'STRIPE_CONNECT',
] as const;
export const CRYPTO_PAYOUT_METHODS = ['USDT_ONCHAIN'] as const;
export const ALL_PAYOUT_METHODS = [...FIAT_PAYOUT_METHODS, ...CRYPTO_PAYOUT_METHODS] as const;

export type FiatPayoutMethod = (typeof FIAT_PAYOUT_METHODS)[number];
export type CryptoPayoutMethod = (typeof CRYPTO_PAYOUT_METHODS)[number];
export type PayoutMethodName = (typeof ALL_PAYOUT_METHODS)[number];

export function currenciesFor(t: TreasuryType): readonly Currency[] {
    return t === 'FIAT' ? FIAT_CURRENCIES : CRYPTO_CURRENCIES;
}

export function payoutMethodsFor(t: TreasuryType): readonly PayoutMethodName[] {
    return t === 'FIAT' ? FIAT_PAYOUT_METHODS : CRYPTO_PAYOUT_METHODS;
}

export function isValidCurrencyForTreasury(currency: string, t: TreasuryType): boolean {
    return (currenciesFor(t) as readonly string[]).includes(currency);
}

export function isValidPayoutMethodForTreasury(method: string, t: TreasuryType): boolean {
    return (payoutMethodsFor(t) as readonly string[]).includes(method);
}

export function isCryptoCurrency(currency: string): currency is CryptoCurrency {
    return (CRYPTO_CURRENCIES as readonly string[]).includes(currency);
}

export function isFiatCurrency(currency: string): currency is FiatCurrency {
    return (FIAT_CURRENCIES as readonly string[]).includes(currency);
}

export function treasuryTypeFor(currency: string): TreasuryType | null {
    if (isCryptoCurrency(currency)) return 'CRYPTO';
    if (isFiatCurrency(currency)) return 'FIAT';
    return null;
}
