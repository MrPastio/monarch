import { describe, expect, it, vi } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraComputerSelectionStore, type AstraWindowChoice } from '../../src/app/astra-computer-selection-store';
import { AstraComputerPicker } from '../../src/app/astra-computer-picker';
import type { MonarchKernel } from '../../src/core/kernel';
// @ts-expect-error Standalone native Electron adapter, not a browser component.
import { createAstraComputerDialog } from '../../desktop/electron/astra-computer-dialog.mjs';

const actor = { id: 'sha256:' + 'd'.repeat(64), source: 'desktop' as const };
const principal = { actor, conversationId: 'conversation' };
const window: AstraWindowChoice = { windowRef: 'hwnd:00000000000000AA', processId: 42,
  processInstanceId: 'process:' + '4'.repeat(64), processName: 'Synthetic', title: 'Selected QA window' };
const input = { ...principal, requestId: 'request', window, ttlMs: 60000, timeoutMs: 1000 };
const context = { ...principal, inputMessageId: 'message', text: 'Observe chosen window' };
function setup(maxSelections = 2) {
  const journal = new AstraJournal(':memory:'); let now = Date.now();
  const options = { deployment: 'isolated-validation' as const, journal, scopeId: 'windows', maxSelections, now: () => now };
  const store = new AstraComputerSelectionStore(options);
  return { journal, store, options, advance: (ms: number) => { now += ms; } };
}
describe('durable host-issued Computer window choices; no native OS access', () => {
  it('replays exact issuance and preserves expiry across a new store, without leaking native handles in descriptors', () => {
    const s = setup();
    try {
      const selected = s.store.issue(input, () => true), capacity = s.journal.capacity();
      expect(selected).not.toHaveProperty('windowRef'); expect(selected).not.toHaveProperty('processId');
      expect(s.store.issue(input, () => true)).toEqual(selected); expect(s.journal.capacity()).toEqual(capacity);
      const next = new AstraComputerSelectionStore(s.options); expect(next.list(principal)).toEqual([selected]);
      const value = next.resolve(selected.selectionId, context); value.title = 'mutated';
      expect(next.resolve(selected.selectionId, context).title).toBe(window.title);
      s.advance(60000); expect(next.list(principal)).toEqual([]);
      expect(() => next.issue(input, () => true)).toThrow('unavailable');
      expect(() => new AstraComputerSelectionStore(s.options).resolve(selected.selectionId, context)).toThrow('unavailable');
    } finally { s.journal.close(); }
  });
  it('keeps reserved revoke capacity at the cohort limit and durable denial even when notification fails', () => {
    const s = setup(1), notification = vi.fn(() => { throw Error('notification-failed'); });
    const store = new AstraComputerSelectionStore({ ...s.options, onRevoked: notification });
    try {
      const picked = store.issue(input, () => true);
      expect(() => store.issue({ ...input, requestId: 'second' }, () => true)).toThrow('cohort-capacity');
      expect(() => store.revoke(picked.selectionId, principal)).toThrow('notification-failed');
      expect(() => store.resolve(picked.selectionId, context)).toThrow('unavailable');
      const before = s.journal.read(picked.selectionId); expect(() => store.revoke(picked.selectionId, principal)).toThrow('notification-failed');
      expect(s.journal.read(picked.selectionId)).toEqual(before); expect(notification).toHaveBeenCalledTimes(2);
      expect(new AstraComputerSelectionStore(s.options).list(principal)).toEqual([]);
    } finally { s.journal.close(); }
  });
  it('rolls issuance and index back when the caller fence fails at SQLite commit', () => {
    const s = setup(); let guards = 0;
    try { const before = s.journal.capacity();
      expect(() => s.store.issue(input, () => ++guards < 3)).toThrow(); // initial + transaction entry pass; final fence fails.
      expect(s.journal.capacity()).toEqual(before); expect(s.store.list(principal)).toEqual([]);
      expect(s.store.findIssued(input.requestId, principal)).toBeNull();
    } finally { s.journal.close(); }
  });
  it.each(['actor', 'conversation', 'source'] as const)('does not expose or revoke another %s selection', kind => {
    const s = setup();
    try {
      const selected = s.store.issue(input, () => true), other = kind === 'actor' ? { ...context, actor: { ...actor, id: 'sha256:' + 'e'.repeat(64) } }
        : kind === 'conversation' ? { ...context, conversationId: 'other' } : { ...context, actor: { ...actor, source: 'api' as const } };
      expect(() => s.store.resolve(selected.selectionId, other)).toThrow(); expect(() => s.store.revoke(selected.selectionId, other)).toThrow();
      expect(s.store.resolve(selected.selectionId, context).windowRef).toBe(window.windowRef);
    } finally { s.journal.close(); }
  });
  it.each([{ ...window, processId: 0 }, { ...window, windowRef: 'hwnd:aa' }, { ...window, title: '' }, { ...window, inputPermission: true }])('rejects invalid or widened host choice', choice => {
    const s = setup();
    try { expect(() => s.store.issue({ ...input, window: choice }, () => true)).toThrow(); expect(s.store.list(principal)).toEqual([]); }
    finally { s.journal.close(); }
  });
});

