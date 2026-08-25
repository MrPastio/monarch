import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonarchRuntimePaths } from '../../src/core/runtime-paths';
import {
  MonarchModelComponentManager,
  MONARCH_REQUIRED_FAST_MODEL,
  MONARCH_OPTIONAL_PRO_MODEL_COMPONENTS,
  type MonarchModelComponentSpec,
} from '../../src/modules/models/component-manager';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MonarchModelComponentManager', () => {
  it('pins the previously distributed official E2B payload as an accepted existing variant', () => {
    expect(MONARCH_REQUIRED_FAST_MODEL.acceptedExistingVariants).toContainEqual({
      revision: '739965d73654c0ead8020786aa998fc813070087',
      expectedBytes: 3_356_035_200,
      sha256: 'd8fc2ac6fd597481dfd9c5ef9543ea1f0bda8088086da3853ce5e5564ab43bf8',
    });
  });

  it('keeps a pinned legacy payload installed without replacing it', async () => {
    const fixture = await createFixture();
    const legacyPayload = Buffer.concat([Buffer.from('GGUF'), Buffer.from('legacy-official-model')]);
    const spec: MonarchModelComponentSpec = {
      ...fixture.spec,
      acceptedExistingVariants: [{
        revision: 'abcdef0123456789abcdef0123456789abcdef01',
        expectedBytes: legacyPayload.length,
        sha256: createHash('sha256').update(legacyPayload).digest('hex'),
      }],
    };
    await mkdir(path.dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, legacyPayload);
    const fetchImpl = vi.fn();
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
    });

    expect((await manager.inspectInstalled()).ready).toBe(true);
    expect((await manager.ensureRequiredModel()).ready).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(fixture.target)).toEqual(legacyPayload);
  });

  it('pins Qwen Pro payloads without putting them in automatic required repair', () => {
    expect(MONARCH_OPTIONAL_PRO_MODEL_COMPONENTS).toEqual([
      expect.objectContaining({
        id: 'model.qwen3.8-27b-pro.text',
        expectedBytes: 18_973_870_432,
        sha256: '31629f53165ab6a7dad8c9847dcfd1fdf55829dac1e6e748f4a68581b0033d34',
      }),
      expect.objectContaining({
        id: 'model.qwen3.8-27b-pro.mtp',
        expectedBytes: 1_680_271_648,
        sha256: '051a1764cff8c4f3ee6ae8b00593a0364c7539c67fa50ffc58f3f96509fca38e',
      }),
      expect.objectContaining({
        id: 'model.qwen3.8-27b-pro.vision',
        expectedBytes: 629_247_008,
        sha256: '2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb',
      }),
    ]);
    expect(MONARCH_OPTIONAL_PRO_MODEL_COMPONENTS.every((spec) => Object.isFrozen(spec))).toBe(true);
  });
  it('downloads, verifies, and atomically activates the required model', async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn(async () => response(fixture.payload));
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready, result.requiredModel.errorCode || '').toBe(true);
    expect(result).toMatchObject({ requiredModel: { phase: 'ready', progress: 1 } });
    expect(await readFile(fixture.target)).toEqual(fixture.payload);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const state = JSON.parse(await readFile(
      path.join(fixture.paths.stateRoot, 'components', 'models.v1.json'),
      'utf8',
    ));
    expect(state.ready).toBe(true);
  });

  it('resumes a partial download with an exact Range request', async () => {
    const fixture = await createFixture();
    const offset = 9;
    await mkdir(path.dirname(fixture.target), { recursive: true });
    await writeFile(`${fixture.target}.monarch-download`, fixture.payload.subarray(0, offset));
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Range).toBe(`bytes=${offset}-`);
      return response(fixture.payload.subarray(offset), 206, {
        'content-range': `bytes ${offset}-${fixture.payload.length - 1}/${fixture.payload.length}`,
      });
    });
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    expect((await manager.ensureRequiredModel()).ready).toBe(true);
    expect(await readFile(fixture.target)).toEqual(fixture.payload);
  });

  it('resumes through the bounded system transport when the fetch body stalls', async () => {
    const fixture = await createFixture();
    const split = 7;
    const stalled = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(fixture.payload.subarray(0, split)));
      },
    }), {
      status: 200,
      headers: { 'content-length': String(fixture.payload.length) },
    });
    Object.defineProperty(stalled, 'url', {
      value: 'https://cas-bridge.xethub.hf.co/repos/test/model.gguf',
    });
    const systemDownloadImpl = vi.fn(async (request) => {
      expect(request.offset).toBe(split);
      await request.onChunk(Uint8Array.from(fixture.payload.subarray(request.offset)));
    });
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: vi.fn(async () => stalled) as typeof fetch,
      systemDownloadImpl,
      downloadStallTimeoutMs: 25,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready, result.requiredModel.errorCode || '').toBe(true);
    expect(systemDownloadImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(fixture.target)).toEqual(fixture.payload);
  });

  it('verifies and activates an already complete partial without downloading it again', async () => {
    const fixture = await createFixture();
    await mkdir(path.dirname(fixture.target), { recursive: true });
    await writeFile(`${fixture.target}.monarch-download`, fixture.payload);
    const fetchImpl = vi.fn();
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    expect((await manager.ensureRequiredModel()).ready).toBe(true);
    expect(await readFile(fixture.target)).toEqual(fixture.payload);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('quarantines a hash mismatch and never activates it', async () => {
    const fixture = await createFixture();
    const bad = Buffer.from(fixture.payload);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    const fetchImpl = vi.fn(async () => response(bad));
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0, 0, 0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(false);
    expect(result.requiredModel.phase).toBe('failed');
    await expect(stat(fixture.target)).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantine = await readdir(path.join(
      fixture.paths.modelsRoot,
      '.monarch-quarantine',
      fixture.spec.id,
    ));
    expect(quarantine).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(stat(path.join(fixture.paths.stateRoot, 'components', 'quarantine')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const restartFetch = vi.fn(async () => response(bad));
    const restarted = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: restartFetch as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0, 0, 0],
    });
    const restartedResult = await restarted.ensureRequiredModel();
    expect(restartedResult.ready).toBe(false);
    expect(restartedResult.requiredModel.errorCode).toContain('model-component-quarantine-hold');
    expect(restartFetch).not.toHaveBeenCalled();
    expect(await readdir(path.join(
      fixture.paths.modelsRoot,
      '.monarch-quarantine',
      fixture.spec.id,
    ))).toHaveLength(1);
  });

  it('keeps an invalid installed payload on the model volume while state remains small', async () => {
    const fixture = await createFixture();
    await mkdir(path.dirname(fixture.target), { recursive: true });
    await writeFile(fixture.target, Buffer.from('GGUFinvalid-installed-copy'));
    const fetchImpl = vi.fn(async () => response(fixture.payload));
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    expect((await manager.ensureRequiredModel()).ready).toBe(true);
    expect(await readFile(fixture.target)).toEqual(fixture.payload);
    const quarantineRoot = path.join(
      fixture.paths.modelsRoot,
      '.monarch-quarantine',
      fixture.spec.id,
    );
    expect(path.parse(quarantineRoot).root).toBe(path.parse(fixture.paths.modelsRoot).root);
    expect(path.relative(fixture.paths.modelsRoot, quarantineRoot)).not.toMatch(/^\.\./u);
    expect(await readdir(quarantineRoot)).toHaveLength(1);
    expect(await readdir(path.join(fixture.paths.stateRoot, 'components'))).toEqual(['models.v1.json']);
  });

  it('rejects a component target that escapes the configured model root', async () => {
    const fixture = await createFixture();
    expect(() => new MonarchModelComponentManager(fixture.paths, {
      spec: { ...fixture.spec, relativePath: '../outside.gguf' },
      autoRepairEnabled: false,
    })).toThrowError('model-component-path-outside-models-root');
  });

  it('rejects a quarantine junction before moving a model outside modelsRoot', async () => {
    const fixture = await createFixture();
    const external = path.join(path.dirname(fixture.paths.modelsRoot), 'outside-quarantine');
    await mkdir(path.dirname(fixture.target), { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(fixture.target, Buffer.from('GGUFinvalid-installed-copy'));
    await symlink(
      external,
      path.join(fixture.paths.modelsRoot, '.monarch-quarantine'),
      'junction',
    );
    const fetchImpl = vi.fn();
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(false);
    expect(result.requiredModel.errorCode).toContain('model-quarantine-ancestor-reparse-point');
    expect(await readFile(fixture.target, 'utf8')).toBe('GGUFinvalid-installed-copy');
    expect(await readdir(external)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a junction in the target ancestry before creating a partial outside modelsRoot', async () => {
    const fixture = await createFixture();
    const external = path.join(path.dirname(fixture.paths.modelsRoot), 'outside-target');
    await mkdir(fixture.paths.modelsRoot, { recursive: true });
    await mkdir(external, { recursive: true });
    await symlink(external, path.join(fixture.paths.modelsRoot, 'gemma_models'), 'junction');
    const fetchImpl = vi.fn();
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(false);
    expect(result.requiredModel.errorCode).toContain('model-component-target-ancestor-reparse-point');
    expect(await readdir(external)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not stream response bytes through a target junction swapped in during fetch', async () => {
    const fixture = await createFixture();
    const targetDirectory = path.dirname(fixture.target);
    const parkedDirectory = `${targetDirectory}.parked`;
    const external = path.join(path.dirname(fixture.paths.modelsRoot), 'outside-during-fetch');
    await mkdir(targetDirectory, { recursive: true });
    await mkdir(external, { recursive: true });
    const fetchImpl = vi.fn(async () => {
      await rename(targetDirectory, parkedDirectory);
      await symlink(external, targetDirectory, 'junction');
      return response(fixture.payload);
    });
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(false);
    expect(result.requiredModel.errorCode).toContain('EPERM');
    expect(await readdir(external)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a leaf reparse point without reading or changing its external payload', async () => {
    const fixture = await createFixture();
    const external = path.join(path.dirname(fixture.paths.modelsRoot), 'outside-model-leaf');
    const sentinel = path.join(external, 'sentinel.txt');
    await mkdir(path.dirname(fixture.target), { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(sentinel, 'external-sentinel');
    await symlink(external, fixture.target, 'junction');
    const fetchImpl = vi.fn();
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(false);
    expect(result.requiredModel.errorCode).toContain('model-component-target-reparse-point');
    expect(await readFile(sentinel, 'utf8')).toBe('external-sentinel');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a legacy state-volume quarantine without moving or deleting it', async () => {
    const fixture = await createFixture();
    const legacyPayload = path.join(
      fixture.paths.stateRoot,
      'components',
      'quarantine',
      'legacy.gguf',
    );
    await mkdir(path.dirname(fixture.target), { recursive: true });
    await mkdir(path.dirname(legacyPayload), { recursive: true });
    await writeFile(fixture.target, fixture.payload);
    await writeFile(legacyPayload, 'legacy-sentinel');
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: vi.fn() as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    const result = await manager.ensureRequiredModel();
    expect(result.ready).toBe(true);
    expect(result.legacyQuarantine).toEqual({ detected: true, action: 'manual-review' });
    expect(await readFile(legacyPayload, 'utf8')).toBe('legacy-sentinel');
    const persisted = JSON.parse(await readFile(
      path.join(fixture.paths.stateRoot, 'components', 'models.v1.json'),
      'utf8',
    ));
    expect(persisted.legacyQuarantine).toEqual({ detected: true, action: 'manual-review' });
  });

  it('does not auto-install models in development mode', async () => {
    const fixture = await createFixture('development');
    const fetchImpl = vi.fn();
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
    });
    manager.startAutomaticRepair();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.snapshot().autoRepairEnabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('waits for an aborted automatic repair to finish its final checkpoint before stop resolves', async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const manager = new MonarchModelComponentManager(fixture.paths, {
      spec: fixture.spec,
      fetchImpl: fetchImpl as typeof fetch,
      autoRepairEnabled: true,
      retryDelaysMs: [0],
    });

    manager.startAutomaticRepair();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await manager.stop();

    expect(manager.snapshot()).toMatchObject({
      ready: false,
      requiredModel: {
        phase: 'failed',
        errorCode: 'aborted',
      },
    });
    const checkpoint = JSON.parse(await readFile(
      path.join(fixture.paths.stateRoot, 'components', 'models.v1.json'),
      'utf8',
    ));
    expect(checkpoint.requiredModel.phase).toBe('failed');
  });
});

async function createFixture(mode: MonarchRuntimePaths['mode'] = 'installed') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-component-manager-'));
  roots.push(root);
  const payload = Buffer.concat([Buffer.from('GGUF'), Buffer.from('verified-test-model')]);
  const relativePath = 'gemma_models/Gemma_E2B/test-model.gguf';
  const paths: MonarchRuntimePaths = {
    mode,
    workspaceRoot: root,
    installRoot: mode === 'installed' ? path.join(root, 'install') : null,
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
  const spec: MonarchModelComponentSpec = {
    id: 'model.test',
    role: 'gemma4-fast',
    label: 'Test Model',
    provider: 'Fixture',
    license: 'Apache-2.0',
    revision: '0123456789abcdef0123456789abcdef01234567',
    repository: 'fixture/repository',
    remoteFile: 'test-model.gguf',
    relativePath,
    expectedBytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
  return {
    paths,
    spec,
    payload,
    target: path.join(paths.modelsRoot, ...relativePath.split('/')),
  };
}

function response(body: Buffer, status = 200, headers: Record<string, string> = {}): Response {
  const value = new Response(Uint8Array.from(body), {
    status,
    headers: {
      'content-length': String(body.length),
      ...headers,
    },
  });
  Object.defineProperty(value, 'url', {
    value: 'https://cas-bridge.xethub.hf.co/repos/test/model.gguf',
  });
  return value;
}
