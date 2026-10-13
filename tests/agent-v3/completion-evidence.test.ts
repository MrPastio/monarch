import { describe, expect, it } from 'vitest';
import { astraCompletionEvidence } from '../../src/app/astra-task-facade';

// Live on installed 0.3.0.82: two artifacts.write calls failed with
// filesystem-policy-blocked, the model completed citing them, and the turn was
// shown as "Выполнение подтверждено". The outcome must follow the receipts.
describe('agent completion evidence', () => {
  const receipts = [{ ref: 'receipt_1', ok: false }, { ref: 'receipt_2', ok: true }, { ref: 'receipt_3', ok: false }];
  it('confirms only when every cited action succeeded', () => {
    expect(astraCompletionEvidence({ evidenceRefs: ['receipt_2'], receipts })).toBe('succeeded');
  });
  it('treats a completion that cites only failures as failed', () => {
    expect(astraCompletionEvidence({ evidenceRefs: ['receipt_1', 'receipt_3'], receipts })).toBe('failed');
  });
  it('treats mixed cited receipts as partial evidence', () => {
    expect(astraCompletionEvidence({ evidenceRefs: ['receipt_1', 'receipt_2'], receipts })).toBe('mixed');
  });
  it('treats a completion citing no action as a plain answer', () => {
    expect(astraCompletionEvidence({ evidenceRefs: [], receipts })).toBe('none');
    expect(astraCompletionEvidence({ evidenceRefs: [], receipts: [] })).toBe('none');
  });
});
