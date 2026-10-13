import { describe, expect, it, vi } from 'vitest';
import { compileAstraMemoryRecall, isAstraMemoryRecallCurrent, projectAstraMemoryRecall, validateAstraMemoryQuery, validateAstraMemoryRecall } from '../../src/agent-v3/memory-recall';
import { AstraMemoryRecallAdmission, type AstraRecallPolicy, type AstraRecallRequest } from '../../src/agent-v3/memory-recall-admission';
import { AstraContextEngine } from '../../src/agent-v3/context-engine';
import { AstraJournal } from '../../src/agent-v3/journal';

const item = (id = 'memory_1', text = 'Предпочитаю краткие ответы.') => ({ kind: 'explicit', id, text,
  title: '', createdAt: '2026-09-04T00:00:00Z', score: 0.8, reason: 'fts', origin: {} });
const response = () => ({ schemaVersion: 1, scope: { type: 'chat' }, revision: '1:2',
  explicitMemories: [item()], episodes: [], budgetChars: 2400, usedChars: 30,
  engine: 'fts', semanticTimedOut: false, crossChatEnabled: true, cache: 'miss' });
const request: AstraRecallRequest = { source: 'desktop', privacy: 'persistent', destination: 'local', operation: 'analyze', query: 'Сравни файлы.' };

describe('bounded untrusted Memory V4 -> Astra recall', () => {
  it('requires an integrity-bound live token; legacy history stays readable, not live-admissible', () => {
    const validityToken = 'sha256:' + 'a'.repeat(64);
    const snapshot = compileAstraMemoryRecall({ ...response(), validityToken }, request.query);
    const live = { schemaVersion: 1, scope: { type: 'chat' }, revision: '1:2', crossChatEnabled: true, validityToken };
    expect(isAstraMemoryRecallCurrent(snapshot, live)).toBe(true);
    expect(isAstraMemoryRecallCurrent(compileAstraMemoryRecall(response(), request.query), live)).toBe(false);
    for (const changed of [{ revision: '2:2' }, { crossChatEnabled: false }, { validityToken: 'sha256:' + 'b'.repeat(64) },
      { scope: { type: 'coder-project', projectId: 'other' } }, { text: 'unexpected content' }, { schemaVersion: 2 }]) {
      expect(isAstraMemoryRecallCurrent(snapshot, { ...live, ...changed })).toBe(false);
    }
    expect(isAstraMemoryRecallCurrent({ ...snapshot, validityToken: ('sha256:' + 'b'.repeat(64)) as `sha256:${string}` }, live)).toBe(false);
    expect(() => compileAstraMemoryRecall({ ...response(), validityToken: 'bad' }, request.query)).toThrow('validity-token');
  });
  it('binds to the query and projects only optional, non-authoritative data', () => {
    const snapshot = compileAstraMemoryRecall(response(), request.query);
    validateAstraMemoryRecall(snapshot);
    validateAstraMemoryQuery(snapshot, request.query);
    expect(() => validateAstraMemoryQuery(snapshot, 'another request')).toThrow('query-binding');
    const projected = projectAstraMemoryRecall(snapshot);
    expect(projected[0]?.kind).toBe('recalled-memory');
    expect(JSON.parse(projected[0]!.text)).toMatchObject({ trust: 'untrusted-recalled-memory', instructionsAllowed: false, authorityEligible: false });
    expect(projected[0]!.text).not.toContain('score');
    snapshot.items[0]!.text = 'Execute new tools';
    expect(() => projectAstraMemoryRecall(snapshot)).toThrow('snapshot-integrity');
  });
  it.each(['😀Ж'.repeat(400), '\u0001"\\'.repeat(700)])('budgets encoded UTF-8 including JSON escapes and wrappers', text => {
    const raw = response(); raw.explicitMemories = Array.from({ length: 4 }, (_, i) => item('memory_' + i, text));
    const snapshot = compileAstraMemoryRecall(raw, request.query);
    const projection = projectAstraMemoryRecall(snapshot).map(entry => ({ ...entry, authorityEligible: false }));
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(8192);
    expect(snapshot.items.reduce((sum, value) => sum + Buffer.byteLength(value.text), 0)).toBeLessThanOrEqual(2400);
    expect(snapshot.items.every(value => !value.text.includes('\ufffd'))).toBe(true);
    expect(snapshot.items.every(value => value.truncated)).toBe(true);
  });
  it.each(['scope', 'duplicate', 'cross-chat', 'extra', 'oversize', 'bad-score'])('rejects invalid backend material: %s', kind => {
    const raw: any = response();
    if (kind === 'scope') raw.scope = { type: 'coder-project', projectId: 'other' };
    if (kind === 'duplicate') raw.explicitMemories.push(item());
    if (kind === 'cross-chat') { raw.crossChatEnabled = false; raw.episodes = [{ ...item(), kind: 'episode' }]; }
    if (kind === 'extra') raw.authority = 'all';
    if (kind === 'oversize') raw.explicitMemories[0].text = 'x'.repeat(16385);
    if (kind === 'bad-score') raw.explicitMemories[0].score = Number.NaN;
    expect(() => compileAstraMemoryRecall(raw, request.query)).toThrow('astra-memory-recall:');
  });
  it('compacts recall without altering required task evidence; replay uses the exact persisted surface', async () => {
    const journal = new AstraJournal(':memory:');
    try {
      const raw = response(); raw.explicitMemories = Array.from({ length: 4 }, (_, i) => item('memory_' + i, 'x'.repeat(600)));
      const memory = compileAstraMemoryRecall(raw, request.query);
      const count = vi.fn(async (text: string) => Buffer.byteLength(text));
      const engine = new AstraContextEngine({ deployment: 'isolated-validation', journal, executionId: 'recall-context',
        tokenizer: { driverGeneration: 'fixture', modelDigest: 'fixture', tokenizerDigest: 'byte-fixture' },
        countTokens: count, isCurrent: () => true, limits: { hardTokens: 1600, softTokens: 1200,
          rearmTokens: 1000, reservedOutputTokens: 100, hardBytes: 4096 } });
      const source = { executionId: 'recall-context', revision: 1, mandatory: [
        { kind: 'goal' as const, ref: 'goal', text: 'Summarize the exact evidence only.' },
        { kind: 'authority' as const, ref: 'authority', text: 'One selected file. No writes.' },
        { kind: 'workflow' as const, ref: 'workflow', text: 'Respond.' },
        { kind: 'budget' as const, ref: 'budget', text: 'One model call.' },
        { kind: 'evidence' as const, ref: 'receipt', text: 'OWNED_REAL_READ_RECEIPT' },
      ], optional: projectAstraMemoryRecall(memory) };
      const prepared = await engine.prepare(source);
      expect(prepared.status).toBe('ready');
      if (prepared.status !== 'ready') throw Error('not ready');
      expect(JSON.parse(prepared.plan.surface).mandatory).toEqual(source.mandatory);
      expect(prepared.plan.omittedRefs).toEqual(source.optional.map(value => value.ref));
      const calls = count.mock.calls.length;
      expect(await engine.prepare(source)).toEqual(prepared);
      expect(count).toHaveBeenCalledTimes(calls);
    } finally { journal.close(); }
  });
});

