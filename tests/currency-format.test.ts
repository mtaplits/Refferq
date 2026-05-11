import { describe, expect, it } from 'vitest';
import { formatCurrency, getSymbolForCurrency } from '@/lib/currency';

describe('formatCurrency (Feature A)', () => {
    it('prefixes fiat currencies with their symbol', () => {
        expect(formatCurrency(12345, 'USD')).toBe('$123.45');
        expect(formatCurrency(0, 'USD')).toBe('$0.00');
    });

    it('suffixes crypto codes (USDT)', () => {
        expect(formatCurrency(12345, 'USDT')).toBe('123.45 USDT');
        expect(formatCurrency(100, 'USDT')).toBe('1.00 USDT');
    });

    it('accepts raw symbols for backwards compatibility', () => {
        expect(formatCurrency(100, '$')).toBe('$1.00');
        expect(formatCurrency(100, '₹')).toBe('₹1.00');
    });

    it('handles negative amounts', () => {
        expect(formatCurrency(-12345, 'USD')).toContain('123.45');
        expect(formatCurrency(-12345, 'USDT')).toContain('USDT');
    });

    it('looks up symbol for known codes', () => {
        expect(getSymbolForCurrency('USD')).toBe('$');
        expect(getSymbolForCurrency('INR')).toBe('₹');
        expect(getSymbolForCurrency('USDT')).toBe('USDT');
        expect(getSymbolForCurrency('XYZ')).toBe('XYZ');
    });
});
