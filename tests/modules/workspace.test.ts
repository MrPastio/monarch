import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createMonarchRuntime } from '../../src/bootstrap';
import { evaluateFilesystemAccess, MonarchKernel } from '../../src/core';
import {
  WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP,
  WorkspaceModule,
} from '../../src/modules/workspace';

const execFileAsync = promisify(execFile);

describe('Workspace Module', () => {
  it('holds every Recycle Bin ancestor without delete sharing and rejects reparse handles', () => {
    expect(WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP).toContain(
      'FileFlagBackupSemantics | FileFlagOpenReparsePoint',
    );
    expect(WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP).toContain(
      'FileShareRead | FileShareWrite',
    );
    expect(WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP).not.toContain('FileShareDelete');
    expect(WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP).toContain(
      'FileAttributeReparsePoint',
    );
  });

  it.runIf(process.platform === 'win32')('compiles the Recycle Bin ancestor fence contract', async () => {
    const source = Buffer.from(WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP, 'utf8').toString('base64');
    const command = [
      "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MONARCH_FENCE_SOURCE_B64))",
      'Add-Type -TypeDefinition $source -Language CSharp',
      '$fence = [MonarchRecycleAncestorFence]::Acquire($env:MONARCH_FENCE_TARGET)',
      "try { 'ancestor-fence-ready' } finally { $fence.Dispose() }",
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], {
      windowsHide: true,
      timeout: 15_000,
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        Path: process.env.Path,
        PSModulePath: process.env.PSModulePath,
        MONARCH_FENCE_SOURCE_B64: source,
        MONARCH_FENCE_TARGET: path.join(process.cwd(), '__nonexistent_recycle_probe__.tmp'),
      },
    });
    expect(stdout.trim()).toBe('ancestor-fence-ready');
  }, 20_000);

  it('applies Codex-like read-only protected paths and Full Access scope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-profile-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-outside-'));
    const protectedFile = path.join(root, '.agents', 'skills', 'demo', 'SKILL.md');
    const outsideFile = path.join(outsideRoot, 'outside.txt');
    await mkdir(path.dirname(protectedFile), { recursive: true });
    await writeFile(protectedFile, 'skill instructions', 'utf8');
    await writeFile(outsideFile, 'outside data', 'utf8');

    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const readable = await executeWorkspace(kernel, 'workspace.files.read', { path: protectedFile });
      const protectedWrite = await executeWorkspace(kernel, 'workspace.files.write', {
        path: protectedFile,
        content: 'changed',
        overwrite: true,
      }, true);
      const outsideBlocked = await executeWorkspace(kernel, 'workspace.files.read', { path: outsideFile });

      expect(readable.ok).toBe(true);
      expect(protectedWrite.error).toBe('filesystem-policy-blocked');
      expect(outsideBlocked.error).toBe('filesystem-policy-blocked');

      kernel.setPermissionProfile({ sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' });
      const outsideAllowed = await executeWorkspace(kernel, 'workspace.files.read', { path: outsideFile });
      expect(outsideAllowed.ok).toBe(true);
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('blocks the production Safe parent before filesystem access even in Full Access', async () => {
    const workspaceRoot = process.cwd();
    const safeParent = path.join(path.parse(workspaceRoot).root, 'MonarchData', 'Safe');
    const syntheticReadPath = path.join(safeParent, 'safe-v1', 'never-read.test');
    const policyEvaluation = evaluateFilesystemAccess(syntheticReadPath, 'read', {
      workspaceRoot,
      sandboxRoot: workspaceRoot,
      fallbackRoot: workspaceRoot,
      allowFullDiskAccess: true,
      protectWorkspaceInternals: false,
    });

    // This assertion runs before the Kernel attempt so a policy regression
    // cannot fall through to any filesystem API under the production Safe path.
    expect(policyEvaluation).toMatchObject({
      allowed: false,
      reason: 'red-zone-read-blocked',
      resolvedPath: syntheticReadPath,
    });
    expect(policyEvaluation.redZoneRoots).toContain(safeParent);

    const kernel = new MonarchKernel({
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        autonomyMode: 'full-local',
      },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot }));
    await kernel.start();
    try {
      const blocked = await executeWorkspace(kernel, 'workspace.files.read', { path: syntheticReadPath });
      expect(blocked).toMatchObject({
        ok: false,
        error: 'filesystem-policy-blocked',
        metadata: {
          evaluation: {
            reason: 'red-zone-read-blocked',
            resolvedPath: syntheticReadPath,
          },
        },
      });
    } finally {
      await kernel.stop();
    }
  });

  it('applies a task-bound Owner override at dispatch while retaining the immutable Safe policy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-owner-'));
    const protectedFile = path.join(root, '.env');
    const kernel = new MonarchKernel({
      workspaceRoot: root,
      agencyStateDirectory: false,
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'on-request',
        autonomyMode: 'full-local',
      },
      authorityContext: {
        tier: 'owner',
        source: 'signed-device-entitlement',
        entitlementId: 'owner_workspace_test',
        keyId: 'owner-root-test',
        verifiedAt: new Date(0).toISOString(),
        deviceIdPrefix: '0123456789ab',
        diagnostic: null,
      },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      await kernel.emitRuntimeEvent('security.model_policy.changed', 'security', {
        modelCommandsEnabled: true,
        agentSecurityMode: 'observe',
      });
      const base = {
        intentId: 'intent_workspace_owner',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.write',
        input: { path: protectedFile, content: 'owner override fixture' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'agent:task_workspace_owner',
        source: 'desktop' as const,
        executionMode: 'agent-runtime' as const,
        originatingUserText: 'Запиши тестовый файл .env',
      };
      const blocked = await kernel.execute({ ...base, id: 'exec_owner_before' });
      expect(blocked).toMatchObject({
        ok: false,
        error: 'permission-denied',
        metadata: { policy: { evidence: expect.arrayContaining([
          expect.objectContaining({ code: 'filesystem.red-zone-write-blocked', hard: true }),
        ]) } },
      });

      await kernel.emitRuntimeEvent('security.owner_override.changed', 'security', {
        ownerOverride: {
          enabled: true,
          lifetime: 'task',
          taskId: 'task_workspace_owner',
          shellApprovalPolicy: 'risk-based',
        },
      });
      const allowed = await kernel.execute({ ...base, id: 'exec_owner_after' });
      expect(allowed).toMatchObject({
        ok: true,
        metadata: { policy: { ownerUnrestrictedOverride: true } },
      });
      expect(await readFile(protectedFile, 'utf8')).toBe('owner override fixture');

      const syntheticSafePath = path.join(path.parse(root).root, 'MonarchData', 'Safe', 'safe-v1', 'never-read.test');
      expect(evaluateFilesystemAccess(syntheticSafePath, 'read', {
        workspaceRoot: root,
        sandboxRoot: root,
        allowFullDiskAccess: true,
        includeDefaultRedZones: false,
        protectWorkspaceInternals: false,
      })).toMatchObject({ allowed: false, reason: 'red-zone-read-blocked' });
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the authoritative AgentTask store outside ordinary workspace file access', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-agent-store-'));
    const storePath = path.join(root, 'runtime', 'agent', 'tasks.v2.json');
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, '{"synthetic":"agent-store-marker"}', 'utf8');

    const kernel = new MonarchKernel({
      workspaceRoot: root,
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        autonomyMode: 'full-local',
      },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const blocked = await executeWorkspace(kernel, 'workspace.files.read', { path: storePath });
      expect(blocked).toMatchObject({
        ok: false,
        error: 'filesystem-policy-blocked',
        metadata: { evaluation: { reason: 'red-zone-read-blocked' } },
      });
      expect(JSON.stringify(blocked)).not.toContain('agent-store-marker');
    } finally {
      await kernel.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows bounded local user read roots and desktop mkdir without file writes there', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-local-root-'));
    const userHome = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-user-home-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-random-outside-'));
    const desktop = path.join(userHome, 'Desktop');
    const desktopFile = path.join(desktop, 'visible.txt');
    const outsideFile = path.join(outsideRoot, 'outside.txt');
    const oldUserProfile = process.env.USERPROFILE;
    const oldHome = process.env.HOME;
    const oldDesktopDir = process.env.MONARCH_DESKTOP_DIR;

    process.env.USERPROFILE = userHome;
    process.env.HOME = userHome;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    await mkdir(desktop, { recursive: true });
    await writeFile(desktopFile, 'desktop data', 'utf8');
    await writeFile(outsideFile, 'outside data', 'utf8');

    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const listed = await executeWorkspace(kernel, 'workspace.files.list', { path: desktop });
      const read = await executeWorkspace(kernel, 'workspace.files.read', { path: desktopFile });
      const blockedWrite = await executeWorkspace(kernel, 'workspace.files.write', {
        path: path.join(desktop, 'new.txt'),
        content: 'nope',
      }, true);
      const randomOutside = await executeWorkspace(kernel, 'workspace.files.read', { path: outsideFile });
      const routedDesktopList = await kernel.submitIntent('Перечисли файлы на рабочем столе', 'smoke');
      const routedDesktopMkdir = await kernel.submitIntent('создай новую папку на рабочем столе', 'smoke', { confirmed: true });
      const routedNamedDesktopMkdir = await kernel.submitIntent('создай папку demo на рабочем столе', 'smoke', { confirmed: true });
      const routedWorkingDesktopMkdir = await kernel.submitIntent('создай рабочую папку на столе', 'smoke', { confirmed: true });
      const routedGeneratedWorkspaceMkdir = await kernel.submitIntent('создай новую папку название придумай сам', 'smoke', { confirmed: true });
      const routedAssignedWorkspaceMkdir = await kernel.submitIntent(
        'Создай новую папку в твоем рабочем пространстве назови ее цветок.',
        'smoke',
        { confirmed: true },
      );

      expect(listed.ok).toBe(true);
      expect(read.ok).toBe(true);
      expect((read.output as { content?: unknown } | undefined)?.content).toBe('desktop data');
      expect(blockedWrite.error).toBe('filesystem-policy-blocked');
      expect(randomOutside.error).toBe('filesystem-policy-blocked');
      expect(routedDesktopList.route?.capabilityId).toBe('workspace.files.list');
      expect(routedDesktopList.route?.input).toMatchObject({ path: desktop });
      expect(routedDesktopList.execution?.ok).toBe(true);
      expect((routedDesktopList.execution?.output as { entries?: Array<{ name: string }> } | undefined)?.entries)
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'visible.txt' })]));
      expect(routedDesktopMkdir.route?.capabilityId).toBe('workspace.files.mkdir');
      expect(routedDesktopMkdir.route?.input).toMatchObject({
        path: path.join(desktop, 'Новая папка'),
        ensureUnique: true,
      });
      expect(routedDesktopMkdir.execution?.ok).toBe(true);
      expect((await stat(path.join(desktop, 'Новая папка'))).isDirectory()).toBe(true);
      expect(routedNamedDesktopMkdir.route?.input).toMatchObject({ path: path.join(desktop, 'demo') });
      expect(routedNamedDesktopMkdir.execution?.ok).toBe(true);
      expect((await stat(path.join(desktop, 'demo'))).isDirectory()).toBe(true);
      expect(routedWorkingDesktopMkdir.route?.input).toMatchObject({ path: path.join(desktop, 'Рабочая папка') });
      expect(routedWorkingDesktopMkdir.execution?.ok).toBe(true);
      expect((await stat(path.join(desktop, 'Рабочая папка'))).isDirectory()).toBe(true);
      expect(routedGeneratedWorkspaceMkdir.route?.capabilityId).toBe('workspace.files.mkdir');
      expect((routedGeneratedWorkspaceMkdir.route?.input as any)?.path).toBe('Новая папка');
      expect((routedGeneratedWorkspaceMkdir.route?.input as any)?.ensureUnique).toBe(true);
      expect(routedGeneratedWorkspaceMkdir.execution?.ok).toBe(true);
      expect((await stat(path.join(root, 'Новая папка'))).isDirectory()).toBe(true);
      expect(routedAssignedWorkspaceMkdir.route?.capabilityId).toBe('workspace.files.mkdir');
      expect(routedAssignedWorkspaceMkdir.route?.input).toMatchObject({ path: 'цветок' });
      expect(routedAssignedWorkspaceMkdir.execution?.ok).toBe(true);
      expect((await stat(path.join(root, 'цветок'))).isDirectory()).toBe(true);
    } finally {
      await kernel.stop();
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldDesktopDir === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = oldDesktopDir;
      await rm(root, { recursive: true, force: true });
      await rm(userHome, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('resolves a synthetic Desktop and inspects every file through freshness-bound pages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-inspect-batch-workspace-'));
    const userRoot = await mkdtemp(path.join(tmpdir(), 'monarch-inspect-batch-user-'));
    const desktop = path.join(userRoot, 'Desktop');
    const previousDesktop = process.env.MONARCH_DESKTOP_DIR;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    await mkdir(path.join(desktop, 'nested'), { recursive: true });
    await writeFile(path.join(desktop, 'a.txt'), 'Alpha desktop note', 'utf8');
    await writeFile(path.join(desktop, 'b.md'), '# Beta desktop note', 'utf8');
    await writeFile(path.join(desktop, 'image.png'), Buffer.from([0, 1, 2, 3, 4]));
    await writeFile(path.join(desktop, 'nested', 'c.json'), '{"name":"Gamma"}', 'utf8');

    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never', autonomyMode: 'workspace-autonomous' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const resolved = await executeWorkspace(kernel, 'workspace.known-folder.resolve', { knownFolder: 'desktop' });
      expect(resolved).toMatchObject({
        ok: true,
        output: { knownFolder: 'desktop', path: desktop, exists: true, directory: true },
      });

      const first = await executeWorkspace(kernel, 'workspace.files.inspect-batch', {
        knownFolder: 'desktop',
        recursive: true,
        pageSize: 2,
      });
      const firstOutput = first.output as {
        snapshotId: string;
        items: Array<{ relativePath: string; status: string; content?: string; sha256?: string }>;
        nextCursor: string | null;
        complete: boolean;
        coverage: { totalFiles: number; remainingFiles: number };
      };
      expect(first.ok).toBe(true);
      expect(firstOutput).toMatchObject({
        complete: false,
        coverage: { totalFiles: 4, remainingFiles: 2 },
      });
      expect(firstOutput.items).toEqual([
        expect.objectContaining({ relativePath: 'a.txt', status: 'read', content: 'Alpha desktop note' }),
        expect.objectContaining({ relativePath: 'b.md', status: 'read', content: '# Beta desktop note' }),
      ]);
      expect(firstOutput.items.every((entry) => entry.sha256?.match(/^[a-f0-9]{64}$/u))).toBe(true);

      const tampered = await executeWorkspace(kernel, 'workspace.files.inspect-batch', {
        knownFolder: 'desktop',
        recursive: true,
        pageSize: 2,
        cursor: `${firstOutput.nextCursor}x`,
      });
      expect(tampered).toMatchObject({ ok: false, error: 'stale-inspect-batch-cursor' });

      const second = await executeWorkspace(kernel, 'workspace.files.inspect-batch', {
        knownFolder: 'desktop',
        recursive: true,
        pageSize: 2,
        cursor: firstOutput.nextCursor,
      });
      const secondOutput = second.output as {
        snapshotId: string;
        items: Array<{ relativePath: string; status: string; content?: string; reason?: string; sha256?: string }>;
        skips: Array<{ path: string; reason: string }>;
        nextCursor: string | null;
        complete: boolean;
        coverage: { totalFiles: number; remainingFiles: number; paginationComplete: boolean };
      };
      expect(second.ok).toBe(true);
      expect(secondOutput.snapshotId).toBe(firstOutput.snapshotId);
      expect(secondOutput).toMatchObject({
        complete: true,
        nextCursor: null,
        coverage: { totalFiles: 4, remainingFiles: 0, paginationComplete: true },
      });
      expect(secondOutput.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ relativePath: 'image.png', status: 'metadata-only', reason: 'binary-or-unsupported-format' }),
        expect.objectContaining({ relativePath: path.join('nested', 'c.json'), status: 'read', content: '{"name":"Gamma"}' }),
      ]));
      expect(secondOutput.skips).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: path.join(desktop, 'image.png'), reason: 'binary-or-unsupported-format' }),
      ]));
      expect(secondOutput.items.every((entry) => entry.sha256?.match(/^[a-f0-9]{64}$/u))).toBe(true);
    } finally {
      await kernel.stop();
      if (previousDesktop === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = previousDesktop;
      await rm(root, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it('routes a named Desktop text file through the typed known-folder writer and keeps generic writes blocked', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const workspaceRoot = await mkdtemp(path.join(qaBase, 'known-folder-workspace-'));
    const userRoot = await mkdtemp(path.join(qaBase, 'known-folder-user-'));
    const desktop = path.join(userRoot, 'Desktop');
    const downloads = path.join(userRoot, 'Downloads');
    const desktopTarget = path.join(desktop, 'ромашка.txt');
    const downloadsTarget = path.join(downloads, 'receipt.txt');
    const journalTarget = path.join(desktop, 'journal.txt');
    const oldDesktopDir = process.env.MONARCH_DESKTOP_DIR;
    const oldDownloadsDir = process.env.MONARCH_DOWNLOADS_DIR;
    const mutations: string[][] = [];
    process.env.MONARCH_DESKTOP_DIR = desktop;
    process.env.MONARCH_DOWNLOADS_DIR = downloads;
    await mkdir(desktop, { recursive: true });
    await mkdir(downloads, { recursive: true });

    const kernel = new MonarchKernel({
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
    });
    kernel.registerModule(new WorkspaceModule({
      workspaceRoot,
      beforeMutation: (_operation, targets) => {
        mutations.push([...targets]);
      },
    }));
    await kernel.start();
    try {
      const routed = await kernel.submitIntent(
        'создай на рабочем столе текстовый файл с именем ромашка',
        'smoke',
        { confirmed: true },
      );
      const genericOutsideWrite = await executeWorkspace(kernel, 'workspace.files.write', {
        path: path.join(desktop, 'generic.txt'),
        content: 'must stay blocked',
      }, true);
      const downloadsWrite = await executeWorkspace(kernel, 'workspace.known-folder.write', {
        knownFolder: 'downloads',
        basename: 'receipt.txt',
        content: 'verified downloads payload',
      }, true);
      const journaled = await kernel.executeActionProposal({
        version: 1,
        capabilityId: 'workspace.known-folder.write',
        args: {
          knownFolder: 'desktop',
          basename: 'journal.txt',
          content: 'rollback payload',
          overwrite: false,
        },
        reason: 'Create one exact file in the Kernel-resolved synthetic Desktop.',
        provenance: { source: 'runtime-grammar', model: 'unit-model', skillIds: [] },
      }, {
        intentId: 'intent_known_folder_journal',
        originatingUserText: 'создай на рабочем столе файл journal.txt',
        requestedBy: 'smoke',
        source: 'smoke',
        confirmed: true,
      });

      expect(routed.route, JSON.stringify(routed)).toMatchObject({
        capabilityId: 'workspace.known-folder.write',
        input: {
          knownFolder: 'desktop',
          basename: 'ромашка.txt',
          content: '',
          overwrite: false,
        },
      });
      expect(routed.execution).toMatchObject({
        ok: true,
        output: {
          knownFolder: 'desktop',
          basename: 'ромашка.txt',
          path: desktopTarget,
          bytes: 0,
          verified: true,
          readbackSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      });
      await expect(readFile(desktopTarget, 'utf8')).resolves.toBe('');
      expect(genericOutsideWrite).toMatchObject({ ok: false, error: 'filesystem-policy-blocked' });
      await expect(stat(path.join(desktop, 'generic.txt')).catch(() => undefined)).resolves.toBeUndefined();
      expect(downloadsWrite).toMatchObject({
        ok: true,
        output: {
          knownFolder: 'downloads',
          basename: 'receipt.txt',
          path: downloadsTarget,
          verified: true,
        },
      });
      await expect(readFile(downloadsTarget, 'utf8')).resolves.toBe('verified downloads payload');
      expect(journaled.result).toMatchObject({
        ok: true,
        metadata: { ledger: { rollback: { status: 'available', targetPath: journalTarget } } },
      });
      const ledgerId = String((journaled.result.metadata?.ledger as { ledgerId?: unknown } | undefined)?.ledgerId || '');
      expect(ledgerId).not.toBe('');
      await expect(kernel.rollbackAction(ledgerId)).resolves.toMatchObject({
        status: 'rolled-back',
        targetPath: journalTarget,
      });
      await expect(readFile(journalTarget, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mutations).toEqual([[desktopTarget], [downloadsTarget], [journalTarget]]);
    } finally {
      await kernel.stop().catch(() => undefined);
      if (oldDesktopDir === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = oldDesktopDir;
      if (oldDownloadsDir === undefined) delete process.env.MONARCH_DOWNLOADS_DIR;
      else process.env.MONARCH_DOWNLOADS_DIR = oldDownloadsDir;
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  it('rejects traversal, separators, device names, and unknown folders before a known-folder write', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const workspaceRoot = await mkdtemp(path.join(qaBase, 'known-folder-invalid-workspace-'));
    const desktop = await mkdtemp(path.join(qaBase, 'known-folder-invalid-desktop-'));
    const oldDesktopDir = process.env.MONARCH_DESKTOP_DIR;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot }));
    await kernel.start();
    try {
      for (const basename of ['..', '../escape.txt', 'nested\\escape.txt', 'NUL.txt', 'bad:name.txt', 'trailing.']) {
        const blocked = await executeWorkspace(kernel, 'workspace.known-folder.write', {
          knownFolder: 'desktop',
          basename,
          content: 'blocked',
        }, true);
        expect(blocked).toMatchObject({ ok: false, error: 'invalid-known-folder-basename' });
      }
      const unknownFolder = await executeWorkspace(kernel, 'workspace.known-folder.write', {
        knownFolder: 'documents',
        basename: 'note.txt',
        content: 'blocked',
      }, true);
      expect(unknownFolder).toMatchObject({ ok: false, error: 'invalid-known-folder' });
      await expect(stat(path.join(qaBase, 'escape.txt')).catch(() => undefined)).resolves.toBeUndefined();
      await expect(stat(path.join(desktop, 'note.txt')).catch(() => undefined)).resolves.toBeUndefined();
    } finally {
      await kernel.stop().catch(() => undefined);
      if (oldDesktopDir === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = oldDesktopDir;
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(desktop, { recursive: true, force: true });
    }
  });

  it('should guard file operations and route correctly', async () => {
    const runtime = createMonarchRuntime({
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
    });
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `smoke-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );

    await runtime.kernel.start();
    try {
      const routeResult = await runtime.kernel.submitIntent('list files in runtime', 'smoke');
      expect(routeResult.route?.targetModuleId).toBe('workspace');
      expect(routeResult.route?.capabilityId).toBe('workspace.files.list');
      if (!routeResult.execution?.ok) throw new Error(routeResult.summary);
      expect(routeResult.execution?.ok).toBe(true);

      const blockedRootDelete = await runtime.kernel.execute({
        id: 'exec_smoke_workspace_root_delete',
        intentId: 'intent_smoke_workspace_root_delete',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.delete',
        input: { path: process.cwd() },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      });
      expect(blockedRootDelete.error).toBe('filesystem-policy-blocked');

      const written = await runtime.kernel.execute({
        id: 'exec_smoke_workspace_write',
        intentId: 'intent_smoke_workspace_write',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.write',
        input: {
          path: filePath,
          content: 'router smoke needle',
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      });
      expect(written.ok).toBe(true);

      const read = await runtime.kernel.execute({
        id: 'exec_smoke_workspace_read',
        intentId: 'intent_smoke_workspace_read',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.read',
        input: { path: filePath },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
      });
      const readOutput = read.output as { content?: unknown } | undefined;
      expect(read.ok).toBe(true);
      expect(readOutput?.content).toBe('router smoke needle');

      const search = await runtime.kernel.execute({
        id: 'exec_smoke_workspace_search',
        intentId: 'intent_smoke_workspace_search',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.search',
        input: {
          path: 'runtime',
          query: 'router smoke needle',
          limit: 5,
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
      });
      const matches = (search.output as { matches?: unknown[] } | undefined)?.matches || [];
      expect(search.ok).toBe(true);
      expect(matches.length).toBeGreaterThan(0);

      const replaced = await runtime.kernel.execute({
        id: 'exec_smoke_workspace_replace',
        intentId: 'intent_smoke_workspace_replace',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.replace',
        input: {
          path: filePath,
          oldText: 'router smoke needle',
          newText: 'router smoke edited',
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      });
      expect(replaced.ok).toBe(true);

      const reread = await runtime.kernel.execute({
        id: 'exec_smoke_workspace_reread',
        intentId: 'intent_smoke_workspace_reread',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.read',
        input: { path: filePath },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
      });
      const rereadOutput = reread.output as { content?: unknown } | undefined;
      expect(rereadOutput?.content).toBe('router smoke edited');

      const deleted = await runtime.kernel.execute({
        id: 'exec_smoke_workspace_delete',
        intentId: 'intent_smoke_workspace_delete',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.delete',
        input: { path: filePath },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      });
      expect(deleted.ok).toBe(true);
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(filePath, { force: true });
    }
  }, 15_000);

  it('should route Russian patterns correctly', async () => {
    const runtime = createMonarchRuntime({
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
    });

    await runtime.kernel.start();
    try {
      // 1. Test "покажи файлы"
      const listResult = await runtime.kernel.submitIntent('покажи файлы', 'smoke');
      expect(listResult.route?.targetModuleId).toBe('workspace');
      expect(listResult.route?.capabilityId).toBe('workspace.files.list');
      if (!listResult.execution?.ok) throw new Error(listResult.summary);
      expect(listResult.execution?.ok).toBe(true);

      const contentsResult = await runtime.kernel.submitIntent(
        `Содержание папки по этому пути "${path.join(process.cwd(), 'src', 'modules', 'workspace')}"`,
        'smoke'
      );
      expect(contentsResult.route?.targetModuleId).toBe('workspace');
      expect(contentsResult.route?.capabilityId).toBe('workspace.files.list');
      expect((contentsResult.route?.input as any)?.path).toContain(path.join('src', 'modules', 'workspace'));

      const historyListResult = await runtime.kernel.submitIntent(
        'Просмотри какие названия папок в твоей корневой папке',
        'smoke'
      );
      expect(historyListResult.route?.capabilityId).toBe('workspace.files.list');
      expect(historyListResult.execution?.ok).toBe(true);
      expect(historyListResult.route?.input).toMatchObject({
        path: '.',
        entryType: 'directory',
      });

      const workspaceRootResult = await runtime.kernel.submitIntent(
        'Где находится твое рабочее пространство?',
        'smoke'
      );
      expect(workspaceRootResult.route?.capabilityId).toBe('workspace.root.get');
      expect(workspaceRootResult.execution?.ok).toBe(true);
      expect(workspaceRootResult.plan).toBeNull();
      expect(workspaceRootResult.execution?.output).toMatchObject({
        workspaceRoot: process.cwd(),
      });

      const explicitCapabilityResult = await runtime.kernel.submitIntent(
        JSON.stringify({
          capability: 'workspace.files.list',
          parameters: { path: path.join(process.cwd(), 'src', 'modules', 'workspace') },
        }),
        'smoke'
      );
      expect(explicitCapabilityResult.route?.capabilityId).toBe('workspace.files.list');
      expect(explicitCapabilityResult.execution?.ok).toBe(true);

      const explicitSnakeCaseCopy = await runtime.kernel.submitIntent(
        JSON.stringify({
          capability: 'workspace.files.copy',
          parameters: { path: 'runtime/a.txt', target_path: 'runtime/b.txt' },
        }),
        'smoke'
      );
      expect(explicitSnakeCaseCopy.route?.capabilityId).toBe('workspace.files.copy');
      expect((explicitSnakeCaseCopy.route?.input as any)?.targetPath).toBe('runtime/b.txt');

      const explicitSnakeCaseReplace = await runtime.kernel.submitIntent(
        JSON.stringify({
          capability: 'workspace.files.replace',
          parameters: { path: 'runtime/ui-note.txt', old_text: 'готово', new_text: 'готово!' },
        }),
        'smoke'
      );
      expect(explicitSnakeCaseReplace.route?.capabilityId).toBe('workspace.files.replace');
      expect((explicitSnakeCaseReplace.route?.input as any)?.oldText).toBe('готово');
      expect((explicitSnakeCaseReplace.route?.input as any)?.newText).toBe('готово!');

      const standalonePathResult = await runtime.kernel.submitIntent(
        `"${path.join(process.cwd(), 'src', 'modules', 'workspace')}"`,
        'smoke'
      );
      expect(standalonePathResult.route?.capabilityId).toBe('workspace.files.list');
      expect(standalonePathResult.execution?.ok).toBe(true);

      // 2. Test "прочитай файл package.json"
      const readResult = await runtime.kernel.submitIntent('прочитай файл package.json', 'smoke');
      expect(readResult.route?.targetModuleId).toBe('workspace');
      expect(readResult.route?.capabilityId).toBe('workspace.files.read');
      expect((readResult.route?.input as any)?.path).toBe('package.json');

      const directReadResult = await runtime.kernel.submitIntent('прочитай package.json', 'smoke');
      expect(directReadResult.route?.targetModuleId).toBe('workspace');
      expect(directReadResult.route?.capabilityId).toBe('workspace.files.read');
      expect((directReadResult.route?.input as any)?.path).toBe('package.json');

      const prefixedReadResult = await runtime.kernel.submitIntent('можешь прочитать package.json', 'smoke');
      expect(prefixedReadResult.route?.targetModuleId).toBe('workspace');
      expect(prefixedReadResult.route?.capabilityId).toBe('workspace.files.read');
      expect((prefixedReadResult.route?.input as any)?.path).toBe('package.json');

      // 3. Test "найди в файлах router"
      const searchRoute = await routeWorkspaceText(runtime.kernel, 'найди в файлах router');
      expect(searchRoute?.targetModuleId).toBe('workspace');
      expect(searchRoute?.capabilityId).toBe('workspace.files.search');
      expect((searchRoute?.input as any)?.query).toBe('router');

      const projectSearchRoute = await routeWorkspaceText(runtime.kernel, 'найди AssistantModule в проекте');
      expect(projectSearchRoute?.targetModuleId).toBe('workspace');
      expect(projectSearchRoute?.capabilityId).toBe('workspace.files.search');
      expect((projectSearchRoute?.input as any)?.query).toBe('AssistantModule');
      expect((projectSearchRoute?.input as any)?.path).toBe('.');

      const writeResult = await runtime.kernel.submitIntent('создай файл runtime/ui-note.txt с текстом "готово"', 'smoke');
      expect(writeResult.route?.targetModuleId).toBe('workspace');
      expect(writeResult.route?.capabilityId).toBe('workspace.files.write');
      expect((writeResult.route?.input as any)?.content).toBe('готово');

      const bareCodeWrite = await runtime.kernel.submitIntent(
        'Создай runtime/hello.py и напиши print("Hello World")',
        'smoke',
      );
      expect(bareCodeWrite.route?.capabilityId).toBe('workspace.files.write');
      expect(bareCodeWrite.route?.input).toMatchObject({
        path: 'runtime/hello.py',
        content: 'print("Hello World")',
      });

      const emptyWriteRoute = await runtime.kernel.submitIntent(
        '{"capability":"workspace.files.write","parameters":{"path":"runtime/empty-agent-file.txt","content":""}}',
        'smoke'
      );
      expect(emptyWriteRoute.route?.capabilityId).toBe('workspace.files.write');
      expect(emptyWriteRoute.execution?.error).not.toBe('clarification-required');

      const incompleteHistoryRequest = await runtime.kernel.submitIntent(
        'Хорошо ты можешь создать в своем рабочем пространсве папку,а в папке создать текстовый документ с надписью Hello World?',
        'smoke'
      );
      expect(incompleteHistoryRequest.route).toBeNull();
      expect(incompleteHistoryRequest.execution?.error).toBe('clarification-required');

      const mkdirResult = await runtime.kernel.submitIntent('создай папку runtime/telegram-demo', 'smoke');
      expect(mkdirResult.route?.capabilityId).toBe('workspace.files.mkdir');
      expect((mkdirResult.route?.input as any)?.path).toBe('runtime/telegram-demo');

      const missingMkdirResult = await runtime.kernel.submitIntent('создай папку', 'smoke');
      expect(missingMkdirResult.route).toBeNull();
      expect(missingMkdirResult.execution?.error).toBe('clarification-required');
      expect(missingMkdirResult.summary).not.toContain('TODO');
      expect(missingMkdirResult.execution?.summary).not.toContain('Top candidate');

      const appendResult = await runtime.kernel.submitIntent('допиши файл runtime/ui-note.txt с текстом "ещё"', 'smoke');
      expect(appendResult.route?.capabilityId).toBe('workspace.files.append');
      expect((appendResult.route?.input as any)?.content).toBe('ещё');

      const copyResult = await runtime.kernel.submitIntent('скопируй файл "runtime/a.txt" в "runtime/b.txt"', 'smoke');
      expect(copyResult.route?.capabilityId).toBe('workspace.files.copy');
      expect((copyResult.route?.input as any)?.targetPath).toBe('runtime/b.txt');

      const replaceResult = await runtime.kernel.submitIntent('замени в файле runtime/ui-note.txt "готово" на "готово!"', 'smoke');
      expect(replaceResult.route?.targetModuleId).toBe('workspace');
      expect(replaceResult.route?.capabilityId).toBe('workspace.files.replace');
      expect((replaceResult.route?.input as any)?.path).toBe('runtime/ui-note.txt');
      expect((replaceResult.route?.input as any)?.oldText).toBe('готово');
      expect((replaceResult.route?.input as any)?.newText).toBe('готово!');
    } finally {
      await runtime.kernel.stop();
      await rm(path.join(process.cwd(), 'runtime', 'ui-note.txt'), { force: true });
      await rm(path.join(process.cwd(), 'runtime', 'empty-agent-file.txt'), { force: true });
    }
  }, 15_000);

  it('should deny reads from workspace red-zone secrets paths', async () => {
    const runtime = createMonarchRuntime({
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
    });
    const secretPath = path.join(
      process.cwd(),
      'secrets',
      `workspace-red-zone-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );

    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(secretPath, 'do-not-read', 'utf8');
    await runtime.kernel.start();
    try {
      const result = await runtime.kernel.execute({
        id: 'exec_workspace_secret_read',
        intentId: 'intent_workspace_secret_read',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.read',
        input: { path: secretPath },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'test',
      });

      expect(result.ok).toBe(false);
      expect(['filesystem-policy-blocked', 'permission-denied']).toContain(result.error);
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(secretPath, { force: true });
    }
  });

  it('should block symlink and junction escapes outside the workspace root', async () => {
    const runtime = createMonarchRuntime({
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
    });
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-outside-'));
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const linkPath = path.join(
      process.cwd(),
      'runtime',
      `workspace-escape-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    await mkdir(path.dirname(linkPath), { recursive: true });
    await writeFile(outsideFile, 'outside secret', 'utf8');
    try {
      await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await rm(outsideRoot, { recursive: true, force: true });
      return;
    }

    await runtime.kernel.start();
    try {
      const result = await runtime.kernel.execute({
        id: 'exec_workspace_symlink_read',
        intentId: 'intent_workspace_symlink_read',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.read',
        input: { path: path.join(linkPath, 'secret.txt') },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'test',
      });

      expect(result.ok).toBe(false);
      expect(['filesystem-policy-blocked', 'permission-denied']).toContain(result.error);
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(linkPath, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it('should not expose red-zone children during recursive list, search, or copy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-redzone-'));
    const envFile = path.join(root, '.env');
    const runtimeDir = path.join(root, 'runtime');
    const secretDir = path.join(runtimeDir, 'secrets');
    const secretFile = path.join(secretDir, 'token.txt');
    const visibleFile = path.join(runtimeDir, 'visible.txt');
    const copiedRuntime = path.join(root, 'runtime-copy');

    await mkdir(secretDir, { recursive: true });
    await writeFile(envFile, 'MONARCH_REDZONE_SECRET=hidden', 'utf8');
    await writeFile(secretFile, 'MONARCH_RUNTIME_SECRET=hidden', 'utf8');
    await writeFile(visibleFile, 'visible data', 'utf8');

    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const directRead = await executeWorkspace(kernel, 'workspace.files.read', { path: envFile });
      const listed = await executeWorkspace(kernel, 'workspace.files.list', {
        path: root,
        recursive: true,
        limit: 50,
      });
      const search = await executeWorkspace(kernel, 'workspace.files.search', {
        path: root,
        query: 'MONARCH_REDZONE_SECRET',
        limit: 10,
      });
      const copied = await executeWorkspace(kernel, 'workspace.files.copy', {
        path: runtimeDir,
        targetPath: copiedRuntime,
      }, true);

      const listedNames = ((listed.output as { entries?: Array<{ name: string }> } | undefined)?.entries || [])
        .map((entry) => entry.name.replace(/\\/g, '/'));
      const matches = (search.output as { matches?: Array<{ preview: string }> } | undefined)?.matches || [];

      expect(directRead.error).toBe('filesystem-policy-blocked');
      expect(listed.ok).toBe(true);
      expect(listedNames).toContain('runtime/visible.txt');
      expect(listedNames).not.toContain('.env');
      expect(listedNames).not.toContain('runtime/secrets');
      expect(listedNames).not.toContain('runtime/secrets/token.txt');
      expect(search.ok).toBe(true);
      expect(matches).toHaveLength(0);
      expect(copied.error).toBe('filesystem-policy-blocked');
      expect(await stat(path.join(copiedRuntime, 'secrets', 'token.txt')).catch(() => undefined)).toBeUndefined();
    } finally {
      await kernel.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should reject ambiguous text replacement without changing the file', async () => {
    const runtime = createMonarchRuntime({
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
    });
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `replace-ambiguous-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    );

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'same same', 'utf8');
    await runtime.kernel.start();
    try {
      const result = await runtime.kernel.execute({
        id: 'exec_workspace_replace_ambiguous',
        intentId: 'intent_workspace_replace_ambiguous',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.replace',
        input: { path: filePath, oldText: 'same', newText: 'other' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('ambiguous-old-text');
      const readBack = await runtime.kernel.execute({
        id: 'exec_workspace_replace_ambiguous_read',
        intentId: 'intent_workspace_replace_ambiguous_read',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.read',
        input: { path: filePath },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
      });
      expect((readBack.output as { content?: unknown } | undefined)?.content).toBe('same same');
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(filePath, { force: true });
    }
  });

  it('should preserve exact write content and enforce the safe write limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-write-bounds-'));
    const exactPath = path.join(root, 'exact.txt');
    const hugePath = path.join(root, 'huge.txt');
    const exactContent = '  keep leading and trailing spaces  \n';
    const hugeContent = 'x'.repeat(512 * 1024 + 1);
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const exactWrite = await executeWorkspace(kernel, 'workspace.files.write', {
        path: exactPath,
        content: exactContent,
      }, true);
      const hugeWrite = await executeWorkspace(kernel, 'workspace.files.write', {
        path: hugePath,
        content: hugeContent,
      }, true);

      expect(exactWrite.ok).toBe(true);
      expect(await readFile(exactPath, 'utf8')).toBe(exactContent);
      expect(hugeWrite.ok).toBe(false);
      expect(hugeWrite.error).toBe('file-too-large');
      expect(await stat(hugePath).catch(() => undefined)).toBeUndefined();
    } finally {
      await kernel.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should report missing list and search roots instead of empty success', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-missing-root-'));
    const missing = path.join(root, 'missing-folder');
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const listed = await executeWorkspace(kernel, 'workspace.files.list', { path: missing });
      const searched = await executeWorkspace(kernel, 'workspace.files.search', {
        path: missing,
        query: 'needle',
      });

      expect(listed.ok).toBe(false);
      expect(listed.error).toBe('not-found');
      expect(searched.ok).toBe(false);
      expect(searched.error).toBe('not-found');
    } finally {
      await kernel.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should preserve search line numbers and previews without splitting the whole file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-search-lines-'));
    const filePath = path.join(root, 'lines.txt');
    await writeFile(filePath, 'alpha\r\n  NeEdLe preview  \nlast needle', 'utf8');
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const searched = await executeWorkspace(kernel, 'workspace.files.search', {
        path: filePath,
        query: 'needle',
        limit: 5,
      });
      const matches = (searched.output as {
        matches?: Array<{ line: number; preview: string }>;
      } | undefined)?.matches || [];

      expect(searched.ok).toBe(true);
      expect(matches).toEqual([
        { path: filePath, line: 2, preview: 'NeEdLe preview' },
        { path: filePath, line: 3, preview: 'last needle' },
      ]);
    } finally {
      await kernel.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses recoverable trash by default and verifies the exact original path is gone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-trash-'));
    const source = path.join(root, 'Юникод', 'данные.txt');
    const recycled = path.join(root, '.synthetic-recycle', 'данные.txt');
    const trashCalls: Array<{ targetPath: string; isDirectory: boolean }> = [];
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, Buffer.from([0, 1, 2, 3, 255]));
    const workspace = new WorkspaceModule({
      workspaceRoot: root,
      trashPath: async (targetPath, isDirectory) => {
        trashCalls.push({ targetPath, isDirectory });
        await mkdir(path.dirname(recycled), { recursive: true });
        await rename(targetPath, recycled);
      },
    });
    try {
      const result = await workspace.executeCapability({
        id: 'exec_workspace_trash_synthetic',
        intentId: 'intent_workspace_trash_synthetic',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.trash',
        input: { path: source },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      }, {
        emit: async () => ({}) as never,
        getPermissionProfile: () => ({
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        }),
      } as never);
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        output: {
          path: source,
          recycled: true,
          recoverable: true,
          exists: false,
          verified: true,
        },
      });
      expect(trashCalls).toEqual([{ targetPath: source, isDirectory: false }]);
      expect(await stat(source).catch(() => undefined)).toBeUndefined();
      expect(await readFile(recycled)).toEqual(Buffer.from([0, 1, 2, 3, 255]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the trash target identity changes before dispatch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-workspace-trash-race-'));
    const source = path.join(root, 'target.txt');
    const original = path.join(root, 'original.txt');
    await writeFile(source, 'original-object', 'utf8');
    let dispatched = false;
    const workspace = new WorkspaceModule({
      workspaceRoot: root,
      beforeMutation: async (operation) => {
        if (operation !== 'trash') return;
        await rename(source, original);
        await writeFile(source, 'replacement-object', 'utf8');
      },
      trashPath: async () => {
        dispatched = true;
      },
    });
    try {
      const result = await workspace.executeCapability({
        id: 'exec_workspace_trash_identity_race',
        intentId: 'intent_workspace_trash_identity_race',
        moduleId: 'workspace',
        capabilityId: 'workspace.files.trash',
        input: { path: source },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      }, {
        emit: async () => ({}) as never,
        getPermissionProfile: () => ({
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
        }),
      } as never);

      expect(result).toMatchObject({
        ok: false,
        error: 'trash-target-identity-changed',
        output: { recycled: false, verified: false, authoritative: true },
      });
      expect(dispatched).toBe(false);
      await expect(readFile(source, 'utf8')).resolves.toBe('replacement-object');
      await expect(readFile(original, 'utf8')).resolves.toBe('original-object');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips Unicode, empty and boundary content through overwrite, append, recursive copy, and move', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'workspace-matrix-'));
    const nested = path.join(root, 'Юникод 🌞', ...Array.from({ length: 12 }, (_entry, index) => `длинный-${index}`));
    const emptyPath = path.join(nested, 'пустой.txt');
    const boundaryPath = path.join(root, 'boundary.txt');
    const copiedRoot = path.join(root, 'копия');
    const movedPath = path.join(root, 'финал', 'перемещённый.txt');
    const exactBoundary = 'x'.repeat(512 * 1024);
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request', autonomyMode: 'full-local' },
    });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root }));
    await kernel.start();
    try {
      const empty = await executeWorkspace(kernel, 'workspace.files.write', { path: emptyPath, content: '' }, true);
      const boundary = await executeWorkspace(kernel, 'workspace.files.write', { path: boundaryPath, content: exactBoundary }, true);
      const overwrite = await executeWorkspace(kernel, 'workspace.files.write', {
        path: emptyPath,
        content: 'строка α\n',
        overwrite: true,
      }, true);
      const append = await executeWorkspace(kernel, 'workspace.files.append', {
        path: emptyPath,
        content: 'добавлено β\n',
      }, true);
      const copied = await executeWorkspace(kernel, 'workspace.files.copy', {
        path: path.join(root, 'Юникод 🌞'),
        targetPath: copiedRoot,
      }, true);
      const moved = await executeWorkspace(kernel, 'workspace.files.move', {
        path: path.join(copiedRoot, ...Array.from({ length: 12 }, (_entry, index) => `длинный-${index}`), 'пустой.txt'),
        targetPath: movedPath,
      }, true);

      expect(empty).toMatchObject({ ok: true, output: { bytes: 0, verified: true } });
      expect(boundary).toMatchObject({ ok: true, output: { bytes: 512 * 1024, verified: true } });
      expect(overwrite).toMatchObject({ ok: true, output: { verified: true } });
      expect(append).toMatchObject({ ok: true, output: { verified: true } });
      expect(copied).toMatchObject({ ok: true, output: { verified: true } });
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
      expect(moved).toMatchObject({
        ok: true,
        output: { sourceExists: false, targetExists: true, verified: true },
      });
      expect(await readFile(boundaryPath, 'utf8')).toBe(exactBoundary);
      expect(await readFile(emptyPath, 'utf8')).toBe('строка α\nдобавлено β\n');
      expect(await readFile(movedPath, 'utf8')).toBe('строка α\nдобавлено β\n');
    } finally {
      await kernel.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports simulated disk-full and permission denial without claiming or leaving a false success', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'workspace-faults-'));
    const protectedPath = path.join(root, 'protected.txt');
    await writeFile(protectedPath, 'original', 'utf8');
    const workspace = new WorkspaceModule({
      workspaceRoot: root,
      beforeMutation: (operation) => {
        const error = new Error(operation === 'write' ? 'Synthetic disk full' : 'Synthetic access denied') as NodeJS.ErrnoException;
        error.code = operation === 'write' ? 'ENOSPC' : 'EACCES';
        throw error;
      },
    });
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never', autonomyMode: 'full-local' },
    });
    kernel.registerModule(workspace);
    await kernel.start();
    try {
      const diskFull = await executeWorkspace(kernel, 'workspace.files.write', {
        path: path.join(root, 'new.txt'),
        content: 'must not persist',
      }, true);
      const denied = await executeWorkspace(kernel, 'workspace.files.append', {
        path: protectedPath,
        content: 'must not append',
      }, true);

      expect(diskFull).toMatchObject({ ok: false, error: 'disk-full', output: { verified: false } });
      expect(denied).toMatchObject({ ok: false, error: 'permission-denied', output: { verified: false } });
      expect(await stat(path.join(root, 'new.txt')).catch(() => undefined)).toBeUndefined();
      expect(await readFile(protectedPath, 'utf8')).toBe('original');
    } finally {
      await kernel.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not dispatch an already-cancelled write and reconciles cancellation after trash dispatch', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'workspace-cancel-'));
    const neverWritten = path.join(root, 'never-written.txt');
    const trashed = path.join(root, 'trash-me.txt');
    const syntheticRecycle = path.join(root, '.recycle', 'trash-me.txt');
    const preCancelled = new AbortController();
    preCancelled.abort();
    const postDispatch = new AbortController();
    await writeFile(trashed, 'trash payload', 'utf8');
    const workspace = new WorkspaceModule({
      workspaceRoot: root,
      trashPath: async (targetPath) => {
        await mkdir(path.dirname(syntheticRecycle), { recursive: true });
        await rename(targetPath, syntheticRecycle);
        postDispatch.abort();
      },
    });
    const context = {
      emit: async () => ({}) as never,
      getPermissionProfile: () => ({
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        autonomyMode: 'full-local',
      }),
    } as never;
    const request = (capabilityId: string, input: unknown) => ({
      id: `exec_${capabilityId}`,
      intentId: `intent_${capabilityId}`,
      moduleId: 'workspace',
      capabilityId,
      input,
      createdAt: new Date(0).toISOString(),
      requestedBy: 'smoke',
      confirmed: true,
    });
    try {
      await expect(workspace.executeCapability(
        request('workspace.files.write', { path: neverWritten, content: 'no' }),
        context,
        { signal: preCancelled.signal },
      )).rejects.toMatchObject({ name: 'AbortError' });
      const reconciled = await workspace.executeCapability(
        request('workspace.files.trash', { path: trashed }),
        context,
        { signal: postDispatch.signal },
      );

      expect(await stat(neverWritten).catch(() => undefined)).toBeUndefined();
      expect(reconciled).toMatchObject({
        ok: true,
        output: {
          exists: false,
          recycled: true,
          verified: true,
          cancellationObservedAfterDispatch: true,
        },
      });
      expect(await readFile(syntheticRecycle, 'utf8')).toBe('trash payload');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

let workspaceRouteSequence = 0;

function routeWorkspaceText(kernel: MonarchKernel, text: string) {
  workspaceRouteSequence += 1;
  return kernel.routeIntent({
    id: `intent_workspace_route_${workspaceRouteSequence}`,
    source: 'smoke',
    text,
    createdAt: new Date(0).toISOString(),
    context: {},
  });
}

function executeWorkspace(
  kernel: MonarchKernel,
  capabilityId: string,
  input: unknown,
  confirmed = false
) {
  return kernel.execute({
    id: `exec_${Math.random().toString(36).slice(2)}`,
    intentId: 'intent_workspace_profile',
    moduleId: 'workspace',
    capabilityId,
    input,
    createdAt: new Date(0).toISOString(),
    // This helper isolates workspace filesystem policy; the full runtime tests
    // exercise Monarch Security separately.
    requestedBy: 'smoke',
    confirmed,
  });
}
