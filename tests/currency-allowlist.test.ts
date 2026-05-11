import { describe, expect, it } from 'vitest';
import {
    ALL_CURRENCIES,
    CRYPTO_CURRENCIES,
    FIAT_CURRENCIES,
    currenciesFor,
    isCryptoCurrency,
    isFiatCurrency,
    isValidCurrencyForTreasury,
    isValidPayoutMethodForTreasury,
    payoutMethodsFor,
    treasuryTypeFor,
} from '@/lib/currency-allowlist';

describe('currency allowlist (Feature A)', () => {
    it('partitions fiat and crypto currencies', () => {
        // No currency may appear in both buckets.
        for (const c of FIAT_CURRENCIES) {
            expect(CRYPTO_CURRENCIES).not.toContain(c);
        }
        for (const c of CRYPTO_CURRENCIES) {
            expect(FIAT_CURRENCIES).not.toContain(c);
        }
        // ALL_CURRENCIES is the union.
        expect(ALL_CURRENCIES.length).toBe(FIAT_CURRENCIES.length + CRYPTO_CURRENCIES.length);
    });

    it('accepts USDT only for a CRYPTO treasury', () => {
        expect(isValidCurrencyForTreasury('USDT', 'CRYPTO')).toBe(true);
        expect(isValidCurrencyForTreasury('USDT', 'FIAT')).toBe(false);
    });

    it('rejects fiat currencies for a CRYPTO treasury', () => {
        expect(isValidCurrencyForTreasury('USD', 'CRYPTO')).toBe(false);
        expect(isValidCurrencyForTreasury('INR', 'CRYPTO')).toBe(false);
    });

    it('rejects USDT_ONCHAIN for a FIAT treasury and PAYPAL for a CRYPTO one', () => {
        expect(isValidPayoutMethodForTreasury('USDT_ONCHAIN', 'CRYPTO')).toBe(true);
        expect(isValidPayoutMethodForTreasury('USDT_ONCHAIN', 'FIAT')).toBe(false);
        expect(isValidPayoutMethodForTreasury('PAYPAL', 'FIAT')).toBe(true);
        expect(isValidPayoutMethodForTreasury('PAYPAL', 'CRYPTO')).toBe(false);
    });

    it('rejects unknown currencies regardless of treasury', () => {
        expect(isValidCurrencyForTreasury('XYZ', 'FIAT')).toBe(false);
        expect(isValidCurrencyForTreasury('XYZ', 'CRYPTO')).toBe(false);
    });

    it('exposes the right currency set for each treasury type', () => {
        expect(currenciesFor('FIAT')).toEqual(FIAT_CURRENCIES);
        expect(currenciesFor('CRYPTO')).toEqual(CRYPTO_CURRENCIES);
        expect(payoutMethodsFor('FIAT')).toContain('PAYPAL');
        expect(payoutMethodsFor('CRYPTO')).toEqual(['USDT_ONCHAIN']);
    });

    it('classifies currencies by treasury', () => {
        expect(treasuryTypeFor('USD')).toBe('FIAT');
        expect(treasuryTypeFor('USDT')).toBe('CRYPTO');
        expect(treasuryTypeFor('XYZ')).toBeNull();
        expect(isFiatCurrency('USD')).toBe(true);
        expect(isCryptoCurrency('USDT')).toBe(true);
    });
});
