import { configDefaults, defineConfig } from 'vitest/config';

/** Files that launch a real Electron window or a product runtime child with
 * 60-120 s process deadlines. Sharing the machine with three other workers made
 * them time out only in full runs (spawnSync ETIMEDOUT, EBUSY teardown) while
 * passing alone. They run as their own group: one file at a time, after the
 * parallel unit group has finished. */
export const LIVE_PROCESS_TEST_FILES = [
  'tests/desktop/astra-product-renderer-live.test.ts',
  'tests/desktop/astra-telegram-electron-acceptance.test.ts',
  // Long fault-injected Telegram soak: timing-sensitive, not a unit test.
  'tests/modules/telegram-soak.test.ts',
];

// marketing-site and the serverless Telegram bot (cloud/telegram-serverless,
// `npm test` there) have their own node:test coverage. Root Vitest must not
// collect those runner files: it finds no Vitest suite and fails the file.
// .claude/worktrees holds other agents' checkouts: their copies of the suite
// must not run (and open live windows) a second time.
const EXCLUDED = [...configDefaults.exclude, 'marketing-site/**', 'cloud/telegram-serverless/**', '.claude/**'];

export default defineConfig({
  test: {
    // The suite includes several process/runtime integration files. Letting
    // Vitest mirror every logical CPU caused Windows to expand C:\pagefile.sys
    // by gigabytes during an otherwise healthy full run. Four workers keep
    // useful parallelism while bounding aggregate model/runtime memory.
    maxWorkers: 4,
    maxConcurrency: 4,
    // Hosted CI runners are several times slower than a developer machine;
    // tests that start a whole application need more than the 5 s default.
    ...(process.env.CI ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
    exclude: EXCLUDED,
    projects: [
      { extends: true, test: { name: 'unit', exclude: [...EXCLUDED, ...LIVE_PROCESS_TEST_FILES], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'live', include: LIVE_PROCESS_TEST_FILES, fileParallelism: false,
        sequence: { groupOrder: 1 } } },
    ],
  },
});
