import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { MonarchKernel } from '../../src/core';
import { MemoryModule } from '../../src/modules/memory';
import { MonarchMemoryStore } from '../../src/modules/memory/store';

describe('Memory Module', () => {
  it('serializes concurrent snapshot writes without losing records', async () => {
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `smoke-memory-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const store = new MonarchMemoryStore({ filePath });
    await store.load();

    try {
      await Promise.all(Array.from({ length: 40 }, (_, index) => (
        store.remember(`concurrent memory ${index}`, 'test')
      )));
      const raw = await readFile(filePath, 'utf8');
      const snapshot = JSON.parse(raw) as { version: number; records: Array<{ text: string }> };

      expect(snapshot.version).toBe(3);
      expect(snapshot.records).toHaveLength(40);
      expect(new Set(snapshot.records.map((record) => record.text)).size).toBe(40);
      expect(raw).not.toContain('\n  "records"');
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it('should require confirmation and persist memory', async () => {
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `smoke-memory-confirm-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new MemoryModule({ storePath: filePath }));
    
    await kernel.start();
    try {
      const unconfirmedMemory = await kernel.submitIntent('Запомни: Monarch должен быть локальной экосистемой', 'smoke');
      expect(unconfirmedMemory.execution?.error).toBe('confirmation-required');

      const confirmedMemory = await kernel.submitIntent('Запомни: Monarch должен быть локальной экосистемой', 'smoke', { confirmed: true });
      if (!confirmedMemory.execution?.ok) throw new Error(confirmedMemory.summary);
      expect(confirmedMemory.execution?.ok).toBe(true);

      const recalledMemory = await kernel.submitIntent('Вспомни Monarch', 'smoke');
      if (!recalledMemory.execution?.ok) throw new Error(recalledMemory.summary);
      expect(recalledMemory.execution?.ok).toBe(true);
    } finally {
      await kernel.stop();
      await rm(filePath, { force: true });
    }
  });

  it('should migrate v1 legacy snapshot to v3', async () => {
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `smoke-memory-v1-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const legacySnapshot = {
      version: 1,
      records: [
        {
          id: 'mem_legacy_smoke',
          text: 'legacy Monarch project memory',
          source: 'smoke',
          createdAt: new Date(0).toISOString(),
        },
      ],
    };
    let kernel: MonarchKernel | undefined;

    try {
      await writeFile(filePath, `${JSON.stringify(legacySnapshot, null, 2)}\n`, 'utf8');
      kernel = new MonarchKernel();
      kernel.registerModule(new MemoryModule({ storePath: filePath }));
      await kernel.start();

      const recalled = await kernel.submitIntent('recall legacy Monarch', 'smoke');
      await kernel.stop();
      kernel = undefined;

      const records = (
        recalled.execution?.output as { records?: Array<{ text?: unknown; tier?: unknown; category?: unknown; accessCount?: unknown }> } | undefined
      )?.records || [];
      const migrated = records.find((record) => record.text === 'legacy Monarch project memory');
      
      expect(recalled.execution?.ok).toBe(true);
      expect(migrated).toBeDefined();
      expect(migrated?.tier).toBe('long');
      expect(migrated?.category).toBe('project');
      expect(migrated?.accessCount).toBe(1);

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { version?: unknown };
      expect(persisted.version).toBe(3);
    } finally {
      await kernel?.stop().catch(() => undefined);
      await rm(filePath, { force: true });
    }
  });

  it('should preserve v3 metadata and unknown extension fields when persisting', async () => {
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `smoke-memory-v3-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const snapshot = {
      version: 3,
      records: [
        {
          id: 'mem_v3_smoke',
          text: 'structured Monarch memory',
          source: 'smoke',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          category: 'project',
          tier: 'long',
          importance: 0.8,
          accessCount: 0,
          pinned: false,
          decayRate: 0.02,
          type: 'architecture_note',
          title: 'Architecture note',
          tags: ['studio', 'modules'],
          priority: 0.9,
          relatedFiles: ['src/modules/studio/index.ts'],
          relatedModules: ['studio'],
          customExtension: { schema: 7, preserved: true },
        },
      ],
    };

    try {
      await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      const store = new MonarchMemoryStore({ filePath });
      await store.load();
      const records = await store.search('structured Monarch');
      expect(records[0]).toMatchObject({
        type: 'architecture_note',
        title: 'Architecture note',
        tags: ['studio', 'modules'],
        priority: 0.9,
        relatedFiles: ['src/modules/studio/index.ts'],
        relatedModules: ['studio'],
        customExtension: { schema: 7, preserved: true },
      });

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        version: number;
        records: Array<Record<string, unknown>>;
      };
      expect(persisted.version).toBe(3);
      expect(persisted.records[0]).toMatchObject({
        type: 'architecture_note',
        title: 'Architecture note',
        tags: ['studio', 'modules'],
        priority: 0.9,
        relatedFiles: ['src/modules/studio/index.ts'],
        relatedModules: ['studio'],
        customExtension: { schema: 7, preserved: true },
      });
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it('should persist across module restarts', async () => {
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `smoke-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    let firstKernel: MonarchKernel | undefined;
    let secondKernel: MonarchKernel | undefined;

    try {
      firstKernel = new MonarchKernel();
      firstKernel.registerModule(new MemoryModule({ storePath: filePath }));
      await firstKernel.start();

      const remembered = await firstKernel.submitIntent(
        'Запомни: persistent smoke memory',
        'smoke',
        { confirmed: true }
      );
      await firstKernel.stop();
      firstKernel = undefined;

      if (!remembered.execution?.ok) throw new Error(remembered.summary);
      expect(remembered.execution?.ok).toBe(true);
      
      const rememberedRecord = remembered.execution.output as { record?: { tier?: unknown; category?: unknown; importance?: unknown } } | undefined;
      expect(rememberedRecord?.record?.tier).toBe('long');
      expect(rememberedRecord?.record?.category).toBe('fact');
      expect(typeof rememberedRecord?.record?.importance).toBe('number');

      secondKernel = new MonarchKernel();
      secondKernel.registerModule(new MemoryModule({ storePath: filePath }));
      await secondKernel.start();

      const recalled = await secondKernel.submitIntent('Вспомни persistent smoke', 'smoke');
      await secondKernel.stop();
      secondKernel = undefined;

      const records = (
        recalled.execution?.output as { records?: Array<{ text?: unknown }> } | undefined
      )?.records || [];

      if (!recalled.execution?.ok) throw new Error(recalled.summary);
      expect(recalled.execution?.ok).toBe(true);
      expect(records.some((record) => record.text === 'persistent smoke memory')).toBe(true);
    } finally {
      await firstKernel?.stop().catch(() => undefined);
      await secondKernel?.stop().catch(() => undefined);
      await rm(filePath, { force: true });
    }
  });

  it('edits and removes a permanent memory record', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new MemoryModule({ storePath: false }));
    await kernel.start();
    try {
      const created = await kernel.execute({
        id: 'exec_memory_create_ui', intentId: 'intent_memory_create_ui', moduleId: 'memory', capabilityId: 'memory.remember',
        input: { text: 'старое правило', category: 'preference', tier: 'permanent', pinned: true },
        requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      const id = (created.output as { record: { id: string } }).record.id;
      const updated = await kernel.execute({
        id: 'exec_memory_update_ui', intentId: 'intent_memory_update_ui', moduleId: 'memory', capabilityId: 'memory.update',
        input: { id, text: 'новое правило', category: 'project', pinned: false, tier: 'long' },
        requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect(updated.ok).toBe(true);
      expect((updated.output as { record: { text: string; category: string; pinned: boolean } }).record)
        .toMatchObject({ text: 'новое правило', category: 'project', pinned: false });

      const removed = await kernel.execute({
        id: 'exec_memory_forget_ui', intentId: 'intent_memory_forget_ui', moduleId: 'memory', capabilityId: 'memory.forget',
        input: { id }, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect(removed.ok).toBe(true);
      const listed = await kernel.execute({
        id: 'exec_memory_list_ui', intentId: 'intent_memory_list_ui', moduleId: 'memory', capabilityId: 'memory.list',
        input: { limit: 20 }, requestedBy: 'smoke', createdAt: new Date(0).toISOString(),
      });
      expect((listed.output as { records: unknown[] }).records).toHaveLength(0);
    } finally {
      await kernel.stop();
    }
  });

  it('creates classified memory entries, filters by type, and closes temporary records', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new MemoryModule({ storePath: false }));
    await kernel.start();
    try {
      const architecture = await kernel.execute({
        id: 'exec_memory_architecture',
        intentId: 'intent_memory_architecture',
        moduleId: 'memory',
        capabilityId: 'memory.remember',
        input: {
          text: 'Planner must keep architecture decisions separate from temporary tasks.',
          type: 'architecture_note',
          title: 'Planner memory taxonomy',
          tags: ['planner', 'taxonomy'],
          relatedModules: ['planner', 'memory'],
          priority: 0.82,
        },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      const temporary = await kernel.execute({
        id: 'exec_memory_temporary',
        intentId: 'intent_memory_temporary',
        moduleId: 'memory',
        capabilityId: 'memory.remember',
        input: {
          text: 'Temporary task: re-run diagnostics report after memory taxonomy lands.',
          type: 'temporary_task',
          tags: ['planner'],
        },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      const temporaryId = (temporary.output as { record: { id: string } }).record.id;

      const search = await kernel.execute({
        id: 'exec_memory_search_architecture',
        intentId: 'intent_memory_search_architecture',
        moduleId: 'memory',
        capabilityId: 'memory.search',
        input: { query: 'planner taxonomy', types: ['architecture_note'], localOnly: true },
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      const close = await kernel.execute({
        id: 'exec_memory_close_temporary',
        intentId: 'intent_memory_close_temporary',
        moduleId: 'memory',
        capabilityId: 'memory.close_temporary',
        input: { id: temporaryId },
        requestedBy: 'smoke',
        confirmed: true,
        createdAt: new Date(0).toISOString(),
      });
      const listedActiveTemporary = await kernel.execute({
        id: 'exec_memory_list_temporary',
        intentId: 'intent_memory_list_temporary',
        moduleId: 'memory',
        capabilityId: 'memory.list',
        input: { types: ['temporary_task'], limit: 20 },
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });
      const listedClosedTemporary = await kernel.execute({
        id: 'exec_memory_list_closed_temporary',
        intentId: 'intent_memory_list_closed_temporary',
        moduleId: 'memory',
        capabilityId: 'memory.list',
        input: { types: ['temporary_task'], includeClosed: true, limit: 20 },
        requestedBy: 'smoke',
        createdAt: new Date(0).toISOString(),
      });

      expect(architecture.ok).toBe(true);
      expect((architecture.output as { record: { type: string; title: string; relatedModules: string[] } }).record)
        .toMatchObject({ type: 'architecture_note', title: 'Planner memory taxonomy', relatedModules: ['planner', 'memory'] });
      expect(search.ok).toBe(true);
      expect((search.output as { records: Array<{ type: string }> }).records.every((record) => record.type === 'architecture_note')).toBe(true);
      expect(close.ok).toBe(true);
      expect((listedActiveTemporary.output as { records: unknown[] }).records).toHaveLength(0);
      expect((listedClosedTemporary.output as { records: unknown[] }).records).toHaveLength(1);
    } finally {
      await kernel.stop();
    }
  });
});
