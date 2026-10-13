import { describe, expect, it, vi } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraContextEngine, type AstraContextSource, type AstraContextLimits } from '../../src/agent-v3/context-engine';

const binding = { driverGeneration: 'synthetic-driver-1', modelDigest: 'synthetic-model', tokenizerDigest: 'synthetic-byte-vocabulary' };
const limits: AstraContextLimits = { hardTokens: 2400, softTokens: 1800, rearmTokens: 1400, reservedOutputTokens: 128,
  hardBytes: 4096, recentNarrativeItems: 1, minimumSavedTokens: 64, tokenizerTimeoutMs: 100 };
function source(revision = 1, historyItems = 0): AstraContextSource {
  return { executionId: 'context-test', revision,
    mandatory: [
      { ref: 'goal', kind: 'goal', text: 'Read only the exact synthetic file.' },
      { ref: 'authority', kind: 'authority', text: 'No external reads, effects, memory writes or inferred approval.' },
      { ref: 'workflow', kind: 'workflow', text: 'Active step: read.' },
      { ref: 'budget', kind: 'budget', text: 'One Kernel read.' },
    ], optional: Array.from({ length: historyItems }, (_, index) => ({ ref: 'history_' + index, kind: 'narrative', text: 'optional text '.repeat(50) })) };
}
function fixture(options: { count?: (surface: string, signal: AbortSignal) => Promise<number>; current?: () => boolean;
  overrides?: Partial<AstraContextLimits>; journal?: AstraJournal; generation?: string } = {}) {
  const journal = options.journal ?? new AstraJournal(':memory:');
  // Explicit TEST tokenizer: one token per UTF-8 byte, NOT an estimate for an LLM.
  // Production must provide its own exact driver tokenizer + full prompt framing.
  const count = vi.fn(options.count ?? (async (text: string) => Buffer.byteLength(text)));
  const engine = new AstraContextEngine({ deployment: 'isolated-validation', journal, executionId: 'context-test',
    tokenizer: { ...binding, driverGeneration: options.generation ?? binding.driverGeneration }, countTokens: count,
    isCurrent: options.current ?? (() => true), limits: { ...limits, ...options.overrides } });
  return { journal, count, engine };
}

