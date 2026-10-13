import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SECURITY_POLICY_CONTROLS, SecurityPolicyError, SecurityPolicyStore, securityLevelRank,
} from '../../src/settings/security-policy';

const roots: string[] = [];
const store = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'monarch-security-policy-'));
  roots.push(root);
  return { root, store: new SecurityPolicyStore(root) };
};
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Monarch Security policy center', () => {
  it('defines every control with strictest-first levels, a valid default and plain descriptions', () => {
    const ids = new Set<string>();
    for (const control of SECURITY_POLICY_CONTROLS) {
      expect(ids.has(control.id)).toBe(false);
      ids.add(control.id);
      expect(control.levels.length).toBeGreaterThanOrEqual(2);
      expect(['basic', 'advanced']).toContain(control.visibility);
      expect(securityLevelRank(control.id, control.defaultLevel)).toBe(0);
      for (const level of control.levels) expect(level.description.length).toBeGreaterThan(10);
    }
  });

  it('starts at the safe defaults and reads damaged or unknown values as defaults', async () => {
    const { root, store: policy } = await store();
    expect(policy.level('links.confirmOpen')).toBe('always');
    await mkdir(path.join(root, 'settings'), { recursive: true });
    await writeFile(path.join(root, 'settings', 'security-policy.v1.json'),
      JSON.stringify({ schemaVersion: 1, levels: { 'links.confirmOpen': 'whatever', 'search.queryMinimization': 'off' } }));
    expect(policy.snapshot().levels).toEqual({ 'links.confirmOpen': 'always', 'storage.encryption': 'required',
      'storage.keyRecovery': 'safe', 'telegram.cloudSeparateKey': 'required', 'search.queryMinimization': 'off' });
    await writeFile(path.join(root, 'settings', 'security-policy.v1.json'), '{damaged');
    expect(policy.level('search.queryMinimization')).toBe('on');
  });

  it('weakens only with explicit confirmation and strengthens at once, logging both without content', async () => {
    const { root, store: policy } = await store();
    expect(() => policy.set({ control: 'links.confirmOpen', level: 'off' }))
      .toThrow(new SecurityPolicyError('weakening-unconfirmed'));
    expect(policy.level('links.confirmOpen')).toBe('always');
    policy.set({ control: 'links.confirmOpen', level: 'off', confirmWeakening: true });
    expect(policy.level('links.confirmOpen')).toBe('off');
    policy.set({ control: 'links.confirmOpen', level: 'always' });
    expect(policy.level('links.confirmOpen')).toBe('always');
    const log = (await readFile(path.join(root, 'settings', 'security-policy.log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(log.map(entry => [entry.control, entry.from, entry.to, entry.direction])).toEqual([
      ['links.confirmOpen', 'always', 'off', 'weaker'],
      ['links.confirmOpen', 'off', 'always', 'stronger'],
    ]);
  });

  it('refuses unknown controls and levels', async () => {
    const { store: policy } = await store();
    expect(() => policy.set({ control: 'nope', level: 'off', confirmWeakening: true })).toThrow(new SecurityPolicyError('unknown-control'));
    expect(() => policy.set({ control: 'links.confirmOpen', level: 'sometimes', confirmWeakening: true }))
      .toThrow(new SecurityPolicyError('unknown-level'));
  });
});
