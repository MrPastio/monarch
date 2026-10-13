import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MonarchKernel } from '../../src/core';
import { CUSTOM_TOOL_SCRIPTS_DISABLED, CustomToolsModule } from '../../src/modules/custom-tools';
import { customToolsManifest } from '../../src/modules/custom-tools/manifest';
import * as customTools from '../../src/modules/custom-tools';

const activateContext = { emit: async () => undefined } as any;

async function withStore<T>(run: (storePath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'monarch-custom-tools-'));
  try {
    return await run(path.join(root, 'tools.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const execute = (module: CustomToolsModule, capabilityId: string, input: unknown) =>
  module.executeCapability({ capabilityId, input } as any, {} as any);

describe('Custom Tools security', () => {
  it('offers no way to add executable code', () => {
    const ids = customToolsManifest.capabilities.map(capability => capability.id);
    expect(ids).toEqual(['custom-tools.list', 'custom-tools.delete', 'custom-tools.execute']);
    expect(Object.keys(customTools)).not.toContain('CUSTOM_TOOL_GENERATOR_SYSTEM_PROMPT');
  });

  it('refuses the removed create and auto-create capabilities', async () => {
    await withStore(async (storePath) => {
      const module = new CustomToolsModule(storePath);
      await module.activate(activateContext);
      for (const capabilityId of ['custom-tools.create', 'custom-tools.auto-create']) {
        const result = await execute(module, capabilityId, { id: 'x-tool', title: 'X', script: 'return 1;', prompt: 'x' });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('unsupported-capability');
      }
    });
  });

  it('runs built-in tools as host code', async () => {
    await withStore(async (storePath) => {
      const module = new CustomToolsModule(storePath);
      await module.activate(activateContext);
      const slug = await execute(module, 'custom-tools.execute', { toolId: 'text-slugify', input: { text: 'Привет, Мир!' } });
      expect(slug).toMatchObject({ ok: true, output: { result: 'привет-мир' } });
      const picked = await execute(module, 'custom-tools.execute', {
        toolId: 'json-pick', input: { object: { a: 1, b: 2 }, keys: ['a', 'missing'] },
      });
      expect(picked).toMatchObject({ ok: true, output: { result: { a: 1 } } });
      const invalid = await execute(module, 'custom-tools.execute', { toolId: 'text-slugify', input: { text: 42 } });
      expect(invalid).toMatchObject({ ok: false, error: 'invalid-tool-input' });
    });
  });

  it('keeps saved script tools as disabled data and never runs them', async () => {
    await withStore(async (storePath) => {
      const legacy = { id: 'legacy-tool', title: 'Legacy', description: 'Saved before', risk: 'none', script: 'return 1;' };
      const seeded = { id: 'clock-now', title: 'Current time', description: 'old seed', risk: 'none', script: 'return 0;' };
      await writeFile(storePath, JSON.stringify([seeded, legacy]), 'utf8');
      const module = new CustomToolsModule(storePath);
      await module.activate(activateContext);

      const listed = await execute(module, 'custom-tools.list', {});
      const tools = (listed.output as any).tools as Array<Record<string, unknown>>;
      expect(tools.find(tool => tool.id === 'legacy-tool')).toMatchObject({
        executable: false, builtIn: false, disabledReason: CUSTOM_TOOL_SCRIPTS_DISABLED,
      });
      expect(tools.some(tool => 'script' in tool)).toBe(false);
      expect(tools.filter(tool => tool.id === 'clock-now')).toHaveLength(1);

      const run = await execute(module, 'custom-tools.execute', { toolId: 'legacy-tool', input: {} });
      expect(run).toMatchObject({ ok: false, error: CUSTOM_TOOL_SCRIPTS_DISABLED });

      // The old built-in seed is dropped from the file; the owner's record stays as written.
      expect(JSON.parse(await readFile(storePath, 'utf8'))).toEqual([legacy]);

      const builtInDelete = await execute(module, 'custom-tools.delete', { id: 'clock-now' });
      expect(builtInDelete).toMatchObject({ ok: false, error: 'built-in-tool' });
      const deleted = await execute(module, 'custom-tools.delete', { id: 'legacy-tool' });
      expect(deleted.ok).toBe(true);
      expect(JSON.parse(await readFile(storePath, 'utf8'))).toEqual([]);
    });
  });

  it('creates an empty store and leaves an unreadable one untouched', async () => {
    await withStore(async (storePath) => {
      await new CustomToolsModule(storePath).activate(activateContext);
      expect(JSON.parse(await readFile(storePath, 'utf8'))).toEqual([]);
      await writeFile(storePath, '{broken', 'utf8');
      await new CustomToolsModule(storePath).activate(activateContext);
      expect(await readFile(storePath, 'utf8')).toBe('{broken');
    });
  });

  it('blocks local and private targets in the built-in fetch tool', async () => {
    await withStore(async (storePath) => {
      const module = new CustomToolsModule(storePath);
      await module.activate(activateContext);
      const executed = await execute(module, 'custom-tools.execute', {
        toolId: 'web-fetch-text', input: { url: 'http://localhost:4317/api/system' },
      });
      expect(executed.ok).toBe(false);
      expect(executed.error).toBe('custom-tool-execution-failed');
      expect(executed.summary).toContain('Local and private network fetch targets are blocked');
    });
  });

  it('takes tool risk from the host, never from the stored record or the request', async () => {
    await withStore(async (storePath) => {
      await writeFile(storePath, JSON.stringify([{ id: 'legacy-tool', title: 'Legacy', risk: 'none', script: 'return 1;' }]), 'utf8');
      const kernel = new MonarchKernel();
      kernel.registerModule(new CustomToolsModule(storePath));
      try {
        await kernel.start();
        const request = (id: string, toolId: string, input: Record<string, unknown>) => kernel.execute({
          id, intentId: `intent_${id}`, moduleId: 'custom-tools', capabilityId: 'custom-tools.execute',
          input: { toolId, input, declaredRisk: 'none' }, createdAt: new Date(0).toISOString(),
          requestedBy: 'smoke', confirmed: false,
        });

        expect((await request('exec_clock', 'clock-now', {})).ok).toBe(true);

        const network = await request('exec_network', 'web-fetch-text', { url: 'https://example.com' });
        expect(network.ok).toBe(false);
        expect(network.error).toBe('confirmation-required');
        expect((network.metadata as any).permission.risk).toBe('network');

        const legacy = await request('exec_legacy', 'legacy-tool', {});
        expect(legacy.ok).toBe(false);
        expect((legacy.metadata as any).permission.risk).toBe('execute');
      } finally {
        await kernel.stop().catch(() => undefined);
      }
    });
  });
});
