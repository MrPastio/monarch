import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MonarchKernel } from '../../src/core';
import { CUSTOM_TOOL_GENERATOR_SYSTEM_PROMPT, CustomToolsModule } from '../../src/modules/custom-tools';

describe('Custom Tools security', () => {
  it('keeps the generator contract compact and treats the request as untrusted data', () => {
    expect(CUSTOM_TOOL_GENERATOR_SYSTEM_PROMPT.length).toBeLessThan(1400);
    expect(CUSTOM_TOOL_GENERATOR_SYSTEM_PROMPT).toContain('untrusted user description');
    expect(CUSTOM_TOOL_GENERATOR_SYSTEM_PROMPT).toContain('Never use process, require, imports');
    expect(CUSTOM_TOOL_GENERATOR_SYSTEM_PROMPT).toContain('Return JSON only');
  });

  it('should seed safe basic tools and validate scripts on create', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-custom-tools-'));
    const module = new CustomToolsModule(path.join(root, 'tools.json'));

    try {
      await module.activate({ emit: async () => undefined } as any);
      const listed = await module.executeCapability({
        capabilityId: 'custom-tools.list',
        input: {},
      } as any, {} as any);

      expect(listed.ok).toBe(true);
      expect((listed.output as any).tools.some((tool: any) => tool.id === 'clock-now')).toBe(true);

      const blocked = await module.executeCapability({
        capabilityId: 'custom-tools.create',
        input: {
          id: 'bad-tool',
          title: 'Bad tool',
          risk: 'none',
          script: 'return process.env;',
        },
      } as any, {} as any);

      expect(blocked.ok).toBe(false);
      expect(blocked.error).toBe('custom-tool-script-blocked');

      const persisted = JSON.parse(await readFile(path.join(root, 'tools.json'), 'utf8'));
      expect(persisted.some((tool: any) => tool.id === 'text-slugify')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should block local and private fetch targets inside tool scripts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-custom-tools-'));
    const module = new CustomToolsModule(path.join(root, 'tools.json'));

    try {
      const created = await module.executeCapability({
        capabilityId: 'custom-tools.create',
        input: {
          id: 'ssrf-smoke',
          title: 'SSRF smoke',
          risk: 'network',
          script: "const response = await fetch(input.url); return await response.text();",
        },
      } as any, {} as any);
      expect(created.ok).toBe(true);

      const executed = await module.executeCapability({
        capabilityId: 'custom-tools.execute',
        input: {
          toolId: 'ssrf-smoke',
          input: { url: 'http://localhost:4317/api/system' },
        },
      } as any, {} as any);

      expect(executed.ok).toBe(false);
      expect(executed.error).toBe('custom-tool-execution-failed');
      expect(executed.summary).toContain('Local and private network fetch targets are blocked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should let the kernel use registered tool risk for execute permission', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-custom-tools-'));
    const kernel = new MonarchKernel();
    kernel.registerModule(new CustomToolsModule(path.join(root, 'tools.json')));

    try {
      await kernel.start();

      const safe = await kernel.execute({
        id: 'exec_custom_safe',
        intentId: 'intent_custom_safe',
        moduleId: 'custom-tools',
        capabilityId: 'custom-tools.execute',
        input: {
          toolId: 'clock-now',
          input: {},
          declaredRisk: 'execute',
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: false,
      });

      expect(safe.ok).toBe(true);

      const network = await kernel.execute({
        id: 'exec_custom_network',
        intentId: 'intent_custom_network',
        moduleId: 'custom-tools',
        capabilityId: 'custom-tools.execute',
        input: {
          toolId: 'web-fetch-text',
          input: { url: 'https://example.com' },
          declaredRisk: 'none',
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: false,
      });

      expect(network.ok).toBe(false);
      expect(network.error).toBe('confirmation-required');
      expect((network.metadata as any).permission.risk).toBe('network');
    } finally {
      await kernel.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
