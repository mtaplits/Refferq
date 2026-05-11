import { z } from 'zod';
import {
    ALL_CURRENCIES,
    ALL_PAYOUT_METHODS,
    isValidCurrencyForTreasury,
    isValidPayoutMethodForTreasury,
    type TreasuryType,
} from './currency-allowlist';

// Currency / Treasury Validation
export const treasuryTypeSchema = z.enum(['FIAT', 'CRYPTO']);
export const currencySchema = z.enum(ALL_CURRENCIES);
export const payoutMethodSchema = z.enum(ALL_PAYOUT_METHODS);

// Wallet address (basic EVM regex; Tron/non-EVM addresses bypass strict format check at this layer)
export const evmWalletAddressSchema = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid wallet address (expected 0x... 40-hex-char EVM address)');

// Referral Validation
export const referralSchema = z.object({
    leadName: z.string().min(2, 'Name must be at least 2 characters'),
    leadEmail: z.string().email('Invalid email address'),
    company: z.string().optional(),
    notes: z.string().optional(),
    estimatedValue: z.number().min(0).max(999999999).optional(),
});

// Affiliate Creation Validation (Admin)
export const affiliateCreateSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters').optional(),
});

// Payout Validation
export const payoutSchema = z.object({
    affiliateId: z.string(),
    commissionIds: z.array(z.string()).min(1, 'At least one commission is required'),
    method: z.string().optional(),
    notes: z.string().optional(),
});

// Payout Status Update Validation
export const payoutUpdateSchema = z.object({
    id: z.string(),
    status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
    method: z.string().optional(),
    notes: z.string().optional(),
});

// Program Settings Validation
//
// Cross-validates that the chosen currency and payout methods are consistent
// with the declared treasury type. Programs cannot mix fiat and crypto.
export const programSettingsSchema = z
    .object({
        productName: z.string().min(1),
        programName: z.string().min(1),
        websiteUrl: z.string().url(),
        treasuryType: treasuryTypeSchema.default('FIAT'),
        currency: currencySchema,
        minPayoutCents: z.number().min(0),
        cookieDuration: z.number().int().min(1),
        payoutMethods: z.array(payoutMethodSchema).optional(),
    })
    .refine((d) => isValidCurrencyForTreasury(d.currency, d.treasuryType), {
        message: 'Currency does not match treasury type (FIAT vs CRYPTO)',
        path: ['currency'],
    })
    .refine(
        (d) =>
            !d.payoutMethods ||
            d.payoutMethods.every((m) => isValidPayoutMethodForTreasury(m, d.treasuryType)),
        {
            message: 'One or more payout methods are not valid for the chosen treasury type',
            path: ['payoutMethods'],
        }
    );

// MLM rule (level >= 2) validation: callers should also check at save time
// that the sum of level rates does not exceed the level-1 rate when the program
// is in SPLIT_FROM_DIRECT mode. That sum check lives in the route because it
// requires querying the existing rules; this schema only validates a single rule.
export const commissionRuleSchema = z.object({
    name: z.string().min(1),
    type: z.enum(['PERCENTAGE', 'FIXED']),
    value: z.number().min(0),
    level: z.number().int().min(1).max(10).default(1),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
});

// Helper: validate currency + treasury together without going through a full schema
export function assertCurrencyForTreasury(currency: string, treasuryType: TreasuryType): void {
    if (!isValidCurrencyForTreasury(currency, treasuryType)) {
        throw new Error(
            `Currency ${currency} is not valid for treasury type ${treasuryType}`
        );
    }
}
