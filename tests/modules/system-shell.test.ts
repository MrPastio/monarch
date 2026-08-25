import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonarchExecutionRequest, MonarchKernelContext } from '../../src/core';
import { SystemShellModule } from '../../src/modules/system-shell';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('system.shell.run', () => {
  it('runs one exact executable and argv without shell interpolation and returns a receipt', async () => {
    const root = await temporaryRoot();
    const module = new SystemShellModule(root);
    const result = await module.executeCapability(request({
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', 'literal & whoami'],
      cwd: root,
      timeoutMs: 5_000,
      networkPosture: 'offline',
    }), context());

    expect(result).toMatchObject({
      ok: true,
      output: {
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        receiptVerified: true,
        networkIsolationEnforced: false,
      },
    });
    expect((result.output as { stdout: string }).stdout.trim()).toBe('literal & whoami');
  });

  it('blocks Safe before spawn in every override state', async () => {
    const root = await temporaryRoot();
    const module = new SystemShellModule(root);
    const input = {
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', 'Q:\\MonarchData\\Safe\\safe-v1\\never-read.txt'],
      cwd: root,
      timeoutMs: 5_000,
      networkPosture: 'inherit',
    };
    const normal = await module.executeCapability(request(input), context());
    const owner = await module.executeCapability(request(input, true), context());
    expect(normal).toMatchObject({ ok: false, error: 'monarch-safe-isolated' });
    expect(owner).toMatchObject({ ok: false, error: 'monarch-safe-isolated' });
  });

  it('keeps ordinary red zones unless the Kernel-authored Owner flag is present', async () => {
    const root = await temporaryRoot();
    const module = new SystemShellModule(root);
    const protectedPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'config', 'SAM');
    const input = {
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', protectedPath],
      cwd: root,
      timeoutMs: 5_000,
      networkPosture: 'inherit',
    };
    expect(await module.executeCapability(request(input), context())).toMatchObject({
      ok: false,
      error: 'shell-red-zone-blocked',
    });
    const owner = await module.executeCapability(request(input, true), context());
    expect(owner).toMatchObject({ ok: true, output: { receiptVerified: true } });
  });

  it('enforces the runtime-owned task roots for cwd and path-like argv before spawn', async () => {
    const root = await temporaryRoot();
    const projectRoot = path.join(root, 'project');
    const outsideRoot = await temporaryRoot();
    await mkdir(projectRoot, { recursive: true });
    const module = new SystemShellModule(root);
    const scopedRequest = (input: unknown): MonarchExecutionRequest => ({
      ...request(input),
      actionScope: { level: 'workspace', roots: [projectRoot] },
    });

    await expect(module.executeCapability(scopedRequest({
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', path.join(projectRoot, 'inside.txt')],
      cwd: projectRoot,
      timeoutMs: 5_000,
      networkPosture: 'offline',
    }), context())).resolves.toMatchObject({ ok: true, output: { receiptVerified: true } });

    await expect(module.executeCapability(scopedRequest({
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', path.join(outsideRoot, 'escape.txt')],
      cwd: projectRoot,
      timeoutMs: 5_000,
      networkPosture: 'offline',
    }), context())).resolves.toMatchObject({
      ok: false,
      error: 'shell-task-scope-blocked',
      metadata: { boundary: { roots: [path.resolve(projectRoot)] } },
    });

    await expect(module.executeCapability(scopedRequest({
      executable: process.execPath,
      args: ['-e', 'console.log("never")'],
      cwd: outsideRoot,
      timeoutMs: 5_000,
      networkPosture: 'offline',
    }), context())).resolves.toMatchObject({ ok: false, error: 'shell-task-scope-blocked' });
  });

  it('fails closed on root cwd, offline network primitives, timeout, and cancellation', async () => {
    const root = await temporaryRoot();
    const module = new SystemShellModule(root);
    const base = {
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: root,
      timeoutMs: 100,
      networkPosture: 'inherit',
    };
    expect(await module.executeCapability(request({ ...base, cwd: path.parse(root).root }), context()))
      .toMatchObject({ ok: false, error: 'root-cwd-blocked' });
    expect(await module.executeCapability(request({
      ...base,
      executable: 'curl.exe',
      args: ['https://example.test'],
      networkPosture: 'offline',
    }), context())).toMatchObject({ ok: false, error: 'network-posture-conflict' });
    expect(await module.executeCapability(request(base), context())).toMatchObject({
      ok: false,
      error: 'timeout',
      output: { timedOut: true },
    });

    const controller = new AbortController();
    const pending = module.executeCapability(request({ ...base, timeoutMs: 5_000 }), context(), { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
  });
});

function request(input: unknown, ownerUnrestrictedExecution = false): MonarchExecutionRequest {
  return {
    id: `exec_shell_${Math.random().toString(36).slice(2)}`,
    intentId: 'intent_shell_test',
    moduleId: 'system-shell',
    capabilityId: 'system.shell.run',
    input,
    createdAt: new Date(0).toISOString(),
    requestedBy: 'agent:task_shell_test',
    source: 'desktop',
    executionMode: 'agent-runtime',
    ...(ownerUnrestrictedExecution ? { ownerUnrestrictedExecution: true } : {}),
  };
}

function context(): MonarchKernelContext {
  return { emit: async () => ({}) as never } as MonarchKernelContext;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-system-shell-'));
  roots.push(root);
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  return root;
}
