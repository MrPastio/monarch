import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MonarchKernel } from '../../src/core';
import { CoderModule } from '../../src/modules/coder';
import { CoderRunStore } from '../../src/modules/coder/context-manager';

const context = {
  emit: async () => undefined,
  audit: async () => undefined,
} as any;

describe('Coder Mode', () => {
  it('creates projects under Workspace Coder and keeps Monarch and OS paths immutable', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-host-'));
    const module = new CoderModule({ monarchRoot });
    await module.activate(context);
    try {
      const created = await execute(module, 'coder.projects.create', { name: 'Agent Demo' });
      expect(created.ok).toBe(true);
      const project = created.output as any;
      expect(project.root.toLowerCase()).toContain(path.join(monarchRoot, 'Workspace Coder').toLowerCase());

      const write = await execute(module, 'coder.files.write', {
        projectId: project.id,
        path: 'src/index.ts',
        content: 'export const ready = true;\n',
      });
      expect(write.ok).toBe(true);
      expect(write.output).toMatchObject({ verified: true, sizeBytes: 27 });
      expect((write.output as any).sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(path.join(project.root, 'src', 'index.ts'), 'utf8')).toContain('ready');

      const monarchBlocked = await execute(module, 'coder.files.write', {
        projectId: project.id,
        path: path.join(monarchRoot, 'src', 'protected.ts'),
        content: 'no',
      });
      expect(monarchBlocked.error).toBe('coder-policy-blocked');
      await writeFile(path.join(monarchRoot, 'system-note.txt'), 'private Monarch data', 'utf8');
      const monarchReadBlocked = await execute(module, 'coder.files.read', {
        projectId: project.id,
        path: path.join(monarchRoot, 'system-note.txt'),
      });
      expect(monarchReadBlocked.error).toBe('coder-policy-blocked');

      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const systemBlocked = await execute(module, 'coder.files.write', {
        projectId: project.id,
        path: path.join(systemRoot, 'monarch-coder-test.txt'),
        content: 'no',
      });
      expect(systemBlocked.error).toBe('coder-policy-blocked');

      if (process.env.USERPROFILE) {
        const credentialRead = await execute(module, 'coder.files.read', {
          projectId: project.id,
          path: path.join(process.env.USERPROFILE, '.ssh', 'id_rsa'),
        });
        expect(credentialRead.error).toBe('coder-policy-blocked');
        expect(credentialRead.summary).toContain('Credential stores');
      }
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });

  it('supports exact patches, bounded commands, and promote-or-delete project skills', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-tools-'));
    const module = new CoderModule({ monarchRoot });
    await module.activate(context);
    try {
      const project = (await execute(module, 'coder.projects.create', { name: 'Tooling' })).output as any;
      await execute(module, 'coder.files.write', { projectId: project.id, path: 'value.txt', content: 'alpha', overwrite: false });
      const patched = await execute(module, 'coder.files.patch', {
        projectId: project.id,
        path: 'value.txt',
        replacements: [{ oldText: 'alpha', newText: 'beta' }],
      });
      expect(patched.ok).toBe(true);
      expect(patched.output).toMatchObject({ verified: true, sizeBytes: 4 });
      expect(await readFile(path.join(project.root, 'value.txt'), 'utf8')).toBe('beta');

      const command = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("coder-ok")'],
        timeoutMs: 10_000,
      });
      expect(command.ok, command.summary).toBe(true);
      expect((command.output as any).stdout).toBe('coder-ok');
      expect((command.output as any).isolation).toMatchObject({
        verified: true,
        appContainer: true,
        lowIntegrity: true,
        hostFilesystemDefaultDeny: true,
      });

      await execute(module, 'coder.files.write', {
        projectId: project.id,
        path: 'hello.js',
        content: "console.log('MONARCH_CODER_OK');\n",
      });
      const nodeFile = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: 'node',
        args: ['hello.js'],
      });
      expect(nodeFile.ok).toBe(true);
      expect((nodeFile.output as any).stdout.trim()).toBe('MONARCH_CODER_OK');
      const nodeAbsoluteFile = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: 'node',
        args: [path.join(project.root, 'hello.js')],
      });
      expect(nodeAbsoluteFile.ok, nodeAbsoluteFile.summary).toBe(true);
      expect((nodeAbsoluteFile.output as any).stdout.trim()).toBe('MONARCH_CODER_OK');

      const dangerous = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: 'powershell.exe',
        args: ['-NoProfile', '-Command', 'Remove-Item -Recurse -Force C:\\'],
      });
      expect(dangerous.ok).toBe(false);
      expect(dangerous.summary).toContain('host-protection');

      const monarchCwd = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("no")'],
        cwd: monarchRoot,
      });
      expect(monarchCwd.ok).toBe(false);
      expect(monarchCwd.summary).toContain('Monarch system files');

      const embeddedMonarchWrite = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(monarchRoot, 'protected-via-command.txt'))}, 'no')`],
      });
      expect(embeddedMonarchWrite.ok).toBe(false);
      expect(embeddedMonarchWrite.summary).toContain('protected Monarch');

      const embeddedSystemWrite = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: 'powershell.exe',
        args: ['-NoProfile', '-Command', "Set-Content \"$env:windir\\Temp\\monarch-coder.txt\" no"],
      });
      expect(embeddedSystemWrite.ok).toBe(false);
      expect(embeddedSystemWrite.summary).toContain('protected operating-system');

      const credentialCommand = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: 'powershell.exe',
        args: ['-NoProfile', '-Command', 'Get-Content "$env:USERPROFILE\\.ssh\\id_rsa"'],
      });
      expect(credentialCommand.ok).toBe(false);
      expect(credentialCommand.summary).toContain('protected credential');

      const skill = await execute(module, 'coder.skills.create', {
        projectId: project.id,
        name: 'Verify Output',
        description: 'Checks a generated result.',
        instructions: 'Inspect the requested artifact, run its focused verification command, and report only observed results.',
        validation: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
      });
      expect(skill.ok).toBe(true);
      expect(existsSync(path.join(project.root, '.monarch', 'skills', 'verify-output', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(project.root, '.monarch', 'skills', 'verify-output', 'skill.json'))).toBe(true);
      const activeSkills = await module.listActiveSkills(project.id);
      expect(activeSkills).toHaveLength(1);
      expect(activeSkills[0]).toMatchObject({ name: 'verify-output', description: 'Checks a generated result.' });
      expect(activeSkills[0]?.instructions).toContain('focused verification command');

      const failedSkill = await execute(module, 'coder.skills.create', {
        projectId: project.id,
        name: 'Broken Check',
        description: 'This validation must fail.',
        instructions: 'Run the deliberately failing validation and do not retain this draft skill after the failure.',
        validation: { executable: process.execPath, args: ['-e', 'process.exit(2)'] },
      });
      expect(failedSkill.ok).toBe(false);
      const skills = await readdir(path.join(project.root, '.monarch', 'skills'));
      expect(skills.some((name) => name.includes('broken-check'))).toBe(false);
      expect(await module.listActiveSkills(project.id)).toHaveLength(1);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it.runIf(process.platform === 'win32')('enforces the AppContainer filesystem boundary below model-visible command policy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-isolation-'));
    const monarchRoot = path.join(root, 'host');
    const outside = path.join(root, 'outside-project.txt');
    const previousTarget = process.env.MONARCH_SANDBOX_ESCAPE_TARGET;
    process.env.MONARCH_SANDBOX_ESCAPE_TARGET = outside;
    const module = new CoderModule({ monarchRoot });
    await module.activate(context);
    try {
      const project = (await execute(module, 'coder.projects.create', { name: 'Isolation' })).output as any;
      const attemptedEscape = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: process.execPath,
        args: ['-e', 'require("fs").writeFileSync(process.env.MONARCH_SANDBOX_ESCAPE_TARGET,"escape")'],
        timeoutMs: 10_000,
      });
      expect(attemptedEscape.ok).toBe(false);
      expect(existsSync(outside)).toBe(false);
      expect(attemptedEscape.output, attemptedEscape.summary).toBeDefined();
      expect((attemptedEscape.output as any).stderr).toMatch(/EPERM|EACCES/);
      expect((attemptedEscape.output as any).isolation).toMatchObject({
        kind: 'windows-appcontainer-acl',
        verified: true,
        appContainer: true,
        lowIntegrity: true,
        projectReadWrite: true,
        hostFilesystemDefaultDeny: true,
      });

      const noNetwork = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.MONARCH_CODER_SANDBOX || "missing")'],
        allowNetwork: false,
      });
      expect(noNetwork.ok).toBe(true);
      expect((noNetwork.output as any).stdout).toContain('windows-appcontainer');
      expect((noNetwork.output as any).isolation.networkAllowed).toBe(false);
    } finally {
      if (previousTarget === undefined) delete process.env.MONARCH_SANDBOX_ESCAPE_TARGET;
      else process.env.MONARCH_SANDBOX_ESCAPE_TARGET = previousTarget;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.runIf(process.platform === 'win32')('contains child processes for the full verified command lifetime', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-job-'));
    const module = new CoderModule({ monarchRoot });
    await module.activate(context);
    try {
      const project = (await execute(module, 'coder.projects.create', { name: 'Job Lifetime' })).output as any;
      const marker = path.join(project.root, 'orphan-marker.txt');
      await writeFile(path.join(project.root, 'spawn-child.cmd'), [
        '@echo off',
        'start "" /b cmd.exe /d /s /c "choice /d y /n /t 3 >nul & echo SHOULD_NOT_SURVIVE>orphan-marker.txt" >nul 2>&1',
        'exit /b 0',
        '',
      ].join('\r\n'), 'utf8');

      const command = await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: '.\\spawn-child.cmd',
        args: [],
        timeoutMs: 5_000,
        allowNetwork: false,
      });
      expect(command.ok, command.summary).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps generic network requests public and credential-free and blocks sensitive Hub uploads', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-integrations-'));
    const module = new CoderModule({ monarchRoot });
    await module.activate(context);
    try {
      const localTarget = await execute(module, 'coder.network.request', { url: 'http://127.0.0.1:65535/private' });
      expect(localTarget.ok).toBe(false);
      expect(localTarget.summary).toMatch(/local and private network/i);

      const credentialUrl = await execute(module, 'coder.network.request', { url: 'https://user:password@example.com/' });
      expect(credentialUrl.ok).toBe(false);
      expect(credentialUrl.summary).toMatch(/credentials.*blocked/i);

      const credentialHeader = await execute(module, 'coder.network.request', {
        url: 'https://example.com/',
        headers: { Authorization: 'Bearer secret' },
      });
      expect(credentialHeader.ok).toBe(false);
      expect(credentialHeader.summary).toMatch(/authenticated integrations/i);

      const oversized = await execute(module, 'coder.network.request', {
        url: 'https://example.com/',
        method: 'POST',
        body: 'x'.repeat(256 * 1024 + 1),
      });
      expect(oversized.ok).toBe(false);
      expect(oversized.summary).toMatch(/body exceeds/i);

      const project = (await execute(module, 'coder.projects.create', { name: 'Upload Audit' })).output as any;
      await execute(module, 'coder.files.write', { projectId: project.id, path: 'github_token.txt', content: 'secret' });
      const upload = await execute(module, 'coder.huggingface.upload', {
        projectId: project.id,
        repoId: 'example/repository',
        localPath: '.',
      });
      expect(upload.ok).toBe(false);
      expect(upload.summary).toMatch(/credential-like file/i);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32' && process.env.MONARCH_SKIP_SANDBOXED_GIT_TEST !== '1')('provides a verified first-class Git lifecycle inside AppContainer', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-git-'));
    const module = new CoderModule({ monarchRoot });
    await module.activate(context);
    try {
      const project = (await execute(module, 'coder.projects.create', { name: 'Git Lifecycle' })).output as any;
      const initialized = await execute(module, 'coder.git.init', { projectId: project.id, initialBranch: 'main' });
      expect(initialized.ok, initialized.summary).toBe(true);
      expect(initialized.output).toMatchObject({ branch: 'main', verified: true });

      await execute(module, 'coder.files.write', { projectId: project.id, path: 'README.md', content: '# Coder Git\n' });
      const staged = await execute(module, 'coder.git.stage', { projectId: project.id, paths: ['README.md'] });
      expect(staged.ok).toBe(true);
      expect(staged.output).toMatchObject({ stagedFiles: ['README.md'], verified: true });

      const committed = await execute(module, 'coder.git.commit', { projectId: project.id, message: 'Initial Coder commit' });
      expect(committed.ok).toBe(true);
      expect((committed.output as any).commit).toMatch(/^[a-f0-9]{40}$/);
      expect(committed.output).toMatchObject({ subject: 'Initial Coder commit', verified: true });

      const branched = await execute(module, 'coder.git.branch.create', { projectId: project.id, name: 'feature/verified' });
      expect(branched.ok).toBe(true);
      expect(branched.output).toMatchObject({ branch: 'feature/verified', verified: true });
      const status = await execute(module, 'coder.git.status', { projectId: project.id });
      expect(status.ok).toBe(true);
      expect((status.output as any).stdout).toContain('feature/verified');
      expect((status.output as any).stdout).not.toContain('.monarch/');
      expect((status.output as any).isolation).toMatchObject({ verified: true, appContainer: true });

      expect((await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: 'git',
        args: ['remote', 'add', 'origin', 'https://github.com/example/example.git'],
      })).ok).toBe(true);
      expect((await execute(module, 'coder.command.run', {
        projectId: project.id,
        executable: 'git',
        args: ['config', 'core.fsmonitor', '!calc.exe'],
      })).ok).toBe(true);
      const blockedPush = await execute(module, 'coder.git.push', { projectId: project.id, remote: 'origin' });
      expect(blockedPush.ok).toBe(false);
      expect(blockedPush.summary).toMatch(/host-executable configuration/i);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps a full durable journal while compacting the prompt projection', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-context-'));
    try {
      const store = new CoderRunStore({ monarchRoot, budgetTokens: 8_192, reservedOutputTokens: 1_024 });
      const run = store.create('project-1', 'Refactor and verify the module.');
      for (let index = 0; index < 45; index += 1) {
        store.addEvent(run.id, 'tool-result', `Read file ${index}`, 'x'.repeat(1_200), {
          capabilityId: 'coder.files.read',
          ok: true,
        });
      }
      const restored = store.require(run.id);
      const projection = store.projection(run.id);
      expect(restored.events.length).toBeGreaterThan(45);
      expect(restored.context.compactions).toBeGreaterThan(0);
      expect(projection.recentEvents.length).toBeLessThanOrEqual(20);
      const projectedTokens = Math.ceil(JSON.stringify({ summary: projection.summary, recentEvents: projection.recentEvents }).length / 3.6);
      expect(projectedTokens).toBeLessThanOrEqual(2_400);
      expect(projection.metrics.estimatedPromptTokens).toBe(projectedTokens);

      const reloaded = new CoderRunStore({ monarchRoot, budgetTokens: 8_192, reservedOutputTokens: 1_024 });
      expect(reloaded.require(run.id).events.length).toBe(restored.events.length);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });

  it('recovers an interrupted long-running agent journal without losing compacted state', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-recovery-'));
    try {
      const store = new CoderRunStore({ monarchRoot, budgetTokens: 8_192, reservedOutputTokens: 1_024 });
      const run = store.create('project-long-run', 'Implement a multi-stage project and keep verified progress across restarts.');
      expect(run.maxIterations).toBe(64);
      store.setStatus(run.id, 'running', 'Long run started.');
      for (let index = 0; index < 240; index += 1) {
        store.addEvent(run.id, 'tool-result', `Verified step ${index}`, `receipt-${index}-${'x'.repeat(360)}`, {
          capabilityId: index % 6 === 0 ? 'coder.files.write' : 'coder.files.read',
          ok: true,
          ...(index % 6 === 0 ? { output: { path: `src/generated-${index}.ts`, verified: true } } : {}),
        });
      }
      store.setPending(run.id, ['Run the final focused test.', 'Produce a receipt-grounded summary.']);
      const beforeRestart = store.require(run.id);
      expect(beforeRestart.context.compactions).toBeGreaterThan(5);
      expect(beforeRestart.summary.modifiedFiles.length).toBeGreaterThan(20);

      const restored = new CoderRunStore({ monarchRoot, budgetTokens: 8_192, reservedOutputTokens: 1_024 });
      const interrupted = restored.require(run.id);
      const projection = restored.projection(run.id);
      const projectedTokens = Math.ceil(JSON.stringify({ summary: projection.summary, recentEvents: projection.recentEvents }).length / 3.6);
      expect(interrupted.status).toBe('failed');
      expect(interrupted.error).toMatch(/stopped before completion/i);
      expect(interrupted.events).toHaveLength(beforeRestart.events.length);
      expect(interrupted.summary.pending).toEqual(['Run the final focused test.', 'Produce a receipt-grounded summary.']);
      expect(projectedTokens).toBeLessThanOrEqual(2_400);
      expect(projection.metrics.estimatedPromptTokens).toBe(projectedTokens);

      const resumed = restored.create('project-long-run', 'Resume from the preserved journal and finish.');
      expect(resumed.maxIterations).toBe(64);
      expect(restored.list('project-long-run').map((entry) => entry.id)).toEqual([resumed.id, run.id]);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });

  it('removes only a terminal plaintext run journal after a verified Safe migration', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-safe-delete-'));
    try {
      const store = new CoderRunStore({ monarchRoot });
      const run = store.create('project-1', 'Move this completed session into Safe.');
      expect(() => store.delete(run.id)).toThrow(/running Coder session/i);
      store.setStatus(run.id, 'completed', 'Verified terminal result.');
      const journal = path.join(monarchRoot, 'runtime', 'coder', 'runs', `${run.id}.json`);
      expect(existsSync(journal)).toBe(true);
      expect(store.delete(run.id)).toMatchObject({ id: run.id, status: 'completed' });
      expect(existsSync(journal)).toBe(false);
      expect(store.get(run.id)).toBeNull();
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });

  it('allows the internal Coder lane to execute without exposing its override to normal API requests', async () => {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-kernel-'));
    const module = new CoderModule({ monarchRoot });
    const kernel = new MonarchKernel({
      workspaceRoot: monarchRoot,
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request', autonomyMode: 'workspace-autonomous' },
    });
    kernel.registerModule(module);
    await kernel.start();
    try {
      const project = await module.projects.create('Kernel Lane');
      await writeFile(path.join(project.root, 'delete-me.txt'), 'temporary', 'utf8');

      const normal = await kernel.executeActionProposal({
        capabilityId: 'coder.files.delete',
        args: { projectId: project.id, path: 'delete-me.txt' },
        reason: 'cleanup',
        expectedEffect: 'delete one project file',
      }, { originatingUserText: 'delete the file', requestedBy: 'api' });
      expect(normal.result.error).toBe('confirmation-required');

      const internal = await kernel.executeActionProposal({
        capabilityId: 'coder.files.delete',
        args: { projectId: project.id, path: 'delete-me.txt' },
        reason: 'cleanup',
        expectedEffect: 'delete one project file',
      }, {
        originatingUserText: 'delete the file',
        requestedBy: 'coder-controller',
        executionMode: 'coder',
        permissionProfileOverride: { sandboxMode: 'danger-full-access', approvalPolicy: 'never', autonomyMode: 'full-local' },
      });
      expect(internal.result.ok).toBe(true);
      expect(internal.result.output).toMatchObject({ verified: true });
    } finally {
      await kernel.stop();
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });
});

async function execute(module: CoderModule, capabilityId: string, input: unknown) {
  return module.executeCapability({ capabilityId, input } as any, context);
}
