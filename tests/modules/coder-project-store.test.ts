import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoderProjectStore } from '../../src/modules/coder/project-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Coder project registry durability', () => {
  it.each([
    ['malformed JSON', '{ broken registry', /invalid JSON/],
    ['schema-invalid JSON', '{"version":1,"activeProjectId":null,"projects":[{"id":"vanishing"}]}\n', /invalid schema/],
  ])('fails closed on %s without replacing its bytes', async (_label, content, expectedError) => {
    const root = await temporaryRoot('monarch-coder-registry-corrupt-');
    const registryPath = path.join(root, 'state', 'projects.json');
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, content, 'utf8');

    expect(() => new CoderProjectStore({ monarchRoot: root, registryPath })).toThrowError(expectedError);
    await expect(readFile(registryPath, 'utf8')).resolves.toBe(content);
  });

  it('rolls back registry state and removes only a newly-created project after commit failure', async () => {
    const root = await temporaryRoot('monarch-coder-registry-create-');
    const registryPath = path.join(root, 'state', 'projects.json');
    const workspaceCoderRoot = path.join(root, 'Workspace Coder');
    const store = new CoderProjectStore({ monarchRoot: root, registryPath, workspaceCoderRoot });
    await store.initialize();
    await rm(registryPath);
    await mkdir(registryPath);

    await expect(store.create('Must Roll Back')).rejects.toThrowError(/Unable to write durable JSON/);
    expect(store.list().projects).toEqual([]);
    expect(await readdir(workspaceCoderRoot)).toEqual([]);
  });

  it('restores the previous active project when activation cannot commit', async () => {
    const root = await temporaryRoot('monarch-coder-registry-activate-');
    const registryPath = path.join(root, 'state', 'projects.json');
    const store = new CoderProjectStore({ monarchRoot: root, registryPath });
    await store.initialize();
    const first = await store.create('First');
    const second = await store.create('Second');
    const before = store.list();
    expect(before.activeProjectId).toBe(second.id);
    await rm(registryPath);
    await mkdir(registryPath);

    expect(() => store.activate(first.id)).toThrowError(/Unable to write durable JSON/);
    expect(store.list()).toEqual(before);
  });

  it('never deletes an imported project when registry commit fails', async () => {
    const root = await temporaryRoot('monarch-coder-registry-import-');
    const external = await temporaryRoot('monarch-coder-imported-project-');
    const registryPath = path.join(root, 'state', 'projects.json');
    await writeFile(path.join(external, 'keep.txt'), 'user project data', 'utf8');
    const store = new CoderProjectStore({ monarchRoot: root, registryPath });
    await store.initialize();
    await rm(registryPath);
    await mkdir(registryPath);

    await expect(store.import(external, 'Imported')).rejects.toThrowError(/Unable to write durable JSON/);
    await expect(readFile(path.join(external, 'keep.txt'), 'utf8')).resolves.toBe('user project data');
    await expect(readdir(path.join(external, '.monarch'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.list().projects).toEqual([]);
  });

  it('serializes parallel same-name creates without collisions or lost registry entries', async () => {
    const root = await temporaryRoot('monarch-coder-registry-parallel-create-');
    const store = new CoderProjectStore({ monarchRoot: root });
    await store.initialize();

    const created = await Promise.all(Array.from({ length: 16 }, () => store.create('Same Name')));
    expect(new Set(created.map((project) => project.id))).toHaveLength(16);
    expect(new Set(created.map((project) => project.root.toLowerCase()))).toHaveLength(16);
    expect(store.list().projects).toHaveLength(16);

    const restored = new CoderProjectStore({ monarchRoot: root });
    await restored.initialize();
    expect(restored.list().projects).toHaveLength(16);
  });

  it('coalesces parallel imports of the same external project', async () => {
    const root = await temporaryRoot('monarch-coder-registry-parallel-import-');
    const external = await temporaryRoot('monarch-coder-registry-parallel-external-');
    await writeFile(path.join(external, 'keep.txt'), 'user project data', 'utf8');
    const store = new CoderProjectStore({ monarchRoot: root });
    await store.initialize();

    const imported = await Promise.all(Array.from({ length: 12 }, () => store.import(external, 'Same Import')));
    expect(new Set(imported.map((project) => project.id))).toHaveLength(1);
    expect(store.list().projects).toHaveLength(1);
    await expect(readFile(path.join(external, 'keep.txt'), 'utf8')).resolves.toBe('user project data');
  });

  it('continues queued project mutations after an earlier request is rejected', async () => {
    const root = await temporaryRoot('monarch-coder-registry-queue-recovery-');
    const store = new CoderProjectStore({ monarchRoot: root });
    await store.initialize();

    const results = await Promise.allSettled([
      store.create(''),
      store.create('Recovered One'),
      store.create('Recovered Two'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(store.list().projects).toHaveLength(2);
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