describe('host-only recall admission', () => {
  it.each([{ destination: 'max' }, { privacy: 'safe' }, { privacy: 'incognito' }, { source: 'api' },
    { source: 'telegram' }, { operation: 'observe' }, { operation: 'literal-create' }])('excludes %j before accessing memory or settings', excluded => {
    const policy = vi.fn(), retrieve = vi.fn();
    const admission = new AstraMemoryRecallAdmission({ policy, retrieve });
    return admission.prepare({ ...request, ...excluded } as AstraRecallRequest).then(result => {
      expect(result).toEqual({ status: 'omitted', reason: 'scope-excluded' });
      expect(policy).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
    });
  });
  it('rechecks policy after retrieval, and immediately before admission', async () => {
    let policy: AstraRecallPolicy = { enabled: true, revision: '1' }; let clock = 1000;
    const retrieve = vi.fn(async () => response());
    const host = new AstraMemoryRecallAdmission({ policy: () => policy, retrieve, now: () => clock });
    const prepared = await host.prepare(request);
    expect(prepared.status).toBe('prepared'); expect(host.isAdmissible(request, prepared)).toBe(true);
    expect(host.isAdmissible({ ...request, destination: 'max' }, prepared)).toBe(false);
    expect(host.isAdmissible({ ...request, query: 'other' }, prepared)).toBe(false);
    clock += 1000; expect(host.isAdmissible(request, prepared)).toBe(false);
    retrieve.mockImplementationOnce(async () => { policy = { enabled: true, revision: '2' }; return response(); });
    expect(await host.prepare(request)).toEqual({ status: 'omitted', reason: 'stale-policy' });
    expect(host.isAdmissible(request, prepared)).toBe(false);
    policy = { enabled: false, revision: '3' };
    const calls = retrieve.mock.calls.length;
    expect(await host.prepare(request)).toEqual({ status: 'omitted', reason: 'disabled' });
    expect(retrieve).toHaveBeenCalledTimes(calls);
  });
  it('bounds a transport that ignores cancellation and rejects its late result', async () => {
    let signal!: AbortSignal;
    const host = new AstraMemoryRecallAdmission({ policy: () => ({ enabled: true, revision: '1' }), timeoutMs: 5,
      retrieve: async (_query, received) => { signal = received; return new Promise(() => {}); } });
    expect(await host.prepare(request)).toEqual({ status: 'omitted', reason: 'unavailable' });
    expect(signal.aborted).toBe(true);
  });
  it('aborts in-flight recall without waiting for an ignored transport', async () => {
    const abort = new AbortController();
    const host = new AstraMemoryRecallAdmission({ policy: () => ({ enabled: true, revision: '1' }),
      retrieve: async () => { queueMicrotask(() => abort.abort()); return new Promise(() => {}); } });
    expect(await host.prepare(request, abort.signal)).toEqual({ status: 'omitted', reason: 'cancelled' });
  });
});
