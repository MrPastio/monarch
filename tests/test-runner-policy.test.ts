import { describe, expect, it } from 'vitest';
import config, { LIVE_PROCESS_TEST_FILES } from '../vitest.config';

describe('repository test runner resource policy', () => {
  it('bounds file and in-worker concurrency for Windows full-suite runs', () => {
    expect(config).toMatchObject({
      test: {
        maxWorkers: 4,
        maxConcurrency: 4,
      },
    });
  });

  it('runs real Electron/runtime process files alone, after the parallel unit group', () => {
    const projects = (config.test?.projects ?? []) as Array<{ test: { name: string; include?: string[]; exclude?: string[];
      fileParallelism?: boolean; sequence?: { groupOrder?: number } } }>;
    const unit = projects.find(project => project.test.name === 'unit')!;
    const live = projects.find(project => project.test.name === 'live')!;
    expect(live.test).toMatchObject({ include: LIVE_PROCESS_TEST_FILES, fileParallelism: false });
    expect(live.test.sequence!.groupOrder!).toBeGreaterThan(unit.test.sequence!.groupOrder!);
    for (const file of LIVE_PROCESS_TEST_FILES) expect(unit.test.exclude).toContain(file);
  });
});
