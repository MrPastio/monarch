import { describe, expect, it } from 'vitest';
import { dangerScaleExamples, plainDangerActionLabel, renderSecurityDangerScale } from '../../src/ui/public/modules/security-danger-scale.js';
import { dangerScaleForMode } from '../../src/core/agent-danger-assessment';

const escapeHtml = (value: string) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

describe('Security danger scale', () => {
  it('reads the Kernel thresholds: guard asks from 70%, strict from 50%', () => {
    expect(dangerScaleForMode('guard')).toEqual([
      { from: 0, to: 39, response: 'allow' }, { from: 40, to: 69, response: 'enhanced-readback' }, { from: 70, to: 100, response: 'confirm' },
    ]);
    expect(dangerScaleForMode('strict').find(segment => segment.response === 'confirm')?.from).toBe(50);
  });
  it('renders the bands and places recent actions on the scale', () => {
    const examples = dangerScaleExamples([
      { type: 'security.danger.assessed', capabilityId: 'workspace.files.delete', assessment: { dangerProbability: 85 } },
      { type: 'security.danger.receipt' },
    ]);
    expect(examples).toEqual([{ score: 85, label: 'Удаление' }]);
    const html = renderSecurityDangerScale(dangerScaleForMode('guard'), examples, escapeHtml);
    expect(html).toContain('спросит тебя от 70%');
    expect(html).toContain('left:85%');
    expect(plainDangerActionLabel('coder.command.run')).toBe('Команда');
  });
  it('folds repeated assessments of one action into a single mark and a count', () => {
    const examples = [38, 9, 38, 38, 85].map(score => ({ score, label: score === 85 ? 'Удаление' : 'Чтение' }));
    const html = renderSecurityDangerScale(dangerScaleForMode('guard'), examples, escapeHtml);
    expect(html.match(/class="danger-mark"/g)).toHaveLength(3);
    expect(html).toContain('<em>×3</em>');
    expect(html.match(/<li>/g)).toHaveLength(3);
  });
});

describe('plain action labels', () => {
  it('names a run capability as a command', async () => {
    const { plainDangerActionLabel } = await import('../../src/ui/public/modules/security-danger-scale.js');
    // The word boundary had become a literal backspace, so "run" never matched.
    expect(plainDangerActionLabel('system-shell.run')).toBe('Команда');
    expect(plainDangerActionLabel('coder.files.read')).toBe('Чтение');
  });
});
