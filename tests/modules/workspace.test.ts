import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMonarchRuntime } from '../../src/bootstrap';
import { evaluateFilesystemAccess, MonarchKernel } from '../../src/core';
import { WorkspaceModule } from '../../src/modules/workspace';

describe('Workspace Module', () => {
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
      const searchResult = await runtime.kernel.submitIntent('найди в файлах router', 'smoke');
      expect(searchResult.route?.targetModuleId).toBe('workspace');
      expect(searchResult.route?.capabilityId).toBe('workspace.files.search');
      expect((searchResult.route?.input as any)?.query).toBe('router');

      const projectSearchResult = await runtime.kernel.submitIntent('найди AssistantModule в проекте', 'smoke');
      expect(projectSearchResult.route?.targetModuleId).toBe('workspace');
      expect(projectSearchResult.route?.capabilityId).toBe('workspace.files.search');
      expect((projectSearchResult.route?.input as any)?.query).toBe('AssistantModule');
      expect((projectSearchResult.route?.input as any)?.path).toBe('.');

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

});

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
