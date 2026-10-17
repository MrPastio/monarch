import { describe, expect, it } from 'vitest';
import { renderOscarMemoryNote } from '../../src/ui/public/modules/utils.js';

describe('«Запомнил сам» under an answer', () => {
  it('offers to open and to undo what Oscar learned by itself', () => {
    const html = renderOscarMemoryNote({ action: 'learned', recordId: 'record_9', text: 'Я живу в Бургасе' });
    expect(html).toContain('Запомнил сам:');
    expect(html).toContain('data-source-open-memory="record_9"');
    expect(html).toContain('data-memory-undo="record_9"');
  });

  it('keeps explicit «запомни» without an undo and says what came back', () => {
    expect(renderOscarMemoryNote({ action: 'created', recordId: 'r', text: 'x' })).not.toContain('data-memory-undo');
    const undone = renderOscarMemoryNote({ action: 'undone', recordId: 'r', text: 'Я живу в Софии', replacedText: 'Я живу в Варне' });
    expect(undone).toContain('Отменил:');
    expect(undone).toContain('помню прежнее «Я живу в Варне»');
    expect(undone).not.toContain('<button');
  });
});