describe('Astra V3 ContextPlan / mandatory budget / automatic compaction', () => {
  it('rejects a late compiler at the journal CAS without replacing a newer active projection', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const old = fixture({ count: async text => { await gate; return Buffer.byteLength(text); } });
    try {
      const late = old.engine.prepare(source(1));
      const newer = fixture({ journal: old.journal });
      const winner = await newer.engine.prepare(source(2));
      expect(winner.status).toBe('ready');
      release(); expect(await late).toEqual({ status: 'blocked', code: 'stale-source' });
      expect(old.engine.active()).toEqual(winner.status === 'ready' ? winner.plan : null);
    } finally { release(); old.journal.close(); }
  });
  it('counts the complete exact UTF-8 surface and replays its persisted plan without another tokenizer call', async () => {
    const f = fixture();
    try {
      const input = source(); input.optional.push({ ref: 'unicode', kind: 'narrative', text: 'Привет 🌟' });
      const one = await f.engine.prepare(input);
      expect(one.status).toBe('ready'); if (one.status !== 'ready') throw new Error('not ready');
      expect(one.plan.tokenCount).toBe(Buffer.byteLength(one.plan.surface));
      expect(one.plan.tokenCount).toBeGreaterThan(one.plan.surface.length);
      expect(f.count.mock.calls[0]![0]).toBe(one.plan.surface);
      expect(one.plan.compaction).toBeNull();
      expect(await f.engine.prepare(input)).toEqual(one); expect(f.count).toHaveBeenCalledTimes(1);
      one.plan.surface = 'mutated caller copy'; expect(f.engine.active()!.surface).not.toBe(one.plan.surface);
    } finally { f.journal.close(); }
  });

  it('automatically compacts only old optional narrative, preserves every mandatory item and keeps the recent raw tail', async () => {
    const f = fixture();
    try {
      const input = source(1, 5);
      input.mandatory.push({ ref: 'receipt', kind: 'receipt', text: 'exact receipt: 4103 bytes' });
      const result = await f.engine.prepare(input);
      expect(result.status).toBe('ready'); if (result.status !== 'ready') throw new Error('not ready');
      const surface = JSON.parse(result.plan.surface);
      expect(surface.mandatory).toEqual(input.mandatory);
      expect(result.plan.omittedRefs).toEqual(['history_0', 'history_1', 'history_2', 'history_3']);
      expect(result.plan.compaction).toMatchObject({ authorityEligible: false });
      expect(result.plan.compaction!.savedBytes).toBeGreaterThan(2000);
      expect(surface.data.at(-1)).toMatchObject({ ref: 'history_4', text: input.optional[4]!.text, authorityEligible: false });
      expect(surface.data[0]).toMatchObject({ kind: 'compaction-summary', authorityEligible: false });
      expect(input.optional).toHaveLength(5); // Raw source not deleted or rewritten.
      expect(result.plan.tokenCount + limits.reservedOutputTokens).toBeLessThanOrEqual(limits.hardTokens);
      expect(f.journal.history('context_context-test').map(event => (event.events[0] as any).type))
        .toEqual(['compaction.prepared', 'context.activated']);
    } finally { f.journal.close(); }
  });

  it('does not compact mandatory evidence or silently submit an oversized mandatory minimum', async () => {
    const f = fixture();
    try {
      const initial = await f.engine.prepare(source()); expect(initial.status).toBe('ready');
      const input = source(2); input.mandatory.push({ ref: 'proof', kind: 'evidence', text: 'e'.repeat(4000) });
      expect(await f.engine.prepare(input)).toEqual({ status: 'blocked', code: 'context-capacity-insufficient' });
      expect(f.engine.active()).toEqual(initial.status === 'ready' ? initial.plan : null);
    } finally { f.journal.close(); }
  });

  it('preserves old active projection after a failed activation and resumes the same durable bracket', async () => {
    const f = fixture();
    try {
      const first = await f.engine.prepare(source());
      const append = f.journal.append.bind(f.journal);
      const crash = vi.spyOn(f.journal, 'append').mockImplementation(commit => {
        if ((commit.events[0] as any).type === 'context.activated') throw new Error('synthetic-activation-crash');
        return append(commit);
      });
      await expect(f.engine.prepare(source(2, 5))).rejects.toThrow('synthetic-activation-crash');
      expect(f.engine.active()).toEqual(first.status === 'ready' ? first.plan : null);
      crash.mockRestore();
      const reconstructed = fixture({ journal: f.journal });
      const recovered = await reconstructed.engine.prepare(source(2, 5));
      expect(recovered.status).toBe('ready');
      expect(f.journal.history('context_context-test').filter(row => (row.events[0] as any).type === 'compaction.prepared')).toHaveLength(1);
    } finally { f.journal.close(); }
  });

  it('rejects stale source after tokenizer returns and leaves active context unchanged', async () => {
    let current = true;
    const f = fixture({ current: () => current, count: async text => { current = false; return Buffer.byteLength(text); } });
    try {
      expect(await f.engine.prepare(source())).toEqual({ status: 'blocked', code: 'stale-source' });
      expect(f.engine.active()).toBeNull();
    } finally { f.journal.close(); }
  });

  it('single-flights duplicate builds but refuses an unbounded queue of different sources', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ count: async text => { await gate; return Buffer.byteLength(text); } });
    try {
      const first = f.engine.prepare(source()), duplicate = f.engine.prepare(source());
      expect(await f.engine.prepare(source(2))).toEqual({ status: 'blocked', code: 'context-busy' });
      release(); expect(await duplicate).toEqual(await first); expect(f.count).toHaveBeenCalledTimes(1);
    } finally { release(); f.journal.close(); }
  });

  it('does not trust a cached token count across a new driver generation or smaller capacity', async () => {
    const f = fixture();
    try {
      expect((await f.engine.prepare(source())).status).toBe('ready');
      const newDriver = fixture({ journal: f.journal, generation: 'synthetic-driver-2', count: async () => 3000 });
      expect(await newDriver.engine.prepare(source())).toEqual({ status: 'blocked', code: 'context-capacity-insufficient' });
      expect(newDriver.count).toHaveBeenCalledTimes(1);
      const smaller = fixture({ journal: f.journal, overrides: { hardTokens: 400, softTokens: 300, rearmTokens: 200, reservedOutputTokens: 64 } });
      expect(await smaller.engine.prepare(source())).toEqual({ status: 'blocked', code: 'context-capacity-insufficient' });
    } finally { f.journal.close(); }
  });

  it('uses hysteresis for soft pressure and rearms only after a low-pressure revision', async () => {
    let raw = 1900;
    const f = fixture({ count: async text => text.includes('compaction-summary') ? 1600 : raw, overrides: { hardBytes: 8192 } });
    try {
      const first = await f.engine.prepare(source(1, 5));
      expect(first.status === 'ready' && first.plan.compaction).toBeTruthy();
      const second = await f.engine.prepare(source(2, 5));
      expect(second.status === 'ready' && second.plan.compaction).toBeNull();
      raw = 1000; expect((await f.engine.prepare(source(3))).status).toBe('ready');
      raw = 1900; const fourth = await f.engine.prepare(source(4, 5));
      expect(fourth.status === 'ready' && fourth.plan.compaction).toBeTruthy();
    } finally { f.journal.close(); }
  });

  it('bounds failed compaction attempts per source/driver/limits binding', async () => {
    const f = fixture({ count: async text => text.includes('compaction-summary') ? 2570 : 2600 });
    try {
      expect(await f.engine.prepare(source(1, 5))).toEqual({ status: 'blocked', code: 'compaction-failed' });
      expect(await f.engine.prepare(source(1, 5))).toEqual({ status: 'blocked', code: 'context-capacity-insufficient' });
      expect(f.count.mock.calls.filter(call => call[0].includes('compaction-summary'))).toHaveLength(1);
      expect(f.engine.active()).toBeNull();
    } finally { f.journal.close(); }
  });

  it.each([NaN, -1, 1.5])('rejects invalid tokenizer count %s', async value => {
    const f = fixture({ count: async () => value });
    try { expect(await f.engine.prepare(source())).toEqual({ status: 'blocked', code: 'tokenizer-unavailable' }); }
    finally { f.journal.close(); }
  });

  it('bounds a hanging tokenizer and aborts its port instead of calling a model', async () => {
    let signal!: AbortSignal;
    const f = fixture({ count: async (_text, received) => { signal = received; return new Promise<number>(() => {}); }, overrides: { tokenizerTimeoutMs: 10 } });
    try {
      expect(await f.engine.prepare(source())).toEqual({ status: 'blocked', code: 'tokenizer-unavailable' });
      expect(signal.aborted).toBe(true); expect(f.engine.active()).toBeNull();
    } finally { f.journal.close(); }
  });

  it('enforces memory UTF-8 projection budget and never treats recalled text as authority', async () => {
    const f = fixture();
    try {
      const input = source(); input.optional = [{ ref: 'memory', kind: 'recalled-memory', text: 'recalled synthetic fact' }];
      const result = await f.engine.prepare(input);
      expect(result.status === 'ready' && JSON.parse(result.plan.surface).data[0].authorityEligible).toBe(false);
      const tooLarge = source(2); tooLarge.optional = [{ ref: 'memory', kind: 'recalled-memory', text: '🌟'.repeat(1024) }];
      expect(() => f.engine.prepare(tooLarge)).toThrow('memory-byte-budget');
    } finally { f.journal.close(); }
  });

  it('rejects revision reuse with changed content and missing mandatory sections', async () => {
    const f = fixture();
    try {
      await f.engine.prepare(source());
      const changed = source(); changed.mandatory[0]!.text = 'different goal';
      expect(await f.engine.prepare(changed)).toEqual({ status: 'blocked', code: 'stale-source' });
      const missing = source(2); missing.mandatory = missing.mandatory.filter(item => item.kind !== 'authority');
      expect(() => f.engine.prepare(missing)).toThrow('mandatory-minimum');
    } finally { f.journal.close(); }
  });

  it('evicts optional recall under hard pressure while preserving mandatory evidence and the recent tail', async () => {
    const f = fixture();
    try {
      const input = source(1, 4);
      input.mandatory.push({ kind: 'evidence', ref: 'required_read', text: 'Exact retained file evidence.' });
      input.optional.push({ kind: 'recalled-memory', ref: 'optional_memory', text: 'м'.repeat(1400) });
      const result = await f.engine.prepare(input);
      expect(result.status).toBe('ready'); if (result.status !== 'ready') throw Error('not ready');
      const surface = JSON.parse(result.plan.surface);
      expect(surface.mandatory).toEqual(input.mandatory);
      expect(surface.data.at(-1)).toMatchObject({ ref: 'history_3', authorityEligible: false });
      expect(result.plan.omittedRefs).toEqual(['history_0', 'history_1', 'history_2', 'optional_memory']);
      expect(f.count).toHaveBeenCalledTimes(3);
      expect(await f.engine.prepare(input)).toEqual(result);
      expect(f.count).toHaveBeenCalledTimes(3);
    } finally { f.journal.close(); }
  });

  it('can discard only optional recall and never silently shorten an oversized mandatory source', async () => {
    const f = fixture();
    try {
      const input = source(); input.optional.push({ kind: 'recalled-memory', ref: 'recall', text: 'r'.repeat(2900) });
      const ready = await f.engine.prepare(input);
      expect(ready.status === 'ready' && ready.plan.omittedRefs).toEqual(['recall']);
      expect(f.count).toHaveBeenCalledTimes(2);
      const oversized = source(2); oversized.mandatory[0]!.text = 'g'.repeat(2800);
      oversized.optional = input.optional;
      expect(await f.engine.prepare(oversized)).toEqual({ status: 'blocked', code: 'context-capacity-insufficient' });
      expect(f.engine.active()).toEqual(ready.status === 'ready' ? ready.plan : null);
    } finally { f.journal.close(); }
  });
});
