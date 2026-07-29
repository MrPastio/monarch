import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readMonarchProductVersion,
  UNKNOWN_MONARCH_PRODUCT_VERSION,
} from '../../src/app/product-version';

const cleanupRoots: string[] = [];

afterEach(async () => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('Monarch product version', () => {
  it('reads the exact four-part version from the source package manifest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-version-'));
    cleanupRoots.push(root);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ version: '0.2.4.0' }),
      'utf8',
    );

    expect(readMonarchProductVersion(root)).toBe('0.2.4.0');
  });

  it('reports an unknown version instead of inventing product identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-version-'));
    cleanupRoots.push(root);
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ version: 'latest-local' }),
      'utf8',
    );

    expect(readMonarchProductVersion(root)).toBe(
      UNKNOWN_MONARCH_PRODUCT_VERSION,
    );
    expect(readMonarchProductVersion(path.join(root, 'missing'))).toBe(
      UNKNOWN_MONARCH_PRODUCT_VERSION,
    );
  });

  it('matches the checked-in package version for release builds', () => {
    const packageVersion = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'package.json'),
        'utf8',
      ),
    ).version as string;
    expect(readMonarchProductVersion(process.cwd())).toBe(packageVersion);
  });
});