function pickerSetup() {
  const s = setup(), source = { ...principal, epoch: 'page_1' };
  // Unit port only. The separate computer-observe suite uses the real Kernel/Computer module.
  const execute = vi.fn(async () => ({ proposal: { canonicalHash: 'same' }, result: { ok: true,
    output: { verified: true, observedAt: new Date().toISOString(), windows: [window] } } }));
  const kernel = { prepareActionProposal: vi.fn(() => ({ canonicalHash: 'same' })), executeActionProposal: execute } as unknown as MonarchKernel;
  const choose = vi.fn(async (_windows: readonly AstraWindowChoice[], _signal: AbortSignal): Promise<number | null> => 0);
  const picker = new AstraComputerPicker({ deployment: 'isolated-validation', store: s.store, kernel, currentSource: () => source, choose });
  return { ...s, source, execute, choose, picker, close: () => { picker.dispose(); s.journal.close(); } };
}
describe('host picker source fence and cancellation; synthetic Kernel port', () => {
  it('deduplicates a pending chooser and never issues after the source epoch changes', async () => {
    const s = pickerSetup(); let release!: (value: number) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    s.choose.mockImplementation(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    try {
      const one = s.picker.pick({ version: 1, requestId: 'pick' }, () => {}), two = s.picker.pick({ version: 1, requestId: 'pick' }, () => {});
      const checkedOne = expect(one).rejects.toThrow('source-changed'), checkedTwo = expect(two).rejects.toThrow('source-changed');
      await started; await expect(s.picker.pick({ version: 1, requestId: 'other' }, () => {})).rejects.toThrow('busy');
      s.source.epoch = 'page_2'; release(0); await checkedOne; await checkedTwo;
      expect(s.choose).toHaveBeenCalledTimes(1); expect(s.execute).toHaveBeenCalledTimes(1); expect(s.store.list(principal)).toEqual([]);
    } finally { s.close(); }
  });
  it('cancels the owned dialog on dispose and cannot issue from its late selected reply', async () => {
    const s = pickerSetup(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    s.choose.mockImplementation((_windows, signal) => new Promise(resolve => { entered(); signal.addEventListener('abort', () => resolve(0), { once: true }); }));
    try { const pending = s.picker.pick({ version: 1, requestId: 'pick' }, () => {}); const denied = expect(pending).rejects.toThrow('source-changed');
      await started; s.picker.dispose(); await denied; expect(s.store.list(principal)).toEqual([]);
    } finally { s.close(); }
  });
  it('makes no selection on cancel/empty result and rejects renderer window or actor fields before Kernel', async () => {
    const s = pickerSetup();
    try {
      await expect(s.picker.pick({ version: 1, requestId: 'pick', windowRef: window.windowRef }, () => {})).rejects.toThrow('request');
      await expect(s.picker.pick({ version: 1, requestId: 'pick', actor }, () => {})).rejects.toThrow('request');
      expect(s.execute).not.toHaveBeenCalled(); s.choose.mockResolvedValue(null);
      expect(await s.picker.pick({ version: 1, requestId: 'pick' }, () => {})).toEqual({ status: 'cancelled' });
      s.execute.mockImplementation(async () => ({ proposal: { canonicalHash: 'same' }, result: { ok: true, output: { verified: true, observedAt: new Date().toISOString(), windows: [] } } }));
      expect(await s.picker.pick({ version: 1, requestId: 'empty' }, () => {})).toEqual({ status: 'empty' });
      expect(s.store.list(principal)).toEqual([]); expect(s.choose).toHaveBeenCalledTimes(1);
    } finally { s.close(); }
  });
});

describe('native dialog presentation contract, controlled Electron dialog not live OS UI', () => {
  it('defaults to cancel, pages exact candidates and renders window metadata as plain text only', async () => {
    const signal = new AbortController().signal, showMessageBox = vi.fn().mockResolvedValueOnce({ response: 2 }).mockResolvedValueOnce({ response: 0 });
    const choose = createAstraComputerDialog({ deployment: 'isolated-validation', window: {}, dialog: { showMessageBox }, assertWindow: () => {} });
    expect(await choose([window, { ...window, title: '<script>untrusted</script>\u202e', windowRef: 'hwnd:00000000000000BB' }], signal)).toBe(1);
    expect(showMessageBox.mock.calls[0]![1]).toMatchObject({ defaultId: 1, cancelId: 1, signal });
    expect(showMessageBox.mock.calls[1]![1].detail).toContain('<script>untrusted</script>');
    expect(showMessageBox.mock.calls[1]![1].detail).not.toContain('\u202e');
    expect(showMessageBox.mock.calls[1]![1].detail).toContain('hwnd:00000000000000BB');
  });
  it('does not select after cancellation or closed renderer', async () => {
    const controller = new AbortController(), showMessageBox = vi.fn(async () => ({ response: 0 }));
    const choose = createAstraComputerDialog({ deployment: 'isolated-validation', window: {}, dialog: { showMessageBox }, assertWindow: () => {} });
    controller.abort(); expect(await choose([window], controller.signal)).toBeNull(); expect(showMessageBox).not.toHaveBeenCalled();
    const closed = createAstraComputerDialog({ deployment: 'isolated-validation', window: {}, dialog: { showMessageBox }, assertWindow: () => { throw Error('closed'); } });
    await expect(closed([window], new AbortController().signal)).rejects.toThrow('closed');
  });
});
