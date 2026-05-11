import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
        // Integration tests live in tests/integration and need a DB; run them
        // via `npm run test:integration` (separate config).
        exclude: ['node_modules', '.next', '.claude', 'tests/integration/**'],
        environment: 'node',
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
});
