import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSkillRegistry } from '../../src/modules/astra/agent-skills';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentSkillRegistry', () => {
  it('discovers Codex, Claude, and legacy command formats without exposing bodies', async () => {
    const root = await createWorkspace();
    await writeSkill(root, '.agents/skills/review/SKILL.md', `---
name: review-worktree
description: Review a git worktree and report risky changes.
---

Read the diff, then run focused tests.
`);
    await writeSkill(root, '.claude/skills/deploy/SKILL.md', `---
name: deploy
description: Deploy an application when the user explicitly requests a deployment.
disable-model-invocation: true
argument-hint: "[environment]"
---

Deploy $ARGUMENTS after verification.
`);
    await writeSkill(root, '.claude/commands/legacy-check.md', 'Run the legacy check.');

    const skills = await new AgentSkillRegistry(root).list({ refresh: true });
    const review = skills.find((skill) => skill.name === 'review-worktree' && skill.scope === 'project');
    const deploy = skills.find((skill) => skill.name === 'deploy' && skill.scope === 'project');
    const legacy = skills.find((skill) => skill.name === 'legacy-check' && skill.scope === 'project');

    expect(review).toMatchObject({ provider: 'codex', allowImplicitInvocation: true });
    expect(deploy).toMatchObject({ provider: 'claude', allowImplicitInvocation: false });
    expect(legacy).toMatchObject({ provider: 'claude', legacyCommand: true });
    expect(review).not.toHaveProperty('instructions');
  });

  it('supports implicit matching plus explicit $skill and /skill invocation', async () => {
    const root = await createWorkspace();
    await writeSkill(root, '.agents/skills/review/SKILL.md', `---
name: review-worktree
description: Review a git diff or worktree and find risky code changes.
---

Inspect the diff and explain the risks.
`);
    await writeSkill(root, '.claude/skills/deploy/SKILL.md', `---
name: deploy
description: Deploy an application to a named environment.
disable-model-invocation: true
---

Deploy $ARGUMENTS from \${CLAUDE_SKILL_DIR}.
`);

    const registry = new AgentSkillRegistry(root);
    const implicit = await registry.match('review this git diff for risky changes');
    const hiddenImplicit = await registry.match('deploy the application to staging');
    const explicit = await registry.match('/deploy staging');
    const activated = await registry.activateForPrompt('$deploy staging', { limit: 1 });

    expect(implicit[0]).toMatchObject({
      skill: { name: 'review-worktree', scope: 'project' },
      explicit: false,
    });
    expect(hiddenImplicit.some((match) => match.skill.name === 'deploy')).toBe(false);
    expect(explicit[0]).toMatchObject({ skill: { name: 'deploy' }, explicit: true, score: 1 });
    expect(activated[0]?.instructions).toContain('Deploy staging');
    expect(activated[0]?.instructions).toContain('.claude\\skills\\deploy');
  });

  it('honors Codex openai.yaml implicit invocation policy', async () => {
    const root = await createWorkspace();
    await writeSkill(root, '.agents/skills/manual-check/SKILL.md', `---
name: manual-check
description: Check a release manually.
---

Run the release checklist.
`);
    await writeSkill(root, '.agents/skills/manual-check/agents/openai.yaml', `policy:
  allow_implicit_invocation: false
`);

    const registry = new AgentSkillRegistry(root);
    const skills = await registry.list({ refresh: true });
    const implicit = await registry.match('check this release manually');
    const explicit = await registry.match('$manual-check');

    expect(skills.find((skill) => skill.name === 'manual-check')?.allowImplicitInvocation).toBe(false);
    expect(implicit.some((match) => match.skill.name === 'manual-check')).toBe(false);
    expect(explicit[0]).toMatchObject({ skill: { name: 'manual-check' }, explicit: true });
  });

  it('deduplicates plugin copies by invocable name and prefers the closest scope', async () => {
    const root = await createWorkspace();
    await writeSkill(root, '.agents/skills/security-primary/SKILL.md', `---
name: deep-security-scan
description: Deep security scan for a repository.
---

Primary workflow.
`);
    await writeSkill(root, '.claude/skills/security-copy/SKILL.md', `---
name: deep-security-scan
description: Duplicate deep security scan.
---

Duplicate workflow.
`);

    const registry = new AgentSkillRegistry(root, 'win32');
    const skills = await registry.list({ refresh: true });

    expect(skills.filter((skill) => skill.name === 'deep-security-scan')).toHaveLength(1);
  });

  it('does not activate a macOS skill or a weak one-word implicit match on Windows', async () => {
    const root = await createWorkspace();
    await writeSkill(root, '.agents/skills/build-macos-apps/build-run-debug/SKILL.md', `---
name: build-run-debug
description: Build and debug a macOS app with Xcode.
---

Run xcodebuild.
`);
    await writeSkill(root, '.agents/skills/deep-security-scan/SKILL.md', `---
name: deep-security-scan
description: Run a deep exhaustive security scan of a repository.
---

Inspect the repository in several security passes.
`);

    const registry = new AgentSkillRegistry(root, 'win32');
    const incompatible = await registry.match('$build-run-debug');
    const explicitActivation = await registry.activateForPrompt('$build-run-debug', { limit: 1 });
    const noisyActivation = await registry.activateForPrompt('Продолжи текст про ограничения и безопасность');
    const strongActivation = await registry.activateForPrompt('Run a deep security scan of this repository');

    expect(incompatible[0]).toMatchObject({
      skill: { name: 'build-run-debug', compatible: false, platforms: ['darwin'] },
      explicit: true,
    });
    expect(explicitActivation).toEqual([]);
    expect(noisyActivation).toEqual([]);
    expect(strongActivation[0]?.name).toBe('deep-security-scan');
    expect(strongActivation.map((skill) => skill.name)).not.toContain('build-run-debug');
    expect(strongActivation.every((skill) => skill.compatible)).toBe(true);
  });

  it('supports Gemini CLI paths and gives the interoperable .agents alias higher precedence', async () => {
    const root = await createWorkspace();
    await writeSkill(root, '.gemini/skills/review/SKILL.md', `---
name: shared-review
description:
  Review changes using the Gemini workspace workflow and a multiline
  description that remains discoverable.
---

Gemini workflow.
`);
    await writeSkill(root, '.agents/skills/review/SKILL.md', `---
name: shared-review
description: Review changes using the interoperable workspace workflow.
---

Agents workflow.
`);

    const skills = await new AgentSkillRegistry(root).list({ refresh: true });
    const review = skills.find((skill) => skill.name === 'shared-review');

    expect(review).toMatchObject({
      provider: 'codex',
      sourceTier: 'workspace',
      trust: 'trusted',
      description: 'Review changes using the interoperable workspace workflow.',
    });
  });

  it('fingerprints skill instructions and inventories local resources before activation', async () => {
    const root = await createWorkspace();
    const skillPath = '.gemini/skills/file-guardian/SKILL.md';
    await writeSkill(root, skillPath, `---
name: file-guardian
description: Protect local file operations and verify their results.
---

Verify every write.
`);
    await writeSkill(root, '.gemini/skills/file-guardian/scripts/check.ps1', 'Write-Output ok');
    await writeSkill(root, '.gemini/skills/file-guardian/references/policy.md', 'Local only.');

    const registry = new AgentSkillRegistry(root);
    const metadata = (await registry.list({ refresh: true }))
      .find((skill) => skill.name === 'file-guardian');
    expect(metadata).toMatchObject({
      provider: 'gemini',
      resourceCount: 2,
      executableResourceCount: 1,
      requiresExplicitActivation: false,
    });
    expect(metadata?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    await writeSkill(root, skillPath, `---
name: file-guardian
description: Protect local file operations and verify their results.
---

Changed after discovery.
`);
    await expect(registry.activate('file-guardian', '$file-guardian', { explicit: true })).resolves.toBeNull();

    await registry.list({ refresh: true });
    const activated = await registry.activate('file-guardian', '$file-guardian', { explicit: true });
    expect(activated?.instructions).toContain('Changed after discovery.');
    expect(activated?.resources).toEqual([
      'references/policy.md',
      'scripts/check.ps1',
    ]);
  });

  it('exposes declared capability requirements as metadata without treating them as authority', async () => {
    const root = await createWorkspace();
    await writeSkill(root, '.agents/skills/workspace-editor/SKILL.md', `---
name: workspace-editor
description: Edit files in the current workspace.
required-capabilities:
  - workspace.files.read
  - workspace.files.write
requires_toolsets: [workspace.files.write, invalid/capability]
---

Use the host capabilities; never claim that this declaration grants permission.
`);

    const registry = new AgentSkillRegistry(root);
    const metadata = (await registry.list({ refresh: true }))
      .find((skill) => skill.name === 'workspace-editor');
    const activated = await registry.activate('workspace-editor', '$workspace-editor', { explicit: true });

    expect(metadata?.requiredCapabilities).toEqual([
      'workspace.files.read',
      'workspace.files.write',
    ]);
    expect(activated?.requiredCapabilities).toEqual(metadata?.requiredCapabilities);
    expect(activated).not.toHaveProperty('leaseId');
    expect(activated).not.toHaveProperty('permissionMode');
  });
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'monarch-skills-'));
  temporaryRoots.push(root);
  return root;
}

async function writeSkill(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}
