import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeLaunch } from '../../desktop/electron/runtime-entry.mjs';

describe('Electron runtime entry', () => {
  const workspaceRoot = 'F:\\Monarch';

  it('prefers the prebuilt Node bundle in installed copies', () => {
    const bundle = path.join(workspaceRoot, 'dist', 'monarch-server.mjs');
    const launch = resolveRuntimeLaunch({
      workspaceRoot,
      fileExists: (candidate: string) => candidate === bundle,
    });

    expect(launch).toEqual({
      kind: 'bundle',
      entryPath: bundle,
      args: [bundle],
    });
  });

  it('keeps tsx only as a development fallback', () => {
    const tsx = path.join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const source = path.join(workspaceRoot, 'src', 'main.ts');
    const launch = resolveRuntimeLaunch({
      workspaceRoot,
      fileExists: (candidate: string) => candidate === tsx || candidate === source,
    });

    expect(launch.kind).toBe('tsx');
    expect(launch.args).toEqual([tsx, source]);
  });

  it('fails closed when neither runtime form exists', () => {
    expect(() => resolveRuntimeLaunch({
      workspaceRoot,
      fileExists: () => false,
    })).toThrow(/runtime files are missing[\s\S]*dist\/monarch-server\.mjs/i);
  });
});
