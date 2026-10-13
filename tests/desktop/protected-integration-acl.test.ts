import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { restrictProtectedIntegrationAcl } from '../../desktop/electron/protected-integration-acl.mjs';

let root: string;
beforeAll(async () => { root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'protected-acl-'))); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: false }); });

describe('protected integration ACL', () => {
  it('applies an explicit file ACL to every validated protected record', async () => {
    const record = path.join(root, 'journal-key.dpapi'); await writeFile(record, 'synthetic');
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));
    expect(await restrictProtectedIntegrationAcl(root, { platform: 'win32', domain: 'DOMAIN', username: 'owner',
      recordNames: ['journal-key.dpapi'], execute })).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[1]).toContain(path.resolve(root));
    expect(execute.mock.calls[1]?.[1]).toContain(record);
    expect(execute.mock.calls[1]?.[1]).toContain('DOMAIN\\owner:F');
  });

  it('rejects an aliased record instead of applying a misleading ACL', async () => {
    const alias = path.join(root, 'aliased.safe'); await mkdir(alias);
    const execute = vi.fn(async () => ({ stdout: '', stderr: '' }));
    expect(await restrictProtectedIntegrationAcl(root, { platform: 'win32', username: 'owner',
      recordNames: ['aliased.safe'], execute })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
