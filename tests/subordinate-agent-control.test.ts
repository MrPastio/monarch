import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptTask,
  buildLaunch,
  compareSnapshots,
  issueTask,
  loadOwnerExceptions,
  loadPolicy,
  loadTaskRoleGrants,
  matchesPathRule,
  resolveAgent,
  rulesOverlap,
  symlinksOverlappingRules,
  validatePolicy,
  workspaceSnapshot,
} from '../scripts/subordinate-agent-control.mjs';

const root = path.resolve(import.meta.dirname, '..');
const policyPath = path.join(root, 'config', 'subordinate-agents.policy.json');

function options(values: Record<string, string | string[]>): Map<string, Array<string | true>> {
  return new Map(Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]));
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function temporaryRepository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'monarch-agent-control-'));
  git(directory, ['init']);
  git(directory, ['config', 'user.email', 'agent-control@example.invalid']);
  git(directory, ['config', 'user.name', 'Agent Control Test']);
  writeFileSync(path.join(directory, 'allowed.txt'), 'baseline\n');
  writeFileSync(path.join(directory, 'outside.txt'), 'baseline\n');
  writeFileSync(path.join(directory, 'AGENTS.md'), 'policy\n');
  writeFileSync(path.join(directory, '.gitignore'), '.agent-control/\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'baseline']);
  return directory;
}

