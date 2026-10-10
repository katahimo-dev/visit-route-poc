import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'functions/src/**/*.test.ts', 'web/src/**/*.test.ts'],
        },
      },
      { test: { name: 'rules', include: ['tests/rules/**/*.test.ts'], testTimeout: 20000 } },
    ],
  },
});
