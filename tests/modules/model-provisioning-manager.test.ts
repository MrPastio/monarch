import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonarchRuntimePaths } from '../../src/core/runtime-paths';
import {
  MonarchModelProvisioningManager,
  type ModelGroupDefinition,
} from '../../src/modules/models/model-provisioning-manager';
import type { MonarchModelComponentSpec } from '../../src/modules/models/component-manager';

const roots: string[] = [];
const managers: MonarchModelProvisioningManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MonarchModelProvisioningManager', () => {
  it('recommends a small model on weak hardware but still installs any owner selection', async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const key = String(url).split('/').at(-1)!;
      return response(fixture.payloads.get(key)!);
    });
    const manager = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 4 * 1024 ** 3,
    }));

    const initial = await manager.initialize();
    expect(initial.onboarding).toMatchObject({ required: true, recommendedRole: 'gemma4-fast' });
    expect(initial.models.find((model) => model.role === 'qwen3.8-27b-pro')?.warning)
      .toBe('На этом компьютере модель может работать медленнее.');

    manager.startInstallModels(['qwen3.8-27b-pro'], 'onboarding');
    await vi.waitFor(() => expect(manager.snapshot().onboarding.completed).toBe(true));
    expect(manager.snapshot().onboarding).toMatchObject({
      completion: 'installed',
      welcomeRequired: true,
    });
    expect(manager.snapshot().models.find((model) => model.role === 'qwen3.8-27b-pro'))
      .toMatchObject({ installed: true, complete: true });
    await manager.acknowledgeOnboardingWelcome();
    expect(manager.snapshot().onboarding.welcomeRequired).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('adopts an existing supported model and skips first-run without downloading', async () => {
    const fixture = await createFixture();
    const balanced = fixture.groups[1]!.components[0]!;
    const target = path.join(fixture.paths.modelsRoot, ...balanced.relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fixture.payloads.get(balanced.remoteFile)!);
    const fetchImpl = vi.fn();
    const manager = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 16 * 1024 ** 3,
      availableMemoryBytes: 10 * 1024 ** 3,
    }));

    const snapshot = await manager.initialize();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.onboarding).toMatchObject({
      required: false,
      completed: true,
      completion: 'adopted',
      welcomeRequired: false,
    });
    expect(snapshot.models.find((model) => model.role === 'gemma4-balanced')?.installed).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    const checkpoint = JSON.parse(await readFile(
      path.join(fixture.paths.stateRoot, 'components', 'model-setup.v1.json'),
      'utf8',
    ));
    expect(checkpoint.selectedRoles).toEqual(['gemma4-balanced']);
  });

  it('installs all three models from one explicit selection', async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const key = String(url).split('/').at(-1)!;
      return response(fixture.payloads.get(key)!);
    });
    const manager = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 32 * 1024 ** 3,
      availableMemoryBytes: 24 * 1024 ** 3,
    }));
    await manager.initialize();

    manager.startInstallModels(
      ['gemma4-fast', 'gemma4-balanced', 'qwen3.8-27b-pro'],
      'onboarding',
    );
    await vi.waitFor(() => expect(manager.snapshot().onboarding.completed).toBe(true));
    expect(manager.snapshot().models.every((model) => model.complete)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('persists an explicit skip and presents the post-setup welcome only until acknowledged', async () => {
    const fixture = await createFixture();
    const fetchImpl = vi.fn();
    const manager = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 4 * 1024 ** 3,
    }));
    await manager.initialize();

    const skipped = await manager.skipOnboarding();
    expect(skipped.ready).toBe(false);
    expect(skipped.onboarding).toMatchObject({
      required: false,
      completed: true,
      completion: 'skipped',
      selectedRoles: [],
      welcomeRequired: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const restarted = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 4 * 1024 ** 3,
    }));
    expect((await restarted.initialize()).onboarding.welcomeRequired).toBe(true);
    await restarted.acknowledgeOnboardingWelcome();

    const acknowledged = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 4 * 1024 ** 3,
    }));
    expect((await acknowledged.initialize()).onboarding).toMatchObject({
      completion: 'skipped',
      welcomeRequired: false,
    });
  });

  it('migrates a completed v1 setup without replaying the new welcome for existing users', async () => {
    const fixture = await createFixture();
    const setupPath = path.join(fixture.paths.stateRoot, 'components', 'model-setup.v1.json');
    await mkdir(path.dirname(setupPath), { recursive: true });
    await writeFile(setupPath, JSON.stringify({
      schemaVersion: 1,
      completed: true,
      selectedRoles: ['gemma4-fast'],
      error: null,
      updatedAt: new Date(0).toISOString(),
    }), 'utf8');
    const manager = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: vi.fn() as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 4 * 1024 ** 3,
    }));

    expect((await manager.initialize()).onboarding).toMatchObject({
      completed: true,
      completion: 'adopted',
      welcomeRequired: false,
    });
  });

  it('derives the manual fallback files and immutable download links from the pinned specs', async () => {
    const fixture = await createFixture();
    const manager = track(new MonarchModelProvisioningManager(fixture.paths, {
      groups: fixture.groups,
      fetchImpl: vi.fn() as typeof fetch,
      retryDelaysMs: [0],
      totalMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 4 * 1024 ** 3,
    }));

    const snapshot = await manager.initialize();
    expect(snapshot.models[0]?.manualInstall).toEqual([{
      fileName: 'fast.gguf',
      directory: 'models/gemma4-fast',
      url: `https://huggingface.co/test/models/resolve/${'a'.repeat(40)}/fast.gguf`,
    }]);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-model-setup-'));
  roots.push(root);
  const paths: MonarchRuntimePaths = {
    mode: 'installed',
    workspaceRoot: path.join(root, 'version'),
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
    coderWorkspaceRoot: path.join(root, 'coder'),
    coderSandboxRoot: path.join(root, 'sandbox'),
  };
  const roles = [
    ['gemma4-fast', 'Basic 2B', 'fast.gguf', 8],
    ['gemma4-balanced', 'Basic 12B', 'balanced.gguf', 16],
    ['qwen3.8-27b-pro', 'Pro 27B', 'pro.gguf', 30],
  ] as const;
  const payloads = new Map<string, Buffer>();
  const groups: ModelGroupDefinition[] = roles.map(([role, label, remoteFile, recommendedRamGb]) => {
    const payload = Buffer.from(`GGUF${role}`);
    payloads.set(remoteFile, payload);
    const spec: MonarchModelComponentSpec = {
      id: `model.${role}.text`,
      role,
      label,
      provider: 'Test',
      license: 'Test',
      revision: 'a'.repeat(40),
      repository: 'test/models',
      remoteFile,
      relativePath: `models/${role}/${remoteFile}`,
      expectedBytes: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    };
    return {
      role,
      label,
      summary: label,
      beta: role === 'qwen3.8-27b-pro',
      recommendedRamGb,
      components: [spec],
    };
  });
  return { paths, groups, payloads };
}

function response(payload: Buffer): Response {
  const value = new Response(payload, {
    status: 200,
    headers: { 'content-length': String(payload.length) },
  });
  Object.defineProperty(value, 'url', { value: 'https://huggingface.co/test/models/resolve/main/model.gguf' });
  return value;
}

function track(manager: MonarchModelProvisioningManager): MonarchModelProvisioningManager {
  managers.push(manager);
  return manager;
}
