import { defineConfig } from 'vitest/config';

// `npm test`: the tests that need no card data. Each test file gets its own empty database in a
// temp folder (tests/setup-unit-db.ts), so these tests never touch data/app.db.
// `npm run test:db` (vitest.db.config.ts) also runs the tests below. They read data/app.db and
// need a synced pool and your own atoms, rules and builds.
export const LOCAL_DB_TESTS = [
  'tests/cr-duplicates.test.ts',
  'tests/deck-export.test.ts',
  'tests/e2e-pool.test.ts',
  'tests/edge-packets.test.ts',
  'tests/extract.test.ts',
  'tests/kernel.test.ts',
  'tests/rate-fit.test.ts',
  'tests/redact.test.ts',
  'tests/select-batch.test.ts',
  'tests/terms.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: LOCAL_DB_TESTS,
    setupFiles: ['tests/setup-env.ts', 'tests/setup-unit-db.ts'],
  },
});
