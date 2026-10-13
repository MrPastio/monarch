import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Native Electron helper has no declaration file.
import { prepareDevelopmentProfile } from '../../desktop/electron/development-profile.mjs';

describe('development Electron profile', () => {
  it('migrates only OS encryption metadata and preserves an existing target', () => {
    const root = mkdtempSync(path.resolve('.test-tmp/development-profile-'));
    const original = path.join(root, 'original'), target = path.join(root, 'development');
    mkdirSync(original);
    const originalState = { os_crypt: { encrypted_key: 'synthetic-wrapped-key' }, cookies: 'do-not-copy', metrics: {} };
    writeFileSync(path.join(original, 'Local State'), JSON.stringify(originalState));
    expect(prepareDevelopmentProfile({ defaultProfile: original, developmentProfile: target })).toBe(target);
    expect(JSON.parse(readFileSync(path.join(target, 'Local State'), 'utf8'))).toEqual({ os_crypt: originalState.os_crypt });
    writeFileSync(path.join(target, 'Local State'), '{"existing":true}');
    prepareDevelopmentProfile({ defaultProfile: original, developmentProfile: target });
    expect(readFileSync(path.join(target, 'Local State'), 'utf8')).toBe('{"existing":true}');
    expect(JSON.parse(readFileSync(path.join(original, 'Local State'), 'utf8'))).toEqual(originalState);
  });

  it('fails closed when a legacy profile exists without encryption metadata', () => {
    const root = mkdtempSync(path.resolve('.test-tmp/development-profile-'));
    const original = path.join(root, 'original'); mkdirSync(original);
    writeFileSync(path.join(original, 'Local State'), '{}');
    expect(() => prepareDevelopmentProfile({ defaultProfile: original,
      developmentProfile: path.join(root, 'development') })).toThrow('encryption-metadata-missing');
  });
});
