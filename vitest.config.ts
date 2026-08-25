import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite includes several process/runtime integration files. Letting
    // Vitest mirror every logical CPU caused Windows to expand C:\pagefile.sys
    // by gigabytes during an otherwise healthy full run. Four workers keep
    // useful parallelism while bounding aggregate model/runtime memory.
    maxWorkers: 4,
    maxConcurrency: 4,
    // marketing-site is an isolated Sites repository with node:test coverage.
    // Root Vitest must not collect its independent test runner files.
    exclude: [...configDefaults.exclude, 'marketing-site/**'],
  },
});