describe('subordinate agent control policy', () => {
  it('loads a fail-closed policy with the current hierarchy', () => {
    const record = loadPolicy(policyPath);
    expect(record.digest).toMatch(/^[A-F0-9]{64}$/u);
    expect(resolveAgent(record.policy, 'codex')).toMatchObject({
      status: 'controller-integrator',
      subordinate: false,
    });
    expect(resolveAgent(record.policy, 'claude')).toMatchObject({
      status: 'controller-integrator',
      roles: ['controller', 'integrator'],
      subordinate: false,
      identityKind: 'host-session',
    });
    expect(resolveAgent(record.policy, 'grok')).toMatchObject({
      status: 'admitted',
      subordinate: true,
      subagents: { allowed: true, maxDepth: 1 },
    });
    expect(resolveAgent(record.policy, 'antigravity').status).toBe('denied');
    expect(resolveAgent(record.policy, 'unknown-agent').status).toBe('denied');
  });

  it('requires exact recorded owner grants and exact owner exceptions', () => {
    const policy = loadPolicy(policyPath).policy;
    expect(policy.recordedOwnerGrants
      .filter((grant: { agentId: string }) => grant.agentId === 'claude')
      .map((grant: { role: string }) => grant.role).sort()).toEqual(['controller', 'integrator']);
    expect(policy.ownerAuthority.roleGrant).toMatchObject({
      requiresAgentId: true,
      requiresTargetRole: true,
      effectiveOnlyAfterControllerRecord: true,
      retroactive: false,
    });
    expect(policy.ownerAuthority.restrictionException).toMatchObject({
      requiresAgentId: true,
      requiresRestrictionId: true,
      requiresConcreteTarget: true,
      requiresPurpose: true,
      retroactive: false,
    });
    expect(policy.restrictions.every((restriction: { ownerOverridable: boolean }) => restriction.ownerOverridable)).toBe(true);
  });

  it('rejects admission without a recorded owner grant and inconsistent Grok delegation', () => {
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.agents.find((agent: { id: string }) => agent.id === 'antigravity').status = 'admitted';
    expect(() => validatePolicy(policy)).toThrow('missing a recorded owner grant');

    const second = JSON.parse(readFileSync(policyPath, 'utf8'));
    second.agents.find((agent: { id: string }) => agent.id === 'grok').subagents.allowed = false;
    expect(() => validatePolicy(second)).toThrow('must match the delegation policy');

    const third = JSON.parse(readFileSync(policyPath, 'utf8'));
    third.agents.find((agent: { id: string }) => agent.id === 'claude').roles = ['worker'];
    expect(() => validatePolicy(third)).toThrow('Controller-integrator claude');
  });

  it('matches exact and directory scopes without parent traversal', () => {
    expect(matchesPathRule('src/agent/agent-runtime.ts', 'src/**')).toBe(true);
    expect(matchesPathRule('tests/example.test.ts', 'src/**')).toBe(false);
    expect(rulesOverlap('src/**', 'src/core/policy-kernel.ts')).toBe(true);
    expect(rulesOverlap('tests/**', 'src/**')).toBe(false);
    expect(rulesOverlap('agents.md', 'AGENTS.md')).toBe(true);
    expect(() => matchesPathRule('config/../AGENTS.md', 'config/**')).toThrow();
    expect(() => matchesPathRule('file.txt:stream', 'src/**')).toThrow('unsafe characters');
    expect(() => matchesPathRule('../Safe/value', 'src/**')).toThrow('escape');
  });

  it('rejects scopes backed by a Git symlink', () => {
    const repository = temporaryRepository();
    const object = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repository,
      input: 'outside.txt',
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${object},linked`], {
      cwd: repository,
      stdio: 'ignore',
    });
    expect(symlinksOverlappingRules(repository, ['linked/**'])).toEqual(['linked']);
    const record = loadPolicy(policyPath);
    expect(() => issueTask({
      repoRoot: repository,
      policyRecord: record,
      options: options({
        agent: 'grok',
        mode: 'implement',
        objective: 'Write through linked path',
        allow: 'linked/**',
      }),
    })).toThrow('crosses a symlink');
  });

  it('records direct web exceptions but keeps Safe exceptions mediated', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'monarch-owner-exception-'));
    const file = path.join(directory, 'exceptions.json');
    writeFileSync(file, JSON.stringify([
      {
        restrictionId: 'web-search',
        agentId: 'grok',
        target: 'grok-web-search',
        purpose: 'Read current official documentation for this task',
        approvalRef: 'owner-message:test-web',
      },
      {
        restrictionId: 'safe',
        agentId: 'grok',
        target: 'one-owner-named-record',
        purpose: 'Owner-requested exact record operation',
        approvalRef: 'owner-message:test-safe',
      },
    ]));
    const policy = loadPolicy(policyPath).policy;
    expect(loadOwnerExceptions(file, policy, 'grok')).toEqual([
      expect.objectContaining({ restrictionId: 'web-search', direct: true, enforcement: 'task-toggle' }),
      expect.objectContaining({ restrictionId: 'safe', direct: false, enforcement: 'broker-required' }),
    ]);
  });

  it('records exact task-scoped owner role grants', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'monarch-role-grant-'));
    const file = path.join(directory, 'roles.json');
    writeFileSync(file, JSON.stringify([
      {
        agentId: 'grok',
        role: 'integrator',
        purpose: 'Integrate this exact task after evidence review',
        approvalRef: 'owner-message:test-integrator',
      },
    ]));
    const policy = loadPolicy(policyPath).policy;
    expect(loadTaskRoleGrants(file, policy, 'grok')).toEqual([
      expect.objectContaining({ agentId: 'grok', role: 'integrator', lifetime: 'task' }),
    ]);
  });

  it('allows an explicitly task-granted integrator to decide only a valid candidate with evidence', () => {
    const repository = temporaryRepository();
    const record = loadPolicy(policyPath);
    const taskFile = path.join(repository, '.agent-control', 'tasks', 'task-integrator.json');
    mkdirSync(path.dirname(taskFile), { recursive: true });
    const baseline = workspaceSnapshot(repository, record.policy.protectedRepositoryPaths);
    writeFileSync(path.join(repository, 'allowed.txt'), 'candidate\n');
    const finalSnapshot = workspaceSnapshot(repository, record.policy.protectedRepositoryPaths);
    const comparison = compareSnapshots(
      baseline,
      finalSnapshot,
      ['allowed.txt'],
      record.policy.protectedRepositoryPaths,
      'implement',
    );
    writeFileSync(taskFile, JSON.stringify({
      schemaVersion: 1,
      id: 'task-integrator',
      status: 'candidate',
      policySha256: record.digest,
      mode: 'implement',
      expiresAt: '2099-01-01T00:00:00.000Z',
      allowedPaths: ['allowed.txt'],
      baseline,
      finalSnapshot,
      processExitCode: 0,
      comparison,
      taskRoleGrants: [{
        agentId: 'grok',
        role: 'integrator',
        purpose: 'Integrate this task',
        approvalRef: 'owner-message:test-integrator',
        lifetime: 'task',
      }],
    }));
    const result = acceptTask({
      repoRoot: repository,
      policyRecord: record,
      options: options({
        task: taskFile,
        integrator: 'grok',
        decision: 'accepted',
        evidence: ['vitest:pass', 'diff:reviewed'],
      }),
    });
    expect(result).toMatchObject({
      taskId: 'task-integrator',
      status: 'accepted',
      integratorDecision: { integratorId: 'grok', decision: 'accepted' },
    });

    writeFileSync(path.join(repository, 'allowed.txt'), 'changed after closure\n');
    expect(() => acceptTask({
      repoRoot: repository,
      policyRecord: record,
      options: options({
        task: taskFile,
        integrator: 'grok',
        decision: 'accepted',
        evidence: 'stale-evidence',
      }),
    })).toThrow('Only a candidate can be reviewed');
  });

  it('rejects candidate acceptance when the workspace changed after closure', () => {
    const repository = temporaryRepository();
    const record = loadPolicy(policyPath);
    const taskFile = path.join(repository, '.agent-control', 'tasks', 'task-stale.json');
    mkdirSync(path.dirname(taskFile), { recursive: true });
    const baseline = workspaceSnapshot(repository, record.policy.protectedRepositoryPaths);
    writeFileSync(path.join(repository, 'allowed.txt'), 'candidate\n');
    const finalSnapshot = workspaceSnapshot(repository, record.policy.protectedRepositoryPaths);
    writeFileSync(taskFile, JSON.stringify({
      schemaVersion: 1,
      id: 'task-stale',
      status: 'candidate',
      policySha256: record.digest,
      mode: 'implement',
      expiresAt: '2099-01-01T00:00:00.000Z',
      allowedPaths: ['allowed.txt'],
      baseline,
      finalSnapshot,
      processExitCode: 0,
      comparison: compareSnapshots(baseline, finalSnapshot, ['allowed.txt'], record.policy.protectedRepositoryPaths, 'implement'),
      taskRoleGrants: [],
    }));
    writeFileSync(path.join(repository, 'outside.txt'), 'changed after closure\n');
    expect(() => acceptTask({
      repoRoot: repository,
      policyRecord: record,
      options: options({
        task: taskFile,
        integrator: 'codex',
        decision: 'accepted',
        evidence: 'stale-evidence',
      }),
    })).toThrow('Workspace changed after candidate closure');
  });

  it('builds Grok launch arguments with inherited subagents and default-denied network', () => {
    const record = loadPolicy(policyPath);
    const agent = resolveAgent(record.policy, 'grok');
    const task = {
      id: 'task-test',
      agentId: 'grok',
      mode: 'implement',
      expiresAt: '2099-01-01T00:00:00.000Z',
      objective: 'Edit the allowed test file',
      allowedPaths: ['src/**'],
      ownerExceptions: [],
      subagents: { allowed: true, maxDepth: 1, inheritance: 'intersection' },
    };
    const launch = buildLaunch(agent, record.policy, task, root);
    expect(launch.args).toContain('--disable-web-search');
    expect(launch.args).not.toContain('--no-subagents');
    expect(launch.args).toContain('Read(E:/MonarchData/Safe/**)');
    expect(launch.args).toContain('Edit(E:/Monarch/config/subordinate-agents.policy.json)');
    expect(launch.args.join('\n')).toContain('inherit the strictest parent permit');
  });

  it('only lifts the direct web-search toggle for an exact owner exception', () => {
    const record = loadPolicy(policyPath);
    const agent = resolveAgent(record.policy, 'grok');
    const task = {
      id: 'task-web',
      agentId: 'grok',
      mode: 'observe',
      expiresAt: '2099-01-01T00:00:00.000Z',
      objective: 'Read official documentation',
      allowedPaths: [],
      ownerExceptions: [{
        restrictionId: 'web-search',
        agentId: 'grok',
        target: 'grok-web-search',
        purpose: 'Current documentation',
        approvalRef: 'owner-message:test',
        enforcement: 'task-toggle',
        direct: true,
      }],
      subagents: { allowed: true, maxDepth: 1, inheritance: 'intersection' },
    };
    const launch = buildLaunch(agent, record.policy, task, root);
    expect(launch.webAllowed).toBe(true);
    expect(launch.args).not.toContain('--disable-web-search');
    expect(launch.args).toContain('Read(E:/MonarchData/Safe/**)');
  });

  it('compares against the dirty baseline and rejects observe, protected and out-of-scope mutations', () => {
    const repository = temporaryRepository();
    const protectedPaths = ['AGENTS.md'];
    const baseline = workspaceSnapshot(repository, protectedPaths);
    writeFileSync(path.join(repository, 'allowed.txt'), 'changed\n');
    let current = workspaceSnapshot(repository, protectedPaths);
    expect(compareSnapshots(baseline, current, ['allowed.txt'], protectedPaths, 'implement')).toMatchObject({
      eligibleForIntegratorReview: true,
      changedPaths: ['allowed.txt'],
    });
    expect(compareSnapshots(baseline, current, ['allowed.txt'], protectedPaths, 'observe').violations)
      .toContainEqual({ code: 'observe-mode-mutation', path: 'allowed.txt' });

    writeFileSync(path.join(repository, 'outside.txt'), 'changed\n');
    writeFileSync(path.join(repository, 'AGENTS.md'), 'tampered\n');
    current = workspaceSnapshot(repository, protectedPaths);
    const comparison = compareSnapshots(baseline, current, ['allowed.txt'], protectedPaths, 'implement');
    expect(comparison.violations).toContainEqual({ code: 'out-of-scope-change', path: 'outside.txt' });
    expect(comparison.violations).toContainEqual({ code: 'protected-path-changed', path: 'AGENTS.md' });
    expect(comparison.eligibleForIntegratorReview).toBe(false);
  });

  it('refuses permits for denied agents and protected scopes', () => {
    const repository = temporaryRepository();
    const record = loadPolicy(policyPath);
    expect(() => issueTask({
      repoRoot: repository,
      policyRecord: record,
      options: options({ agent: 'antigravity', mode: 'observe', objective: 'Inspect source' }),
    })).toThrow('not admitted');
    expect(() => issueTask({
      repoRoot: repository,
      policyRecord: record,
      options: options({
        agent: 'grok',
        mode: 'implement',
        objective: 'Change policy',
        allow: 'config/subordinate-agents.policy.json',
      }),
    })).toThrow('protected policy path');
  });
});
