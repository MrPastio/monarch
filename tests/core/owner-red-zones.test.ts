import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { evaluateFilesystemAccess } from '../../src/core/filesystem-policy';
import { OwnerRedZoneError, OwnerRedZoneStore } from '../../src/core/owner-red-zones';

describe('owner red zones', () => {
  it('blocks a chosen folder even with Full Access, and never lets Safe be added', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'owner-red-zones-'));
    const forbidden = await mkdtemp(path.join(tmpdir(), 'owner-red-forbidden-'));
    try {
      const store = new OwnerRedZoneStore(stateRoot);
      const zone = store.add(forbidden);
      expect(zone.path).toBe(path.resolve(forbidden));
      expect(store.add(forbidden).id).toBe(zone.id);
      expect(evaluateFilesystemAccess(path.join(forbidden, 'game.html'), 'write', {
        workspaceRoot: stateRoot,
        allowFullDiskAccess: true,
        redZoneRoots: store.paths(),
      })).toMatchObject({ allowed: false, reason: 'red-zone-write-blocked' });
      expect(evaluateFilesystemAccess(path.join(stateRoot, 'ok.html'), 'write', {
        workspaceRoot: stateRoot,
        allowFullDiskAccess: true,
        redZoneRoots: store.paths(),
      }).allowed).toBe(true);
      const safeRoot = path.join(path.parse(stateRoot).root, 'MonarchData', 'Safe');
      expect(() => store.add(safeRoot)).toThrow(OwnerRedZoneError);
      expect(store.remove(zone.id)?.id).toBe(zone.id);
      expect(evaluateFilesystemAccess(path.join(forbidden, 'game.html'), 'write', {
        workspaceRoot: stateRoot,
        allowFullDiskAccess: true,
        redZoneRoots: store.paths(),
      }).allowed).toBe(true);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
      await rm(forbidden, { recursive: true, force: true });
    }
  });
});
