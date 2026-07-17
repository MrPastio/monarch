import { describe, expect, it } from 'vitest';
import {
  COMMUNICATION_PRESETS,
  filterVisibleSkills,
  formatPairingTime,
  normalizeSettingsTab,
  splitSettingsLines,
  unwrapCapabilityPayload,
} from '../../src/ui/public/modules/settings-pane.js';

describe('Monarch Control UI helpers', () => {
  it('normalizes editable style rules', () => {
    expect(splitSettingsLines('  На ты.\n\n Сначала результат.  ')).toEqual([
      'На ты.',
      'Сначала результат.',
    ]);
    expect(Object.keys(COMMUNICATION_PRESETS)).toEqual(['balanced', 'concise', 'warm', 'technical']);
  });

  it('reads direct API execution results and formats pairing expiry', () => {
    const result = { ok: true, output: { pairingCode: '123456' } };
    expect(unwrapCapabilityPayload({ ok: true, result })).toBe(result);
    expect(formatPairingTime('2030-01-01T00:10:00.000Z', Date.parse('2030-01-01T00:00:00.000Z')))
      .toBe('Действует ещё 10 мин');
    expect(formatPairingTime('2030-01-01T00:00:00.000Z', Date.parse('2030-01-01T00:01:00.000Z')))
      .toBe('Код истёк');
  });

  it('filters skills and keeps workspace workflows first', () => {
    const skills = [
      { name: 'system-docs', displayName: 'System Docs', scope: 'system', provider: 'codex' },
      { name: 'file-guardian', displayName: 'File Guardian', scope: 'project', provider: 'monarch' },
      { name: 'user-file', displayName: 'User File', scope: 'user', provider: 'gemini' },
    ];
    expect(filterVisibleSkills(skills, '').map((skill) => skill.name)).toEqual([
      'file-guardian',
      'user-file',
      'system-docs',
    ]);
    expect(filterVisibleSkills(skills, 'gemini')).toEqual([skills[2]]);
  });

  it('normalizes settings tabs', () => {
    expect(normalizeSettingsTab('telegram')).toBe('telegram');
    expect(normalizeSettingsTab('unknown')).toBe('general');
  });
});
