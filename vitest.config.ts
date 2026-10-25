import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
        environment: 'node',
        testTimeout: 20_000,
        pool: 'forks',
    },
});
