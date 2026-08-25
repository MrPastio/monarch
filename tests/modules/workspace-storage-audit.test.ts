import { access, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceModule } from '../../src/modules/workspace';
import { runWorkspaceStorageAudit } from '../../src/modules/workspace/storage-audit';

describe('workspace.storage.audit', () => {
  it('returns deterministic bounded logical observations without mutating the tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-'));
    const large = path.join(root, 'Большой проект');
    const small = path.join(root, 'small');
    const empty = path.join(root, 'empty');
    await mkdir(path.join(large, 'src'), { recursive: true });
    await mkdir(small, { recursive: true });
    await mkdir(empty, { recursive: true });
    await writeFile(path.join(large, 'package.json'), '{}', 'utf8');
    await writeFile(path.join(large, 'src', 'data.bin'), Buffer.alloc(4_096, 7));
    await writeFile(path.join(small, 'note.txt'), 'small', 'utf8');
    const before = await snapshotTree(root);
    const workspace = new WorkspaceModule({ workspaceRoot: root });
    try {
      const result = await workspace.executeCapability(
        request({ root, topN: 10, maxDepth: 32, maxEntries: 10_000, maxWallTimeMs: 30_000 }),
        fullLocalContext(),
      );
      const audit = (result.output as { audit: Record<string, unknown> }).audit;
      expect(result).toMatchObject({ ok: true, output: { observationVerified: true, complete: true } });
      expect(audit).toMatchObject({
        root: path.resolve(root),
        logicalBytes: 4_103,
        files: 3,
        directories: 5,
        emptyDirectories: 1,
        partial: false,
        mutationsObserved: 0,
      });
      expect(audit.topDirectories).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: large, logicalBytes: 4_098, files: 2 }),
      ]));
      expect(audit.projectMarkerCandidates).toContainEqual({ path: path.join(large, 'package.json'), marker: 'package.json' });
      expect(await snapshotTree(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not follow a directory symlink or junction outside the exact root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'must not be observed', 'utf8');
    let linked = true;
    try {
      await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked = false;
    }
    const workspace = new WorkspaceModule({ workspaceRoot: root });
    try {
      const result = await workspace.executeCapability(
        request({ root, topN: 10, maxDepth: 32, maxEntries: 10_000, maxWallTimeMs: 30_000 }),
        fullLocalContext(),
      );
      const audit = (result.output as { audit: { files: number; skipReasons: Record<string, number> } }).audit;
      expect(audit.files).toBe(0);
      if (linked) expect(audit.skipReasons['reparse-point']).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports depth, entry and cancellation exhaustion as partial observations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-partial-'));
    await mkdir(path.join(root, 'one', 'two'), { recursive: true });
    await writeFile(path.join(root, 'one', 'two', 'three.txt'), 'three', 'utf8');
    const workspace = new WorkspaceModule({ workspaceRoot: root });
    try {
      const depthResult = await workspace.executeCapability(
        request({ root, topN: 10, maxDepth: 0, maxEntries: 10_000, maxWallTimeMs: 30_000 }),
        fullLocalContext(),
      );
      expect(depthResult).toMatchObject({ ok: true, metadata: { partial: true } });
      expect(depthResult.output).toMatchObject({ observationVerified: true, complete: false });
      expect((depthResult.output as { audit: { skipReasons: Record<string, number> } }).audit.skipReasons['max-depth']).toBe(1);

      const entryResult = await workspace.executeCapability(
        request({ root, topN: 10, maxDepth: 32, maxEntries: 1, maxWallTimeMs: 30_000 }),
        fullLocalContext(),
      );
      expect(entryResult).toMatchObject({ ok: true, metadata: { partial: true } });
      expect((entryResult.output as { audit: { budget: { exhausted: boolean } } }).audit.budget.exhausted).toBe(true);

      const controller = new AbortController();
      controller.abort();
      const cancelled = await workspace.executeCapability(
        request({ root, topN: 10, maxDepth: 32, maxEntries: 10_000, maxWallTimeMs: 30_000 }),
        fullLocalContext(),
        { signal: controller.signal },
      );
      expect(cancelled).toMatchObject({
        ok: true,
        metadata: { partial: true },
        output: { audit: { cancellationRequested: true, mutationsObserved: 0 } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks an outside audit root in Workspace mode instead of asking for text confirmation', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-policy-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-policy-outside-'));
    const workspace = new WorkspaceModule({ workspaceRoot });
    try {
      const result = await workspace.executeCapability(
        request({ root: outside }),
        workspaceContext(),
      );
      expect(result).toMatchObject({ ok: false, error: 'filesystem-policy-blocked' });
      await expect(access(outside)).resolves.toBeUndefined();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('never enters a synthetic Safe/red-zone subtree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-red-zone-'));
    const visible = path.join(root, 'visible');
    const syntheticSafe = path.join(root, 'SyntheticMonarchSafe');
    await mkdir(visible, { recursive: true });
    await mkdir(syntheticSafe, { recursive: true });
    await writeFile(path.join(visible, 'visible.txt'), 'visible', 'utf8');
    await writeFile(path.join(syntheticSafe, 'must-not-read.secret'), Buffer.alloc(16_384, 9));
    try {
      const audit = await runWorkspaceStorageAudit({
        root,
        topN: 10,
        maxDepth: 32,
        maxEntries: 10_000,
        maxWallTimeMs: 30_000,
        blockedRoots: [syntheticSafe],
      });
      expect(audit).toMatchObject({ files: 1, logicalBytes: 7, partial: true, mutationsObserved: 0 });
      expect(audit.skipReasons['policy-blocked']).toBe(1);
      expect(JSON.stringify(audit)).not.toContain('must-not-read.secret');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a huge queued tree inside the exact entry budget with long Unicode paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-storage-audit-huge-'));
    let longPath = root;
    for (let index = 0; index < 10; index += 1) longPath = path.join(longPath, `длинный-${index}`);
    await mkdir(longPath, { recursive: true });
    await writeFile(path.join(longPath, 'данные.txt'), 'данные', 'utf8');
    for (let index = 0; index < 120; index += 1) {
      const directory = path.join(root, `candidate-${String(index).padStart(3, '0')}`);
      await mkdir(directory);
      await writeFile(path.join(directory, 'payload.bin'), Buffer.alloc(32, index));
    }
    const before = await snapshotTree(root);
    try {
      const audit = await runWorkspaceStorageAudit({
        root,
        topN: 10,
        maxDepth: 64,
        maxEntries: 25,
        maxWallTimeMs: 30_000,
        blockedRoots: [],
        concurrency: 16,
      });
      expect(audit.partial).toBe(true);
      expect(audit.budget.exhausted).toBe(true);
      expect(audit.skipReasons['max-entries']).toBeGreaterThan(0);
      expect(audit.entriesObserved).toBeLessThanOrEqual(25);
      expect(await snapshotTree(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function request(input: Record<string, unknown>) {
  return {
    id: `exec_audit_${Math.random().toString(36).slice(2)}`,
    intentId: 'intent_storage_audit',
    moduleId: 'workspace',
    capabilityId: 'workspace.storage.audit',
    input,
    createdAt: new Date().toISOString(),
    requestedBy: 'desktop',
    source: 'desktop' as const,
    confirmed: false,
  };
}

function fullLocalContext() {
  return {
    emit: async () => ({}) as never,
    getPermissionProfile: () => ({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      autonomyMode: 'full-local',
    }),
  } as never;
}

function workspaceContext() {
  return {
    emit: async () => ({}) as never,
    getPermissionProfile: () => ({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      autonomyMode: 'workspace-autonomous',
    }),
  } as never;
}

async function snapshotTree(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      const info = await stat(target);
      output.push(`${path.relative(root, target)}:${entry.isDirectory() ? 'd' : 'f'}:${info.size}:${info.mtimeMs}`);
      if (entry.isDirectory()) await visit(target);
    }
  };
  await visit(root);
  return output;
}
