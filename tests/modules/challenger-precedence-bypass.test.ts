import { describe, expect, it } from 'vitest';
import { createModelRuntimeReport } from '../../src/modules/models/runtime-adapters';
import type { MonarchModelCatalog } from '../../src/modules/models/model-catalog';

describe('Loopback Precedence Bypass Verification', () => {
  const passingLoopbacks = [
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'http://[::1]:8080',
    'http://0.0.0.0:8080',
    '127.0.0.5:9000',
    'localhost:3000',
    '[::1]',
    '::1',
    '::1:8080',
  ];

  passingLoopbacks.forEach((endpoint) => {
    it(`bypasses missing weights and disabled check for valid loopback: ${endpoint}`, () => {
      const catalog: MonarchModelCatalog = {
        root: 'test-models',
        exists: true,
        updatedAt: new Date().toISOString(),
        models: [
          {
            role: 'gemma4-fast',
            directoryName: 'gemma4-fast',
            label: 'Gemma4 Fast Model',
            description: 'Disabled and missing weights model',
            status: 'missing', // missing weights status
            enabled: false,    // profile disabled
            totalSizeBytes: 0,
            totalSize: '0 B',
            primaryAsset: undefined,
            assets: [],
          },
        ],
      };

      const env: NodeJS.ProcessEnv = {
        'MONARCH_GEMMA4-FAST_MODEL_ENDPOINT': endpoint,
        MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS: 'false',
      };

      const report = createModelRuntimeReport(catalog, env);
      const entry = report.entries.find((e) => e.role === 'gemma4-fast');

      expect(entry).toBeDefined();
      expect(entry?.runnerStatus).toBe('ready');
      expect(entry?.canInfer).toBe(true);
      expect(entry?.endpoint).toBe(endpoint);
      expect(entry?.detail).toBe('Local model endpoint is configured.');
    });
  });

  it('does NOT bypass if the endpoint is not a loopback and MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS is false', () => {
    const catalog: MonarchModelCatalog = {
      root: 'test-models',
      exists: true,
      updatedAt: new Date().toISOString(),
      models: [
        {
          role: 'gemma4-fast',
          directoryName: 'gemma4-fast',
          label: 'Gemma4 Fast Model',
          description: 'Disabled and missing weights model',
          status: 'missing',
          enabled: false,
          totalSizeBytes: 0,
          totalSize: '0 B',
          primaryAsset: undefined,
          assets: [],
        },
      ],
    };

    const env: NodeJS.ProcessEnv = {
      'MONARCH_GEMMA4-FAST_MODEL_ENDPOINT': 'http://example.com:8080',
      MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS: 'false',
    };

    const report = createModelRuntimeReport(catalog, env);
    const entry = report.entries.find((e) => e.role === 'gemma4-fast');

    expect(entry).toBeDefined();
    expect(entry?.runnerStatus).toBe('disabled');
    expect(entry?.canInfer).toBe(false);
  });
});
