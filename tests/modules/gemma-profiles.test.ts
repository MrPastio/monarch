import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { readModelCatalog, type MonarchModelRole } from '../../src/modules/models/model-catalog';
import { estimateMemoryAndAdjust, completeWithModelRole } from '../../src/modules/models/runtime-client';
import { createModelRuntimeReport } from '../../src/modules/models/runtime-adapters';

describe('Gemma Profiles Config Parsing (Registry Parsing)', () => {
  it('should parse gemma 4 profiles config containing fast, balanced, deepthinking, and experimental models', async () => {
    const catalog = await readModelCatalog(process.cwd());
    const gemmaModels = catalog.models.filter((model) => model.family === 'gemma');
    const coderModels = catalog.models.filter((model) => model.role === 'qwen3-coder-30b-a3b-instruct' || model.role === 'deepseek-coder-v2-lite-instruct');
    expect(gemmaModels).toHaveLength(4);
    expect(coderModels).toHaveLength(2);

    const fast = catalog.models.find(m => m.role === 'gemma4-fast');
    expect(fast).toBeDefined();
    expect(fast?.size).toBe('E2B');
    expect(fast?.quantization).toBe('Q5_K_M');
    expect(fast?.backend).toBe('oscar-managed-backend');
    expect(fast?.mainModelPath).toBe('gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf');
    expect(fast?.modelPath).toBe('gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf');
    expect(fast?.mmprojPath).toBe('gemma_models/vision_other/mmproj-BF16_E2B.gguf');
    expect(fast?.draftModelPath).toBe('gemma_models/mtp_model/mtp-gemma-4-E2B-it.gguf');
    expect(fast?.draftMode).toBe('mtp');
    expect(fast?.speculativeDecoding).toBe(true);
    expect(fast?.ctxDefault).toBe(2048);
    expect(fast?.ctxMax).toBe(4096);
    expect(fast?.gpuLayers).toBe(16);
    expect(fast?.ramBudgetMb).toBe(4096);
    expect(fast?.vramBudgetMb).toBe(2048);
    expect(fast?.enabled).toBe(true);
    expect(fast?.experimental).toBe(false);

    const balanced = catalog.models.find(m => m.role === 'gemma4-balanced');
    expect(balanced).toBeDefined();
    expect(balanced?.size).toBe('12B');
    expect(balanced?.mmprojPath).toBe('gemma_models/vision_other/mmproj-BF16_12B.gguf');
    expect(balanced?.draftModelPath).toBe('gemma_models/mtp_model/mtp-gemma-4-12b-it.gguf');
    expect(balanced?.ctxDefault).toBe(4096);
    expect(balanced?.gpuLayers).toBe(32);
    expect(balanced?.ramBudgetMb).toBe(8192);
    expect(balanced?.vramBudgetMb).toBe(6144);
    expect(balanced?.enabled).toBe(true);
    expect(balanced?.experimental).toBe(false);

    const deepthinking = catalog.models.find(m => m.role === 'gemma4-deepthinking');
    expect(deepthinking).toBeDefined();
    expect(deepthinking?.size).toBe('26B');
    expect(deepthinking?.mainModelPath).toBe('gemma_models/Gemma_26B/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf');
    expect(deepthinking?.draftModelPath).toBe('gemma_models/mtp_model/mtp-gemma-4-26B-A4B-it.gguf');
    expect(deepthinking?.ctxDefault).toBe(8192);
    expect(deepthinking?.gpuLayers).toBe(0);
    expect(deepthinking?.ramBudgetMb).toBe(24576);
    expect(deepthinking?.vramBudgetMb).toBe(1024);
    expect(deepthinking?.enabled).toBe(true);
    expect(deepthinking?.experimental).toBe(true);

    const m31b = catalog.models.find(m => m.role === 'gemma4-31b');
    expect(m31b).toBeDefined();
    expect(m31b?.size).toBe('31B');
    expect(m31b?.mainModelPath).toBe('gemma_models/Gemma_31B/gemma-4-31B-it-Q4_K_S.gguf');
    expect(m31b?.draftModelPath).toBe('gemma_models/mtp_model/mtp-gemma-4-31B-it.gguf');
    expect(m31b?.gpuLayers).toBe(0);
    expect(m31b?.ramBudgetMb).toBe(32768);
    expect(m31b?.vramBudgetMb).toBe(1024);
    expect(m31b?.enabled).toBe(true);
    expect(m31b?.experimental).toBe(true);
  });

  it('should allow an explicit environment override for gemma4-31b', async () => {
    const prev = process.env.MONARCH_ENABLE_GEMMA4_31B;

    try {
      process.env.MONARCH_ENABLE_GEMMA4_31B = 'true';
      let catalog = await readModelCatalog(process.cwd());
      expect(catalog.models.find(m => m.role === 'gemma4-31b')?.enabled).toBe(true);

      process.env.MONARCH_ENABLE_GEMMA4_31B = '1';
      catalog = await readModelCatalog(process.cwd());
      expect(catalog.models.find(m => m.role === 'gemma4-31b')?.enabled).toBe(true);

      process.env.MONARCH_ENABLE_GEMMA4_31B = 'yes';
      catalog = await readModelCatalog(process.cwd());
      expect(catalog.models.find(m => m.role === 'gemma4-31b')?.enabled).toBe(true);

      process.env.MONARCH_ENABLE_GEMMA4_31B = 'on';
      catalog = await readModelCatalog(process.cwd());
      expect(catalog.models.find(m => m.role === 'gemma4-31b')?.enabled).toBe(true);

      process.env.MONARCH_ENABLE_GEMMA4_31B = 'false';
      catalog = await readModelCatalog(process.cwd());
      expect(catalog.models.find(m => m.role === 'gemma4-31b')?.enabled).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.MONARCH_ENABLE_GEMMA4_31B;
      } else {
        process.env.MONARCH_ENABLE_GEMMA4_31B = prev;
      }
    }
  });
});

