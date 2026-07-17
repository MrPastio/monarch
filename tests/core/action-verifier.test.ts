import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyActionPredicates } from '../../src/core/action-verifier';

const roots: string[] = [];

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
});
