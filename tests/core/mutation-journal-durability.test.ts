import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MonarchExecutionRequest } from '../../src/core/contracts';
import { MonarchMutationJournal } from '../../src/core/mutation-journal';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Mutation Journal durable commit boundary', () => {
  it('rolls back a captured entry and removes its backup when journal commit fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-journal-durable-root-'));
    const storage = await mkdtemp(path.join(tmpdir(), 'monarch-journal-durable-store-'));
    roots.push(root, storage);
    const target = path.join(root, 'existing.txt');
    await writeFile(target, 'original bytes', 'utf8');
    const journal = new MonarchMutationJournal(root, storage);
    await mkdir(path.join(storage, 'journal.json'));

    const result = await journal.capture('ledger_failed_capture', requestFor(target));

    expect(result).toMatchObject({ supported: true, ok: false, error: expect.stringContaining('Unable to write durable JSON') });
    expect(journal.get('ledger_failed_capture')).toBeNull();
    expect(await readFile(target, 'utf8')).toBe('original bytes');
    expect(await readdir(path.join(storage, 'backups'))).toEqual([]);
  });

  it('does not publish finalized rollback state when its journal cannot commit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-journal-finalize-root-'));
    const storage = await mkdtemp(path.join(tmpdir(), 'monarch-journal-finalize-store-'));
    roots.push(root, storage);
    const target = path.join(root, 'created.txt');
    const journal = new MonarchMutationJournal(root, storage);
    const captured = await journal.capture('ledger_failed_finalize', requestFor(target));
    expect(captured.ok).toBe(true);
    await writeFile(target, 'created bytes', 'utf8');
    await rm(path.join(storage, 'journal.json'));
    await mkdir(path.join(storage, 'journal.json'));

    await expect(journal.finalize('ledger_failed_finalize', {
      ok: true,
      summary: 'created',
      output: { path: target },
    })).rejects.toThrowError(/Unable to write durable JSON/);

    expect(journal.get('ledger_failed_finalize')).toMatchObject({
      status: 'unavailable',
      reason: 'Action has not completed yet.',
    });
    expect(await readFile(target, 'utf8')).toBe('created bytes');
  });
});

function requestFor(target: string): MonarchExecutionRequest {
  return {
    id: `exec_${path.basename(target)}`,
    intentId: 'intent_journal_durable',
    moduleId: 'workspace',
    capabilityId: 'workspace.files.write',
    input: { path: target, content: 'new bytes' },
    createdAt: new Date(0).toISOString(),
    requestedBy: 'unit',
    proposalId: 'proposal_journal_durable',
  };
}
