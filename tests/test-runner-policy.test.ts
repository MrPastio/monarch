import { describe, expect, it } from 'vitest';
import config from '../vitest.config';

describe('repository test runner resource policy', () => {
  it('bounds file and in-worker concurrency for Windows full-suite runs', () => {
    expect(config).toMatchObject({
      test: {
        maxWorkers: 4,
        maxConcurrency: 4,
      },
    });
  });
});
