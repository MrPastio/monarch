import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonarchRuntimePaths } from '../../src/core/runtime-paths';
import {
  MONARCH_FAST_MODEL_ADDONS,
  MONARCH_MEMORY_SEARCH_COMPONENTS,
  MONARCH_VOICE_RECOGNITION_COMPONENTS,
  MonarchModelComponentManager,
  mapLogicalModelPath,
  type MonarchModelComponentSpec,
} from '../../src/modules/models/component-manager';
import {
  MONARCH_EXTRA_COMPONENT_GROUPS,
  MonarchModelProvisioningManager,
} from '../../src/modules/models/model-provisioning-manager';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Monarch helper components (archives and plain files)', () => {
  it('downloads a pinned archive from a direct source, unpacks it and removes the archive', async () => {
    const paths = await createPaths();
    const archive = Buffer.from('fixture-archive-bytes');
    const spec = archiveSpec(archive, {
      id: 'voice.recognition.fixture',
      targetDirectory: 'runtime/voice/models/fixture-model',
      requiredFiles: ['model.onnx', 'tokens.txt'],
      fileSha256: { 'model.onnx': sha256(Buffer.from('onnx')) },
    });
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(spec.sourceUrl);
      return response(archive, 'https://release-assets.githubusercontent.com/fixture');
    });
    const extractArchiveImpl = vi.fn(async (_archive: string, destination: string) => {
      await mkdir(path.join(destination, 'fixture-model'), { recursive: true });
      await writeFile(path.join(destination, 'fixture-model', 'model.onnx'), 'onnx');
      await writeFile(path.join(destination, 'fixture-model', 'tokens.txt'), 'a 1');
    });
    const manager = new MonarchModelComponentManager(paths, {
      spec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      extractArchiveImpl,
      retryDelaysMs: [0],
    });

    expect((await manager.inspectInstalled()).ready).toBe(false);
    const result = await manager.ensureRequiredModel();
    expect(result.ready, result.requiredModel.errorCode || '').toBe(true);
    // Installed layout keeps Voice files in <models>/voice, where the Voice workers look.
    const voiceRoot = path.join(paths.modelsRoot, 'voice');
    expect(await readFile(path.join(voiceRoot, 'fixture-model', 'tokens.txt'), 'utf8')).toBe('a 1');
    await expect(stat(path.join(voiceRoot, '.downloads', 'fixture.tar.bz2'))).rejects.toThrow();
    expect((await readdir(voiceRoot)).filter((name) => name.startsWith('.monarch-unpack'))).toEqual([]);
    expect((await manager.inspectInstalled()).ready).toBe(true);
  });

  it('does not create the target folder while only checking readiness', async () => {
    const paths = await createPaths();
    const spec = archiveSpec(Buffer.from('x'), {
      id: 'voice.recognition.check',
      targetDirectory: 'runtime/voice/models/check-model',
      requiredFiles: ['model.onnx'],
    });
    const manager = new MonarchModelComponentManager(paths, { spec, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect((await manager.inspectInstalled()).ready).toBe(false);
    await expect(stat(path.join(paths.modelsRoot, 'voice', 'check-model'))).rejects.toThrow();
  });

  it('refuses an archive whose unpacked file does not match its pinned hash', async () => {
    const paths = await createPaths();
    const archive = Buffer.from('fixture-archive-bytes');
    const spec = archiveSpec(archive, {
      id: 'voice.recognition.bad',
      targetDirectory: 'runtime/voice/models/bad-model',
      requiredFiles: ['bin/tool.exe'],
      fileSha256: { 'bin/tool.exe': 'a'.repeat(64) },
    });
    const manager = new MonarchModelComponentManager(paths, {
      spec,
      fetchImpl: vi.fn(async () => response(archive, 'https://github.com/fixture/bad')) as unknown as typeof fetch,
      extractArchiveImpl: async (_archive, destination) => {
        await mkdir(path.join(destination, 'bad-model', 'bin'), { recursive: true });
        await writeFile(path.join(destination, 'bad-model', 'bin', 'tool.exe'), 'tampered');
      },
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(false);
    expect(result.requiredModel.errorCode).toContain('archive-file-sha-mismatch');
    expect(result.requiredModel.error).toBe('Архив скачался, но распаковать его не получилось. Попробуй ещё раз.');
    await expect(stat(path.join(paths.modelsRoot, 'voice', 'bad-model'))).rejects.toThrow();
  });

  it('rejects a direct source that redirects outside the pinned hosts', async () => {
    const paths = await createPaths();
    const payload = Buffer.from('plain-file');
    const spec: MonarchModelComponentSpec = {
      ...baseSpec(payload),
      id: 'memory.fixture',
      role: 'memory-search',
      sourceUrl: 'https://github.com/fixture/file.bin',
      relativePath: 'memory/fixture/file.bin',
      format: 'file',
    };
    const manager = new MonarchModelComponentManager(paths, {
      spec,
      fetchImpl: vi.fn(async () => response(payload, 'https://example.com/file.bin')) as unknown as typeof fetch,
      retryDelaysMs: [0],
    });
    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(false);
    expect(result.requiredModel.errorCode).toBe('model-download-untrusted-redirect');
  });

  it('accepts plain non-GGUF files by size and SHA-256', async () => {
    const paths = await createPaths();
    const payload = Buffer.from('sentencepiece-model');
    const spec: MonarchModelComponentSpec = {
      ...baseSpec(payload),
      id: 'memory.fixture.tokenizer',
      role: 'memory-search',
      relativePath: 'memory/fixture/sentencepiece.bpe.model',
      format: 'file',
    };
    const manager = new MonarchModelComponentManager(paths, {
      spec,
      fetchImpl: vi.fn(async () => response(payload)) as unknown as typeof fetch,
      retryDelaysMs: [0],
    });
    expect((await manager.ensureRequiredModel()).ready).toBe(true);
    expect(await readFile(path.join(paths.modelsRoot, 'memory', 'fixture', 'sentencepiece.bpe.model'))).toEqual(payload);
  });

  it('maps Coder and Voice workspace paths into a separate models root only', () => {
    const installed = { mode: 'installed' as const, modelsRoot: 'E:/Data/models', workspaceRoot: 'E:/App' };
    const development = { mode: 'development' as const, modelsRoot: 'E:/Monarch', workspaceRoot: 'E:/Monarch' };
    expect(mapLogicalModelPath(installed, 'runtime/coder/models/a/b.gguf')).toBe('coder/a/b.gguf');
    expect(mapLogicalModelPath(installed, 'runtime/voice/models/t-one')).toBe('voice/t-one');
    expect(mapLogicalModelPath(installed, 'gemma_models/x.gguf')).toBe('gemma_models/x.gguf');
    expect(mapLogicalModelPath(development, 'runtime/coder/models/a/b.gguf')).toBe('runtime/coder/models/a/b.gguf');
  });

  it('pins the Basic add-ons, Voice recognition and memory search payloads', () => {
    expect(MONARCH_FAST_MODEL_ADDONS.map((spec) => spec.relativePath)).toEqual([
      'gemma_models/vision_other/mmproj-BF16_E2B.gguf',
      'gemma_models/mtp_model/mtp-gemma-4-E2B-it.gguf',
    ]);
    expect(MONARCH_VOICE_RECOGNITION_COMPONENTS.every((spec) => spec.sourceUrl?.startsWith('https://') && spec.extract)).toBe(true);
    expect(MONARCH_MEMORY_SEARCH_COMPONENTS.every((spec) => spec.format === 'file' && /^[a-f0-9]{64}$/u.test(spec.sha256))).toBe(true);
  });
});

describe('Monarch extra downloads in the provisioning snapshot', () => {
  it('lists Coder, Voice and memory packs apart from chat tiers and installs them only on request', async () => {
    const paths = await createPaths();
    const fetchImpl = vi.fn();
    const manager = new MonarchModelProvisioningManager(paths, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      totalMemoryBytes: 32 * 1024 ** 3,
      availableMemoryBytes: 32 * 1024 ** 3,
    });
    const snapshot = await manager.initialize();
    expect(snapshot.models.map((model) => model.role)).toEqual(['gemma4-fast', 'gemma4-balanced', 'qwen3.8-27b-pro']);
    expect(snapshot.extras.map((model) => model.role)).toEqual(MONARCH_EXTRA_COMPONENT_GROUPS.map((group) => group.role));
    expect(snapshot.extras.every((model) => model.kind === 'extra' && !model.installed && model.description)).toBe(true);
    // The Voice archives are unpacked by Monarch, so no manual file list is offered for them.
    expect(snapshot.extras.find((model) => model.role === 'voice-recognition')?.manualInstall).toEqual([]);
    expect(snapshot.extras.find((model) => model.role === 'coder')?.manualInstall[0]?.directory).toBe('coder/qwen3-coder-30b-a3b-instruct');
    expect(snapshot.onboarding.recommendedRole).not.toBe('coder');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('queues a second download started while another one runs', async () => {
    const paths = await createPaths();
    const first = Buffer.from('first-payload');
    const second = Buffer.from('second-payload');
    const fileSpec = (id: string, payload: Buffer, role: MonarchModelComponentSpec['role']): MonarchModelComponentSpec => ({
      ...baseSpec(payload),
      id,
      role,
      remoteFile: `${id}.bin`,
      relativePath: `memory/${id}.bin`,
      format: 'file',
    });
    const fetchImpl = vi.fn(async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(url.includes('first') ? first : second);
    });
    const manager = new MonarchModelProvisioningManager(paths, {
      groups: [],
      extraGroups: [
        { role: 'coder', kind: 'extra', label: 'A', summary: 'a', beta: false, recommendedRamGb: 0, components: [fileSpec('first', first, 'qwen3-coder-30b-a3b-instruct')] },
        { role: 'memory-search', kind: 'extra', label: 'B', summary: 'b', beta: false, recommendedRamGb: 0, components: [fileSpec('second', second, 'memory-search')] },
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0],
    });
    await manager.initialize();
    manager.startInstallModels(['coder'], 'settings');
    manager.startInstallModels(['memory-search'], 'settings');
    expect(manager.snapshot().activeInstall?.roles).toEqual(['coder', 'memory-search']);
    await vi.waitFor(() => expect(manager.snapshot().activeInstall).toBeNull());
    expect(manager.snapshot().extras.map((extra) => extra.installed)).toEqual([true, true]);
  });

  it('never downloads extras from the first-run setup', async () => {
    const paths = await createPaths();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const manager = new MonarchModelProvisioningManager(paths, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0],
    });
    await manager.initialize();
    const snapshot = manager.startInstallModels(['coder', 'memory-search'], 'onboarding');
    expect(snapshot.activeInstall).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function baseSpec(payload: Buffer): MonarchModelComponentSpec {
  return {
    id: 'fixture',
    role: 'voice-recognition',
    label: 'Fixture',
    provider: 'Fixture',
    license: 'MIT',
    revision: 'v1',
    repository: 'fixture/repository',
    remoteFile: 'fixture.tar.bz2',
    relativePath: 'runtime/voice/models/.downloads/fixture.tar.bz2',
    expectedBytes: payload.length,
    sha256: sha256(payload),
  };
}

function archiveSpec(
  archive: Buffer,
  options: { id: string; targetDirectory: string; requiredFiles: string[]; fileSha256?: Record<string, string> },
): MonarchModelComponentSpec {
  return {
    ...baseSpec(archive),
    id: options.id,
    sourceUrl: 'https://github.com/fixture/releases/download/v1/fixture.tar.bz2',
    format: 'file',
    extract: {
      targetDirectory: options.targetDirectory,
      requiredFiles: options.requiredFiles,
      ...(options.fileSha256 ? { fileSha256: options.fileSha256 } : {}),
    },
  };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createPaths(): Promise<MonarchRuntimePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-helper-components-'));
  roots.push(root);
  return {
    mode: 'installed',
    workspaceRoot: root,
    installRoot: path.join(root, 'install'),
    versionRoot: path.join(root, 'version'),
    payloadRoot: path.join(root, 'payload'),
    configRoot: path.join(root, 'config'),
    dataRoot: path.join(root, 'data'),
    logsRoot: path.join(root, 'logs'),
    generatedRoot: path.join(root, 'generated'),
    modelsRoot: path.join(root, 'models'),
    secretsRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'),
    userWorkspaceRoot: path.join(root, 'workspace'),
    coderWorkspaceRoot: path.join(root, 'coder-workspace'),
    coderSandboxRoot: path.join(root, 'coder-sandbox'),
  };
}

function response(body: Buffer, url = 'https://cas-bridge.xethub.hf.co/repos/test/model.bin'): Response {
  const value = new Response(Uint8Array.from(body), {
    status: 200,
    headers: { 'content-length': String(body.length) },
  });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}
