import { defineConfig } from 'vitest/config';
import { clearRepositoryEnv } from './vitest.git-env.ts';

clearRepositoryEnv();

export default defineConfig({
    test: {
        include: ['e2e/**/*.e2e.ts'],
        environment: 'node',
        testTimeout: 60_000,
        hookTimeout: 60_000,
        pool: 'forks',
    },
});
