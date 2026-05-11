import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        include: ['tests/integration/**/*.test.ts'],
        exclude: ['node_modules', '.next', '.claude'],
        environment: 'node',
        // Pin a test DB URL so the prisma singleton picks it up the first
        // time it's accessed. The setup file truncates between tests.
        env: {
            DATABASE_URL: 'postgresql://marshallt@localhost:5432/refferq_test',
            // Stub crypto provider so no real network/provider call goes out.
            CRYPTO_DISBURSEMENT_PROVIDER: 'stub',
            // Webhook signing is bypassed by api-key auth in tests
            // (we seed an ApiKey row in the setup helper).
            NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        },
        setupFiles: ['./tests/integration/setup.ts'],
        // DB-touching tests must not race for the same rows. `fileParallelism:
        // false` runs each test file end-to-end before starting the next, so
        // the truncate hook can never race a seed in a sibling file.
        pool: 'forks',
        fileParallelism: false,
        // Slow paths (route handlers + DB) need a bit more time.
        testTimeout: 15_000,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
});
