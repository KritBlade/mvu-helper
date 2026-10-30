import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.js'],
        environment: 'node',
        globals: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['small-llm/extra-llm-calls-core.js'],
            exclude: ['**/node_modules/**', 'tests/**'],
        },
        reporters: ['verbose'],
        testTimeout: 10000,
    },
});
