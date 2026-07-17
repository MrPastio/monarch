import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // marketing-site is an isolated Sites repository with node:test coverage.
    // Root Vitest must not collect its independent test runner files.
    exclude: [...configDefaults.exclude, 'marketing-site/**'],
  },
});
