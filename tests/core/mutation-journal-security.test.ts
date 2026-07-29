import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchMutationJournal } from '../../src/core/mutation-journal';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Mutation Journal durable boundary security', () => {
  it('never restores external rollback authority from a persisted boundaryRoot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-journal-root-'));
    const storage = await mkdtemp(path.join(os.tmpdir(), 'monarch-journal-store-'));
    const external = await mkdtemp(path.join(os.tmpdir(), 'monarch-journal-external-'));
    roots.push(root, storage, external);
    const targetPath = path.join(external, 'must-stay.txt');
    await writeFile(targetPath, 'current-external-data', 'utf8');
    await mkdir(storage, { recursive: true });
    await writeFile(path.join(storage, 'journal.json'), JSON.stringify({
      version: 1,
      entries: [{
        version: 1,
        ledgerId: 'ledger_external_fixture',
        capabilityId: 'workspace.files.write',
        targetPath,
        boundaryRoot: external,
        before: { kind: 'missing', digest: 'before', bytes: 0, entries: 0 },
        after: { kind: 'file', digest: 'after', bytes: 21, entries: 1 },
        state: {
          status: 'available',
          targetPath,
          capturedAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          reason: 'tampered fixture',
        },
      }],
    }), 'utf8');

    const journal = new MonarchMutationJournal(root, storage);
    expect(journal.get('ledger_external_fixture')).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('process-local'),
    });
    await expect(journal.rollback(
      'ledger_external_fixture',
      'workspace.files.write',
    )).resolves.toMatchObject({ status: 'blocked' });
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('current-external-data');
  });
});
