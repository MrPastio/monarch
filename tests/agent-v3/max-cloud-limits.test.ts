import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maxCloudAgentContextTokens, maxCloudContextTokens, maxCloudOmitOutputLimit, maxCloudInputBytes, maxCloudOutputTokens, setMaxCloudLimitChoice } from '../../src/agent-v3/max-cloud-limits';
import { maxNativeChatOutputTokens } from '../../src/agent-v3/max-native-contract';
import { LocalModelPreferenceStore } from '../../src/settings/model-preference';

const OPENROUTER = 'max-cloud:openrouter:anthropic/claude-sonnet-4.5';
const DEEPSEEK = 'max-cloud:deepseek:deepseek-chat';

afterEach(() => setMaxCloudLimitChoice({}));

describe('cloud MAX limits are the person\'s settings', () => {
  it('automatic values are larger than the old fixed 8192, except where the API forbids it', () => {
    expect(maxCloudOutputTokens(OPENROUTER)).toBe(32_768);
    expect(maxCloudOutputTokens(DEEPSEEK)).toBe(8192);
    expect(maxCloudContextTokens()).toBe(131_072);
    expect(maxNativeChatOutputTokens(OPENROUTER as never)).toBe(32_768);
  });

  it('a chosen value wins, and an answer never exceeds half the window', () => {
    setMaxCloudLimitChoice({ outputTokens: 65_536, contextTokens: 262_144 });
    expect(maxCloudOutputTokens(DEEPSEEK)).toBe(65_536);
    expect(maxCloudInputBytes()).toBe(262_144);
    setMaxCloudLimitChoice({ outputTokens: 65_536, contextTokens: 65_536 });
    expect(maxCloudOutputTokens(OPENROUTER)).toBe(32_768);
  });

  it('«не ограничено» omits the limit only where the service defaults to the model maximum', () => {
    setMaxCloudLimitChoice({ outputTokens: 0 });
    expect(maxCloudOutputTokens(OPENROUTER)).toBe(65_536);
    expect(maxCloudOmitOutputLimit('openrouter')).toBe(true);
    expect(maxCloudOmitOutputLimit('deepseek')).toBe(false);
    setMaxCloudLimitChoice({ outputTokens: 32_768 });
    expect(maxCloudOmitOutputLimit('openrouter')).toBe(false);
  });

  it('an agent never declares a window its 512 KiB surface cannot fill', () => {
    setMaxCloudLimitChoice({ contextTokens: 1_000_000, outputTokens: 0 });
    expect(maxCloudContextTokens()).toBe(1_000_000);
    expect(maxCloudAgentContextTokens()).toBe(262_144);
    expect(2 * maxCloudAgentContextTokens()).toBeLessThanOrEqual(524_288);
    expect(maxCloudOutputTokens(OPENROUTER)).toBeLessThanOrEqual(maxCloudAgentContextTokens() / 2);
  });

  it('ignores values that were not offered', () => {
    setMaxCloudLimitChoice({ outputTokens: 12_345, contextTokens: 7 });
    expect(maxCloudOutputTokens(OPENROUTER)).toBe(32_768);
    expect(maxCloudContextTokens()).toBe(131_072);
  });
});

describe('model preference stores the limits', () => {
  it('saves, applies and resets to automatic', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'monarch-pref-'));
    try {
      const store = new LocalModelPreferenceStore(root);
      expect(store.snapshot()).toMatchObject({ maxOutputTokens: null, maxContextTokens: null });
      store.update({ maxOutputTokens: 16_384, maxContextTokens: 262_144 });
      expect(maxCloudOutputTokens(OPENROUTER)).toBe(16_384);
      expect(new LocalModelPreferenceStore(root).snapshot()).toMatchObject({ maxOutputTokens: 16_384, maxContextTokens: 262_144 });
      expect(() => store.update({ maxOutputTokens: 999 })).toThrow('model-preference-output');
      store.update({ maxOutputTokens: 0 });
      expect(new LocalModelPreferenceStore(root).snapshot().maxOutputTokens).toBe(0);
      store.update({ maxOutputTokens: null });
      expect(maxCloudOutputTokens(OPENROUTER)).toBe(32_768);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
