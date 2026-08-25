import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeMonarchModelRoleAlias,
  readModelCatalog,
} from '../../src/modules/models/model-catalog';
import { createModelRuntimeReport } from '../../src/modules/models/runtime-adapters';
import { estimateMemoryAndAdjust } from '../../src/modules/models/runtime-client';

describe('active local model profiles', () => {
  it('exposes Basic Gemma plus one Qwen3.8 27B Pro and no retired large Gemma', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'monarch-model-profile-contract-'));
    try {
      const catalog = await readModelCatalog(root);
      expect(catalog.models.map((model) => model.role)).toEqual([
        'gemma4-fast',
        'gemma4-balanced',
        'qwen3.8-27b-pro',
        'qwen3-coder-30b-a3b-instruct',
        'deepseek-coder-v2-lite-instruct',
      ]);
      expect(catalog.models.find((model) => model.role === 'gemma4-fast')).toMatchObject({
        size: 'E2B',
        mainModelPath: 'gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf',
        ctxDefault: 2048,
        ctxMax: 4096,
        enabled: true,
        experimental: false,
      });
      expect(catalog.models.find((model) => model.role === 'gemma4-balanced')).toMatchObject({
        size: '12B',
        mainModelPath: 'gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf',
        ctxDefault: 4096,
        ctxMax: 8192,
        enabled: true,
        experimental: false,
      });
      expect(catalog.models.find((model) => model.role === 'qwen3.8-27b-pro')).toMatchObject({
        family: 'qwen3.8',
        size: '27B',
        mainModelPath: 'qwen_models/Qwen3.8_27B/Qwen3.8-27B-Q4_K_M.gguf',
        mmprojPath: 'qwen_models/Qwen3.8_27B/mmproj-Qwen3.8-27B-Q8_0.gguf',
        draftModelPath: 'qwen_models/Qwen3.8_27B/mtp-Qwen3.8-27B-Q4_0.gguf',
        ctxDefault: 32768,
        ctxMax: 262144,
        gpuLayers: 18,
        ramBudgetMb: 28672,
        vramBudgetMb: 7168,
        enabled: true,
        experimental: true,
      });
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  it('migrates retired Pro and Extra identifiers without restoring their profiles', async () => {
    for (const legacy of ['powerful', 'reasoning', 'gemma4-deepthinking', 'gemma4-31b'] as const) {
      expect(normalizeMonarchModelRoleAlias(legacy)).toBe('qwen3.8-27b-pro');
    }
    const previous = process.env.MONARCH_ENABLE_GEMMA4_31B;
    process.env.MONARCH_ENABLE_GEMMA4_31B = 'true';
    try {
      const catalog = await readModelCatalog(process.cwd());
      expect(catalog.models.some((model) => model.role === 'gemma4-deepthinking')).toBe(false);
      expect(catalog.models.some((model) => model.role === 'gemma4-31b')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MONARCH_ENABLE_GEMMA4_31B;
      else process.env.MONARCH_ENABLE_GEMMA4_31B = previous;
    }
  });
});

describe('model catalog detection and readiness', () => {
  it('uses an external models root without leaking workspace weights', async () => {
    const workspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'monarch-model-workspace-'));
    const modelsRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'monarch-model-external-'));
    const previous = process.env.MONARCH_MODELS_ROOT;
    try {
      await writeGguf(path.join(workspace, 'gemma_models', 'Gemma_12B', 'gemma-4-12B-it-Q4_K_M.gguf'));
      await writeGguf(path.join(modelsRoot, 'gemma_models', 'Gemma_E2B', 'gemma-4-E2B-it-Q5_K_M.gguf'));
      process.env.MONARCH_MODELS_ROOT = modelsRoot;
      const catalog = await readModelCatalog(workspace);
      expect(catalog.root).toBe(path.join(modelsRoot, 'gemma_models'));
      expect(catalog.models.find((model) => model.role === 'gemma4-fast')?.status).toBe('available');
      expect(catalog.models.find((model) => model.role === 'gemma4-balanced')?.status).toBe('missing');
    } finally {
      if (previous === undefined) delete process.env.MONARCH_MODELS_ROOT;
      else process.env.MONARCH_MODELS_ROOT = previous;
      await fsPromises.rm(workspace, { recursive: true, force: true });
      await fsPromises.rm(modelsRoot, { recursive: true, force: true });
    }
  });

  it('rejects zero-filled placeholders', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'monarch-model-invalid-'));
    try {
      const target = path.join(root, 'gemma_models', 'Gemma_E2B', 'gemma-4-E2B-it-Q5_K_M.gguf');
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      await fsPromises.writeFile(target, Buffer.alloc(256));
      const model = (await readModelCatalog(root)).models.find((entry) => entry.role === 'gemma4-fast');
      expect(model?.status).toBe('partial');
      expect(model?.primaryAsset).toBeUndefined();
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  it('reports Basic loading and Qwen Pro experimental readiness from GGUF headers', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'monarch-model-ready-'));
    try {
      await writeGguf(path.join(root, 'gemma_models', 'Gemma_E2B', 'gemma-4-E2B-it-Q5_K_M.gguf'));
      const partial = path.join(root, 'gemma_models', 'Gemma_12B', 'gemma-4-12B-it-Q4_K_M.gguf.crdownload');
      await fsPromises.mkdir(path.dirname(partial), { recursive: true });
      await fsPromises.writeFile(partial, '');
      await writeGguf(path.join(root, 'qwen_models', 'Qwen3.8_27B', 'Qwen3.8-27B-Q4_K_M.gguf'));
      const report = createModelRuntimeReport(await readModelCatalog(root));
      expect(report.entries.find((entry) => entry.role === 'gemma4-fast')).toMatchObject({ runnerStatus: 'present', canInfer: true });
      expect(report.entries.find((entry) => entry.role === 'gemma4-balanced')).toMatchObject({ runnerStatus: 'loading', canInfer: false });
      expect(report.entries.find((entry) => entry.role === 'qwen3.8-27b-pro')).toMatchObject({ runnerStatus: 'ready', canInfer: true });
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  it('does not read model payloads while building the catalog and readiness report', async () => {
    const asyncRead = vi.spyOn(fsPromises, 'readFile');
    const syncRead = vi.spyOn(fs, 'readFileSync');
    try {
      createModelRuntimeReport(await readModelCatalog(process.cwd()));
      for (const [value] of [...asyncRead.mock.calls, ...syncRead.mock.calls]) {
        expect(['.gguf', '.safetensors']).not.toContain(path.extname(String(value)).toLowerCase());
      }
    } finally {
      asyncRead.mockRestore();
      syncRead.mockRestore();
    }
  });
});

describe('model memory budgets', () => {
  it('reduces Basic offload/context under pressure', () => {
    expect(estimateMemoryAndAdjust({
      role: 'gemma4-balanced', size: '12B', ctxDefault: 4096, ctxMax: 8192,
      gpuLayers: 32, ramBudgetMb: 8192, vramBudgetMb: 6144,
    } as any)).toMatchObject({ allowed: true, ctxLength: 1024, gpuLayers: 0 });
  });

  it('rejects an impossible Qwen Pro budget instead of loading unsafely', () => {
    expect(estimateMemoryAndAdjust({
      role: 'qwen3.8-27b-pro', size: '27B', ctxDefault: 32768, ctxMax: 262144,
      gpuLayers: 18, ramBudgetMb: 1, vramBudgetMb: 1,
    } as any)).toEqual({ allowed: false, error: 'memory-budget-exceeded' });
  });
});

async function writeGguf(target: string): Promise<void> {
  const payload = Buffer.alloc(200, 'x');
  payload.write('GGUF', 0, 'ascii');
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await fsPromises.writeFile(target, payload);
}
