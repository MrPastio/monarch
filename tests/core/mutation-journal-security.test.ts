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
  it('journals and rolls back the exact Kernel-resolved known-folder leaf without full-disk authority', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'journal-known-workspace-'));
    const desktop = await mkdtemp(path.join(qaBase, 'journal-known-desktop-'));
    const storage = await mkdtemp(path.join(qaBase, 'journal-known-store-'));
    roots.push(root, desktop, storage);
    const oldDesktopDir = process.env.MONARCH_DESKTOP_DIR;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    const targetPath = path.join(desktop, 'ромашка.txt');
    const siblingPath = path.join(desktop, 'keep.txt');
    await writeFile(siblingPath, 'untouched', 'utf8');

    try {
      const journal = new MonarchMutationJournal(root, storage);
      const capture = await journal.capture('ledger_known_folder', {
        id: 'exec_known_folder',
        intentId: 'intent_known_folder',
        moduleId: 'workspace',
        capabilityId: 'workspace.known-folder.write',
        input: { knownFolder: 'desktop', basename: 'ромашка.txt', content: '' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        proposalId: 'proposal_known_folder',
      });
      expect(capture).toMatchObject({ supported: true, ok: true });

      await writeFile(targetPath, '', 'utf8');
      const rollback = await journal.finalize('ledger_known_folder', {
        ok: true,
        summary: 'Known-folder write verified.',
        output: { path: targetPath, verified: true },
      });
      expect(rollback).toMatchObject({ status: 'available', targetPath });
      await expect(journal.rollback(
        'ledger_known_folder',
        'workspace.known-folder.write',
      )).resolves.toMatchObject({ status: 'rolled-back', targetPath });
      await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(siblingPath, 'utf8')).resolves.toBe('untouched');

      const traversal = await journal.capture('ledger_known_folder_escape', {
        id: 'exec_known_folder_escape',
        intentId: 'intent_known_folder_escape',
        moduleId: 'workspace',
        capabilityId: 'workspace.known-folder.write',
        input: { knownFolder: 'desktop', basename: '../escape.txt', content: 'blocked' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        proposalId: 'proposal_known_folder_escape',
      });
      expect(traversal).toMatchObject({ supported: true, ok: false });
      expect(traversal.error).toContain('safe leaf');
    } finally {
      if (oldDesktopDir === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = oldDesktopDir;
    }
  });

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

  it('never deletes a file that won an exclusive-create race after capture', async () => {
    const qaBase = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA');
    await mkdir(qaBase, { recursive: true });
    const root = await mkdtemp(path.join(qaBase, 'journal-race-workspace-'));
    const desktop = await mkdtemp(path.join(qaBase, 'journal-race-desktop-'));
    const storage = await mkdtemp(path.join(qaBase, 'journal-race-store-'));
    roots.push(root, desktop, storage);
    const oldDesktopDir = process.env.MONARCH_DESKTOP_DIR;
    process.env.MONARCH_DESKTOP_DIR = desktop;
    const targetPath = path.join(desktop, 'race.txt');

    try {
      const journal = new MonarchMutationJournal(root, storage);
      await expect(journal.capture('ledger_known_folder_race', {
        id: 'exec_known_folder_race',
        intentId: 'intent_known_folder_race',
        moduleId: 'workspace',
        capabilityId: 'workspace.known-folder.write',
        input: { knownFolder: 'desktop', basename: 'race.txt', content: '' },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        proposalId: 'proposal_known_folder_race',
      })).resolves.toMatchObject({ supported: true, ok: true });

      await writeFile(targetPath, 'created by another process', 'utf8');
      await expect(journal.finalize('ledger_known_folder_race', {
        ok: false,
        summary: 'File already exists.',
        error: 'file-exists',
        output: { path: targetPath, verified: false },
      })).resolves.toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('not owned by this action'),
      });

      await expect(journal.rollback(
        'ledger_known_folder_race',
        'workspace.known-folder.write',
      )).resolves.toMatchObject({ status: 'unavailable' });
      await expect(readFile(targetPath, 'utf8')).resolves.toBe('created by another process');
    } finally {
      if (oldDesktopDir === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = oldDesktopDir;
    }
  });
});