describe('Gemma Profiles - Detection of Missing Models', () => {
  it('should detect models as missing if their weight files do not exist on disk', async () => {
    const emptyTempDir = path.join(process.cwd(), 'temp_test_workspace_missing');
    if (fs.existsSync(emptyTempDir)) fs.rmSync(emptyTempDir, { recursive: true, force: true });
    fs.mkdirSync(emptyTempDir, { recursive: true });

    const catalog = await readModelCatalog(emptyTempDir);
    const fast = catalog.models.find(m => m.role === 'gemma4-fast');
    expect(fast?.status).toBe('missing'); // weights not found on disk

    fs.rmSync(emptyTempDir, { recursive: true, force: true });
  });

  it('should reject zero-filled GGUF placeholders as unavailable models', async () => {
    const tempDir = path.join(process.cwd(), 'temp_test_workspace_invalid_gguf');
    fs.mkdirSync(path.join(tempDir, 'gemma_models', 'Gemma_E2B'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'gemma_models', 'Gemma_E2B', 'gemma-4-E2B-it-Q4_K_M.gguf'),
      Buffer.alloc(256)
    );

    try {
      const catalog = await readModelCatalog(tempDir);
      const fast = catalog.models.find((model) => model.role === 'gemma4-fast');
      expect(fast?.status).toBe('partial');
      expect(fast?.primaryAsset).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Gemma Profiles - Readiness Status Reporting & Health Checks', () => {
  const tempDir = path.join(process.cwd(), 'temp_test_workspace_profiles');
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(tempDir, 'gemma_models', 'Gemma_12B'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'gemma_models', 'Gemma_26B'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'gemma_models', 'Gemma_E2B'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'gemma_models', 'mtp_model'), { recursive: true });
    process.env.MONARCH_WORKSPACE_ROOT = tempDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should report readiness status correctly based on profile properties (loading, missing, unhealthy)', async () => {
    // 1. gemma4-31b is enabled but missing
    // 2. gemma4-balanced has .crdownload file -> loading
    // 3. gemma4-fast is missing -> missing
    // 4. gemma4-deepthinking has file size < 100 -> unhealthy (health validation)

    fs.writeFileSync(
      path.join(tempDir, 'gemma_models', 'Gemma_12B', 'gemma-4-12B-it-Q4_K_M.gguf.crdownload'),
      ''
    );
    fs.writeFileSync(
      path.join(tempDir, 'gemma_models', 'Gemma_26B', 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf'),
      'GGUFshort' // valid header but < 100 bytes
    );

    const catalog = await readModelCatalog(tempDir);
    const report = createModelRuntimeReport(catalog, process.env);

    const m31b = report.entries.find(e => e.role === 'gemma4-31b');
    expect(m31b?.runnerStatus).toBe('missing');
    expect(m31b?.canInfer).toBe(false);

    const balanced = report.entries.find(e => e.role === 'gemma4-balanced');
    expect(balanced?.runnerStatus).toBe('loading');
    expect(balanced?.canInfer).toBe(false);

    const fast = report.entries.find(e => e.role === 'gemma4-fast');
    expect(fast?.runnerStatus).toBe('missing');
    expect(fast?.canInfer).toBe(false);

    const deepthinking = report.entries.find(e => e.role === 'gemma4-deepthinking');
    expect(deepthinking?.runnerStatus).toBe('unhealthy');
    expect(deepthinking?.canInfer).toBe(false);
  });

  it('should report readiness status correctly when valid weights exist (present, experimental)', async () => {
    // 1. gemma4-fast: valid weights exist (>= 100 bytes) -> present
    // 2. gemma4-deepthinking: valid weights exist (>= 100 bytes) -> experimental

    const dummyWeights = Buffer.alloc(200, 'x');
    dummyWeights.write('GGUF', 0, 'ascii');
    fs.writeFileSync(
      path.join(tempDir, 'gemma_models', 'Gemma_E2B', 'gemma-4-E2B-it-Q5_K_M.gguf'),
      dummyWeights
    );
    fs.writeFileSync(
      path.join(tempDir, 'gemma_models', 'mtp_model', 'mtp-gemma-4-E2B-it.gguf'),
      dummyWeights
    );
    fs.writeFileSync(
      path.join(tempDir, 'gemma_models', 'Gemma_26B', 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf'),
      dummyWeights
    );

    const catalog = await readModelCatalog(tempDir);
    const report = createModelRuntimeReport(catalog, process.env);

    const fast = report.entries.find(e => e.role === 'gemma4-fast');
    expect(fast?.runnerStatus).toBe('present');
    expect(fast?.canInfer).toBe(true);
    expect(fast?.modelAsset).toBe('gemma-4-E2B-it-Q5_K_M.gguf');
    expect(fast?.draftModelAsset).toBe('mtp-gemma-4-E2B-it.gguf');
    expect(fast?.draftMode).toBe('mtp');
    expect(fast?.speculativeDecoding).toBe(true);

    const deepthinking = report.entries.find(e => e.role === 'gemma4-deepthinking');
    expect(deepthinking?.runnerStatus).toBe('experimental');
    expect(deepthinking?.canInfer).toBe(true);
  });
});

describe('Gemma Profiles - Startup Safety', () => {
  it('should ensure no weights files (.gguf or .safetensors) are loaded or read during catalog scanning or server startup', async () => {
    const fsPromisesReadFileSpy = vi.spyOn(fsPromises, 'readFile');
    const fsReadFileSyncSpy = vi.spyOn(fs, 'readFileSync');

    const catalog = await readModelCatalog(process.cwd());
    const report = createModelRuntimeReport(catalog, process.env);

    expect(catalog).toBeDefined();
    expect(report).toBeDefined();

    const verifyNoWeightsRead = (argsList: any[]) => {
      for (const args of argsList) {
        const filePath = String(args[0] || '');
        const ext = path.extname(filePath).toLowerCase();
        expect(ext).not.toBe('.gguf');
        expect(ext).not.toBe('.safetensors');
      }
    };

    verifyNoWeightsRead(fsPromisesReadFileSpy.mock.calls);
    verifyNoWeightsRead(fsReadFileSyncSpy.mock.calls);

    fsPromisesReadFileSpy.mockRestore();
    fsReadFileSyncSpy.mockRestore();
  });
});

describe('Memory Safety Budget and Handlers', () => {
  it('should adjust context length and GPU layers dynamically to fit memory budget', () => {
    const profile: any = {
      role: 'gemma4-balanced',
      size: '12B',
      ctxDefault: 4096,
      ctxMax: 8192,
      gpuLayers: 32,
      ramBudgetMb: 8192,
      vramBudgetMb: 6144,
    };

    const res = estimateMemoryAndAdjust(profile);
    expect(res.allowed).toBe(true);
    expect(res.ctxLength).toBe(1024);
    expect(res.gpuLayers).toBe(0);
  });

  it('should reject requests if memory budget is completely exceeded even at minimum settings', () => {
    const profile: any = {
      role: 'gemma4-balanced',
      size: '12B',
      ctxDefault: 4096,
      ctxMax: 8192,
      gpuLayers: 32,
      ramBudgetMb: 4096,
      vramBudgetMb: 1024,
    };

    const res = estimateMemoryAndAdjust(profile);
    expect(res.allowed).toBe(false);
    expect(res.error).toBe('memory-budget-exceeded');
  });
});

describe('DeepThinking constraints & Rejection', () => {
  const tempDir = path.join(process.cwd(), 'temp_test_workspace_deepthinking');
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(tempDir, 'gemma_models', 'Gemma_26B'), { recursive: true });
    process.env.MONARCH_WORKSPACE_ROOT = tempDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should reject DeepThinking requests with gemma-mode-disabled when MONARCH_GEMMA_MODE is false', async () => {
    const catalog = await readModelCatalog(process.cwd());
    const request = {
      role: 'gemma4-deepthinking' as MonarchModelRole,
      selectionSource: 'user-explicit' as const,
      deepThinkingConsent: 'allow' as const,
      messages: [{ role: 'user' as const, content: 'test' }],
    };
    const result = await completeWithModelRole(catalog, request, {
      ...process.env,
      MONARCH_GEMMA_MODE: 'false',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('gemma-mode-disabled');
  });

  it('should reject DeepThinking requests with gemma-profile-disabled when gemma4-deepthinking is disabled in the catalog', async () => {
    const catalog = await readModelCatalog(process.cwd());
    const dt = catalog.models.find((m) => m.role === 'gemma4-deepthinking');
    if (dt) {
      dt.enabled = false;
    }
    const request = {
      role: 'gemma4-deepthinking' as MonarchModelRole,
      selectionSource: 'user-explicit' as const,
      deepThinkingConsent: 'allow' as const,
      messages: [{ role: 'user' as const, content: 'test' }],
    };
    const result = await completeWithModelRole(catalog, request, {
      ...process.env,
      MONARCH_GEMMA_MODE: 'true',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('gemma-profile-disabled');
  });

  it('should reject DeepThinking requests with memory-budget-exceeded when budget checks fail', async () => {
    const validWeights = Buffer.alloc(200, 'x');
    validWeights.write('GGUF', 0, 'ascii');
    fs.writeFileSync(
      path.join(tempDir, 'gemma_models', 'Gemma_26B', 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf'),
      validWeights
    );
    const catalog = await readModelCatalog(tempDir);
    const dt = catalog.models.find((m) => m.role === 'gemma4-deepthinking');
    if (dt) {
      dt.enabled = true;
      dt.ramBudgetMb = 1;
      dt.vramBudgetMb = 1;
    }
    const request = {
      role: 'gemma4-deepthinking' as MonarchModelRole,
      selectionSource: 'user-explicit' as const,
      deepThinkingConsent: 'allow' as const,
      messages: [{ role: 'user' as const, content: 'test' }],
    };
    const result = await completeWithModelRole(catalog, request, {
      ...process.env,
      MONARCH_GEMMA_MODE: 'true',
      MONARCH_WORKSPACE_ROOT: tempDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('memory-budget-exceeded');
  });

  it('should bypass missing weight status check when loopback endpoint is configured', async () => {
    const catalog = await readModelCatalog(process.cwd());
    const m31b = catalog.models.find((m) => m.role === 'gemma4-31b');
    if (m31b) {
      m31b.enabled = true; // Set to true so profile check passes, but weights are missing
      m31b.status = 'missing';
    }

    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { content: 'Loopback bypassed missing weights successfully' } }]
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as any).port);
      });
    });

    const endpoint = `http://127.0.0.1:${port}`;

    try {
      const request = {
        role: 'gemma4-31b' as MonarchModelRole,
        selectionSource: 'user-explicit' as const,
        deepThinkingConsent: 'allow' as const,
        messages: [{ role: 'user' as const, content: 'test bypass' }],
      };
      const result = await completeWithModelRole(catalog, request, {
        ...process.env,
        MONARCH_GEMMA_MODE: 'true',
        'MONARCH_GEMMA4-31B_MODEL_ENDPOINT': endpoint,
      });

      console.log('TEST RESULT (MISSING WEIGHTS BYPASS):', result);
      expect(result.ok).toBe(true);
      expect(result.rawText).toBe('Loopback bypassed missing weights successfully');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should bypass profile enabled check when loopback endpoint is configured', async () => {
    const catalog = await readModelCatalog(process.cwd());
    const m31b = catalog.models.find((m) => m.role === 'gemma4-31b');
    if (m31b) {
      m31b.enabled = false; // Set to false to test if it bypasses profile disabled
      m31b.status = 'missing';
    }

    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Loopback bypassed profile enabled check successfully' } }] }));
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as any).port);
      });
    });

    const endpoint = `http://127.0.0.1:${port}`;

    try {
      const request = {
        role: 'gemma4-31b' as MonarchModelRole,
        selectionSource: 'user-explicit' as const,
        deepThinkingConsent: 'allow' as const,
        messages: [{ role: 'user' as const, content: 'test bypass' }],
      };
      const result = await completeWithModelRole(catalog, request, {
        ...process.env,
        MONARCH_GEMMA_MODE: 'true',
        'MONARCH_GEMMA4-31B_MODEL_ENDPOINT': endpoint,
      });

      console.log('TEST RESULT (ENABLED BYPASS):', result);
      expect(result.ok).toBe(true);
      expect(result.rawText).toBe('Loopback bypassed profile enabled check successfully');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should bypass gemma mode disabled check when loopback endpoint is configured', async () => {
    const catalog = await readModelCatalog(process.cwd());
    const m31b = catalog.models.find((m) => m.role === 'gemma4-31b');
    if (m31b) {
      m31b.enabled = true;
      m31b.status = 'available';
    }

    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'Loopback bypassed gemma mode disabled check successfully' } }] }));
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as any).port);
      });
    });

    const endpoint = `http://127.0.0.1:${port}`;

    try {
      const request = {
        role: 'gemma4-31b' as MonarchModelRole,
        selectionSource: 'user-explicit' as const,
        deepThinkingConsent: 'allow' as const,
        messages: [{ role: 'user' as const, content: 'test bypass' }],
      };
      const result = await completeWithModelRole(catalog, request, {
        ...process.env,
        MONARCH_GEMMA_MODE: 'false',
        'MONARCH_GEMMA4-31B_MODEL_ENDPOINT': endpoint,
      });

      expect(result.ok).toBe(true);
      expect(result.rawText).toBe('Loopback bypassed gemma mode disabled check successfully');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
