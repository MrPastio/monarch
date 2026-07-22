import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonarchActionPredicate, MonarchCapability } from '../../src/core/contracts';
import { normalizeActionProposal } from '../../src/core/action-protocol';
import { verifyActionPredicates } from '../../src/core/action-verifier';

const roots: string[] = [];
const workspaceWrite: MonarchCapability = {
  id: 'workspace.files.write',
  moduleId: 'workspace',
  title: 'Write file',
  risk: 'write',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Action Protocol predicate verifier', () => {
  it('checks bounded filesystem preconditions and result verification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-verifier-'));
    roots.push(root);
    await mkdir(path.join(root, 'notes'));
    await writeFile(path.join(root, 'notes', 'a.txt'), 'hello Monarch', 'utf8');

    const preconditions = await verifyActionPredicates([
      { kind: 'exists', target: 'notes/a.txt' },
      { kind: 'contains', target: 'notes/a.txt', value: 'Monarch' },
    ], { phase: 'precondition', workspaceRoot: root, allowedRoots: [root] });
    expect(preconditions.every((entry) => entry.ok)).toBe(true);

    const verification = await verifyActionPredicates([
      { kind: 'equals', target: 'result.output.path', value: 'notes/a.txt' },
    ], {
      phase: 'verification',
      workspaceRoot: root,
      allowedRoots: [root],
      result: { ok: true, summary: 'done', output: { path: 'notes/a.txt' } },
    });
    expect(verification[0]).toMatchObject({ ok: true, code: 'predicate-ok' });
  });

  it('fails closed when a predicate target leaves the canonical scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-verifier-'));
    roots.push(root);
    const observations = await verifyActionPredicates([
      { kind: 'not-exists', target: '../outside.txt' },
    ], { phase: 'precondition', workspaceRoot: root, allowedRoots: [root] });
    expect(observations[0]).toMatchObject({ ok: false, code: 'predicate-outside-scope' });
  });

  it('fails closed when runtime callers bypass predicate value typing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-verifier-'));
    roots.push(root);
    await mkdir(path.join(root, 'notes'));
    await writeFile(path.join(root, 'notes', 'a.txt'), 'hello Monarch', 'utf8');

    const malformed = [
      { kind: 'contains', target: 'notes/a.txt' },
      { kind: 'contains', target: 'notes/a.txt', value: '' },
      { kind: 'equals', target: 'result.output.path' },
      { kind: 'status', target: 'result.ok', value: { state: true } },
      { kind: 'exists', target: 'notes/a.txt', value: undefined },
    ] as unknown as MonarchActionPredicate[];
    const observations = await verifyActionPredicates(malformed, {
      phase: 'verification',
      workspaceRoot: root,
      allowedRoots: [root],
      result: { ok: true, summary: 'done', output: { path: 'notes/a.txt' } },
    });

    expect(observations).toHaveLength(malformed.length);
    expect(observations.every((entry) => !entry.ok && entry.code === 'predicate-value-invalid')).toBe(true);
  });

  it('verifies predicates preserved by the public action-protocol path without coercion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-verifier-'));
    roots.push(root);
    await mkdir(path.join(root, 'notes'));
    await writeFile(path.join(root, 'notes', 'a.txt'), 'hello Monarch', 'utf8');
    const proposal = normalizeActionProposal({
      capabilityId: workspaceWrite.id,
      args: { path: 'notes/a.txt', content: 'other content' },
      verification: [{ kind: 'contains', target: 'notes/a.txt', value: 'expected content' }],
    }, { capability: workspaceWrite, workspaceRoot: root });

    const observations = await verifyActionPredicates(proposal.verification, {
      phase: 'verification',
      workspaceRoot: root,
      allowedRoots: [root],
      result: { ok: true, summary: 'done' },
    });

    expect(observations[0]).toMatchObject({ ok: false, code: 'predicate-mismatch' });
  });
});
