import { describe, expect, it } from 'vitest';
import { oscarAstraNativeRequest } from '../../src/ui/public/modules/oscar-astra-native.js';

const identity = { clientRequestId: 'request', inputMessageId: 'message' };
const target = { key: 'output', selectionId: 'destination', targetId: 'result', label: 'result.txt', access: 'exclusive-create' };
const source = { key: 'input', selectionId: 'source', targetId: 'notes', label: 'notes.txt', access: 'observe' };
const selection = { conversationId: 'conversation', target, localAnalysis: true, referenceInputs: true, mode: 'draft' };

describe('ordinary composer Astra creation request', () => {
  it('carries an explicit MAX choice through selected-file draft and analysis requests', () => {
    const max = { modelChoice: 'qwen-3.8-27b', previewAcknowledged: true };
    expect(oscarAstraNativeRequest(selection, 'Напиши отчёт', identity, max).astra.goal.content)
      .toMatchObject({ kind: 'draft', modelMode: 'max', ...max });
    expect(oscarAstraNativeRequest({ ...selection, target: source, mode: 'analyze' }, 'Объясни', identity, max).astra.goal)
      .toMatchObject({ kind: 'analyze', modelMode: 'max', ...max });
  });
  it('reaches the existing local draft route rather than always requesting manual text', () => {
    expect(oscarAstraNativeRequest(selection, 'Напиши отчёт', identity).astra.goal)
      .toEqual({ kind: 'create', target: 'result', content: { kind: 'draft' } });
  });
  it('keeps host-selected sources distinct from the destination', () => {
    const request = oscarAstraNativeRequest({ ...selection, references: [source] }, 'Составь резюме', identity);
    expect(request.astra).toEqual({ selectionId: 'destination', goal: { kind: 'create', target: 'result',
      content: { kind: 'draft', references: [{ selectionId: 'source', target: 'notes' }] } } });
    expect(JSON.stringify(request)).not.toContain('notes.txt');
    expect(JSON.stringify(request)).not.toContain('modelMode');
  });
  it('retains an explicit manual-content choice and does not silently choose cloud', () => {
    expect(oscarAstraNativeRequest({ ...selection, mode: 'reply' }, 'Создай файл', identity).astra.goal.content.kind).toBe('reply');
    expect(oscarAstraNativeRequest({ ...selection, localAnalysis: false }, 'Создай файл', identity).astra.goal.content.kind).toBe('reply');
  });
  it.each([{ referenceInputs: false }, { mode: 'reply' }, { localAnalysis: false }])(
    'does not silently discard references in an unsupported mode: %j', override => {
      expect(() => oscarAstraNativeRequest({ ...selection, references: [source], ...override }, 'Составь резюме', identity)).toThrow();
    });
});
