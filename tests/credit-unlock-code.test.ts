import { describe, expect, it } from 'vitest';
import { generateUnlockCode } from '@/lib/credits/evaluate';

describe('unlock code generator (Feature C)', () => {
    it('matches the documented REFQ-XXXX-XXXX-XXXX shape', () => {
        const code = generateUnlockCode();
        expect(code).toMatch(/^REFQ-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('uses an unambiguous alphabet (no O/0/I/1)', () => {
        // The base32 alphabet drops the four most visually-ambiguous chars
        // (0, 1, I, O). L is kept since it's distinguishable in our font.
        for (let i = 0; i < 200; i++) {
            const code = generateUnlockCode();
            const codeBody = code.slice(5); // strip the REFQ- prefix
            expect(codeBody).not.toMatch(/[OI01]/);
        }
    });

    it('produces unique codes across many iterations', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 1_000; i++) {
            seen.add(generateUnlockCode());
        }
        // 80 bits of entropy → vanishingly small collision chance over 1k codes.
        expect(seen.size).toBe(1_000);
    });
});
