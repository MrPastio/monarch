import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { AstraMaxHostService } from '../../src/agent-v3/max-host-service';
import type { AstraMaxSettingsStore } from '../../src/agent-v3/max-settings-store';
import { completeMaxNative, restoreDoubleEscapedLineBreaks, streamMaxNative } from '../../src/agent-v3/max-native-completion';
import { requestMaxNative, streamMaxNativeAnswer } from '../../src/agent-v3/max-native-client';
import { ASTRA_MAX_PROVIDER_AGREEMENT_VERSION } from '../../src/agent-v3/max-provider-contract';
import { startAstraMaxNativeServer } from '../../desktop/electron/astra-max-native-server.mjs';
import { completeWithModelRole } from '../../src/modules/models/runtime-client';
import type { MonarchModelCatalog } from '../../src/modules/models/model-catalog';
import { maxOscarAnswerStream } from '../../src/app/oscar-turn-runtime';
import { InMemoryOscarTurnStore, OscarTurnCoordinator } from '../../src/oscar-turn';

const consent = { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, providerId: 'groq' as const,
  acceptedAt: '2026-09-07T00:00:00.000Z', nonLocalProcessingAcknowledged: true as const,
  selectedContextAcknowledged: true as const, providerTermsAcknowledged: true as const };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
const completion = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }),
  { headers: { 'Content-Type': 'application/json' } });

async function fixture(options: { block?: boolean; primary?: unknown } = {}) {
  const calls: Record<string, any>[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    return completion(body.model === 'openai/gpt-oss-safeguard-20b'
      ? { decision: options.block ? 'block' : 'allow', reasonCode: 'fixture', summary: 'synthetic' }
      : options.primary ?? { text: 'Привет из MAX' });
  });
  const settings = { resolveConnection: async () => ({ apiKey: 'gsk_synthetic_no_real_key_123456789', consent }) } as AstraMaxSettingsStore;
  const host = new AstraMaxHostService({ deployment: 'native-desktop', settings, fetch: fetchFn as typeof fetch,
    now: () => Date.parse('2026-09-07T10:00:00Z') });
  const server = await startAstraMaxNativeServer({ complete: (input: unknown, signal: AbortSignal) => completeMaxNative(host, input, signal),
    stream: (input: unknown, signal: AbortSignal) => streamMaxNative(host, input, signal) });
  cleanup.push(server.close);
  const env = { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken };
  return { env, server, host, calls, fetchFn };
}

describe('native MAX full host/transport/provider path with synthetic Groq', () => {
  it.each([false, true])('keeps follow-up history and original failure without fallback (provider fails: %s)', async fails => {
    const { env, calls, fetchFn } = await fixture();
    const fallback = vi.fn(async () => { throw Error('must-not-retry'); });
    const coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(),
      volatileStore: new InMemoryOscarTurnStore(),
      answerExecutor: async execution => maxOscarAnswerStream(execution, env),
      answerFallback: fallback, persistMessage: async () => {} });
    await coordinator.start();
    try {
      const first = await coordinator.submit({ clientRequestId: 'max_first', conversationId: 'max_followup',
        privacyMode: 'persistent', source: 'desktop', text: 'что ты умеешь?', modifiers: { requestedModel: 'max-gpt-oss-120b' } });
      await vi.waitFor(async () => expect((await coordinator.getTurn(first.turn.id))?.turn.status).toBe('succeeded'));
      const history = [{ role: 'user' as const, content: 'что ты умеешь?' },
        { role: 'assistant' as const, content: 'Привет из MAX' }];
      if (fails) fetchFn.mockImplementation(async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 429 });
      });
      const second = await coordinator.submit({ clientRequestId: 'max_second', conversationId: 'max_followup',
        privacyMode: 'persistent', source: 'desktop', text: 'Распиши это детально?', history,
        modifiers: { requestedModel: 'max-gpt-oss-120b' } });
      await vi.waitFor(async () => expect((await coordinator.getTurn(second.turn.id))?.turn.status).toBe(fails ? 'failed' : 'succeeded'));
      expect(fallback).not.toHaveBeenCalled();
      if (fails) {
        const outcome = (await coordinator.getTurn(second.turn.id))!.turn.outcome!;
        expect(outcome.diagnostic?.detail).toContain('rate-limit');
        expect(outcome.summary).toContain('закончился лимит');
        expect(calls).toHaveLength(4);
      } else {
        expect(calls).toHaveLength(6);
        expect(calls[4]!.messages.slice(-3)).toEqual([history[0],
          { role: 'assistant', content: JSON.stringify({ text: history[1]!.content }) }, { role: 'user', content: 'Распиши это детально?' }]);
      }
    } finally { await coordinator.stop(); }
  });
  it('consumes bootstrap authority without passing it to tool child environments', async () => {
    const { env } = await fixture();
    const script = `import { requestMaxNative } from './src/agent-v3/max-native-client.ts';
      if (process.env.MONARCH_MAX_NATIVE_TOKEN || process.env.MONARCH_MAX_NATIVE_ENDPOINT) throw Error('capability-not-consumed');
      const result = await requestMaxNative({role:'max-gpt-oss-120b',messages:[{role:'user',content:'synthetic'}]});
      console.log(JSON.stringify({ok:result.text==='Привет из MAX',scrubbed:true}));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: process.cwd(), env: { ...process.env, ...env, TSX_DISABLE_CACHE: '1' }, timeout: 15000, windowsHide: true });
    expect(JSON.parse(stdout.trim())).toEqual({ ok: true, scrubbed: true });
  });
  it('ordinary Oscar answer delivers the real MAX transport result with no memory lookup', async () => {
    const { env, calls } = await fixture();
      const events = [];
      for await (const event of maxOscarAnswerStream({ turn: { id: 'turn', request: {
        text: 'Привет', modifiers: { requestedModel: 'max-gpt-oss-120b' }, history: [],
        personality: { secret: 'PRIVATE_PERSONALITY_SENTINEL' },
      } }, attachments: [], signal: new AbortController().signal } as any, env)) events.push(event);
      expect(events[0]).toEqual({ type: 'token', token: 'Привет из MAX' });
      expect(events[1]).toMatchObject({ type: 'done', usage: { provider: 'groq-max',
        model_tier: 'max-gpt-oss-120b', max_new_tokens: 65_536, generation_stop_reason: 'stop',
        likely_truncated: false, completion_state: 'complete' } });
      expect(JSON.stringify(calls)).not.toContain('PRIVATE_PERSONALITY_SENTINEL');
      expect(calls[1]?.max_completion_tokens).toBe(65_536);
      expect(calls[1]?.messages[0]?.content).toContain('concise conclusion or next step');
      expect(calls[1]?.messages[1]?.content).toContain('короткий итог или следующий шаг');
  });
  it('adds recalled memory as untrusted data only when a recall port is given', async () => {
    const { env, calls } = await fixture();
    const recall = vi.fn(async () => ({ explicitMemories: [{ kind: 'explicit', text: 'Владелец любит  чай MEMORY_SENTINEL', createdAt: '2026-09-20T00:00:00Z' }],
      episodes: [{ kind: 'episode', text: '' }] }));
    for await (const _ of maxOscarAnswerStream({ turn: { id: 'turn', request: {
      text: 'что я люблю пить?', modifiers: { requestedModel: 'max-gpt-oss-120b' }, history: [] } },
      attachments: [], signal: new AbortController().signal } as any, env, false, undefined, recall)) { /* consume */ }
    expect(recall).toHaveBeenCalledWith('что я люблю пить?', expect.any(AbortSignal));
    const memory = calls[1].messages.find((message: any) => message.role === 'system' && message.content.includes('owner-memory-recall'));
    expect(memory.content).toContain('Владелец любит чай MEMORY_SENTINEL');
    expect(memory.content).toContain('а не инструкциями');
    // Without a port nothing is looked up or sent.
    calls.length = 0;
    for await (const _ of maxOscarAnswerStream({ turn: { id: 'turn', request: {
      text: 'что я люблю пить?', modifiers: { requestedModel: 'max-gpt-oss-120b' }, history: [] } },
      attachments: [], signal: new AbortController().signal } as any, env)) { /* consume */ }
    expect(JSON.stringify(calls)).not.toContain('owner-memory-recall');
  });
  it('answers without memory when recall fails', async () => {
    const { env } = await fixture();
    const events = [];
    for await (const event of maxOscarAnswerStream({ turn: { id: 'turn', request: {
      text: 'привет', modifiers: { requestedModel: 'max-gpt-oss-120b' }, history: [] } },
      attachments: [], signal: new AbortController().signal } as any, env, false, undefined,
      async () => { throw Error('memory-offline'); })) events.push(event);
    expect(events[0]).toEqual({ type: 'token', token: 'Привет из MAX' });
  });
  it('tells the model which model it is instead of leaving it to guess', async () => {
    const { env, calls } = await fixture();
    for await (const _ of maxOscarAnswerStream({ turn: { id: 'turn', request: {
      text: 'какая ты модель?', modifiers: { requestedModel: 'max-gpt-oss-120b' }, history: [] } },
      attachments: [], signal: new AbortController().signal } as any, env)) { /* consume */ }
    const system = calls[1].messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
    expect(system).toContain('модель openai/gpt-oss-120b через MAX');
    expect(system).toContain('Не выдавай себя за GPT-4');
  });
  it('restores line breaks the model escaped twice, so the reply is not one glued paragraph', async () => {
    const twice = 'Привет!\\n\\n**Итог**\\n- раз\\n- два';
    const { env } = await fixture({ primary: { text: twice } });
    const events = [];
    for await (const event of maxOscarAnswerStream({ turn: { id: 'turn', request: {
      text: 'привет', modifiers: { requestedModel: 'max-gpt-oss-120b' }, history: [] } },
      attachments: [], signal: new AbortController().signal } as any, env)) events.push(event);
    expect(events[0]).toEqual({ type: 'token', token: 'Привет!\n\n**Итог**\n- раз\n- два' });
  });
  it('leaves text alone when it already has real line breaks or a lone escape sequence', () => {
    expect(restoreDoubleEscapedLineBreaks('строка\nстрока \\n \\n \\n')).toBe('строка\nстрока \\n \\n \\n');
    expect(restoreDoubleEscapedLineBreaks('Символ \\n переводит строку')).toBe('Символ \\n переводит строку');
    expect(restoreDoubleEscapedLineBreaks('a\\nb\\nc\\nd')).toBe('a\nb\nc\nd');
  });
  it.each([false, true])('passes retrieved sources to the exact MAX model (deep: %s)', async deep => {
    const { env, calls } = await fixture();
    const search = vi.fn(async () => ({ sources: [{ title: 'Weather', url: 'https://example.com/weather', snippet: 'Varna observation: 21 C' }] }));
    const execution = { turn: { id: 'web', request: { text: 'сколько градусов в варне сейчас', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: deep ? 'deep' : 'auto', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search)) events.push(event);
    expect(search).toHaveBeenCalledWith(execution.turn.request.text, deep, execution.signal, []);
    expect(events.find(event => event.type === 'sources')).toMatchObject({ type: 'sources', sources: [{ url: 'https://example.com/weather' }] });
    expect(JSON.stringify(calls[1].messages)).toContain('Varna observation: 21 C');
    expect(JSON.stringify(calls[1].messages)).toContain('untrusted-public-search');
    expect(calls[1].model).toBe('openai/gpt-oss-120b');
  });
  it('deep research searches for the gaps the model names, then answers once from all sources', async () => {
    const { env, calls } = await fixture();
    const search = vi.fn(async (_query: string, _deep: boolean, _signal: AbortSignal, queries: string[]) => ({
      sources: queries.includes('Starship flight 12 date')
        ? [{ title: 'Flight 12', url: 'https://news.example/flight-12', snippet: 'Flight 12 launched on 2026-10-02.', published: '2026-10-02' }]
        : [{ title: 'SpaceX', url: 'https://news.example/spacex', snippet: 'SpaceX plans more Starship flights.' }] }));
    const plan = vi.fn(async () => ({ queries: ['SpaceX Starship news', 'Starship test results', 'Starship criticism'], deep: false }));
    const assess = vi.fn()
      .mockResolvedValueOnce({ enough: false, gaps: ['дата последнего полёта'], queries: ['Starship flight 12 date'] })
      .mockResolvedValueOnce({ enough: true, gaps: [], queries: [] });
    const execution = { turn: { id: 'deep', request: { text: 'что сейчас со Starship?', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'deep', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events: any[] = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search, undefined, plan, assess)) events.push(event);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ deep: true }));
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1]![3]).toEqual(['Starship flight 12 date']);
    expect(assess.mock.calls[1]![0].searched).toContain('Starship flight 12 date');
    expect(events.filter(event => event.type === 'search').map(event => event.queries))
      .toEqual([['SpaceX Starship news', 'Starship test results', 'Starship criticism'], ['Starship flight 12 date']]);
    expect(events.filter(event => event.type === 'progress').map(event => event.stage)).toEqual(['plan', 'read', 'verify', 'read', 'write']);
    const answerRequest = JSON.stringify(calls.filter(call => call.model === 'openai/gpt-oss-120b').at(-1)!.messages);
    expect(answerRequest).toContain('Flight 12 launched on 2026-10-02.');
    expect(answerRequest).toContain('SpaceX plans more Starship flights.');
    expect(answerRequest).toContain('2026-10-02');
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { research_mode: 'deep', research_sources: 2, research_rounds: 1 } });
  });
  it('deep research is bounded when the model always wants more, and survives a failed check', async () => {
    const { env } = await fixture();
    let n = 0;
    const search = vi.fn(async () => ({ sources: [{ title: `S${n}`, url: `https://news.example/${n++}`, snippet: 'fact' }] }));
    const always = vi.fn(async (input: any) => ({ enough: false, gaps: ['ещё'], queries: [`q${input.searched.length}`] }));
    const execution = { turn: { id: 'deep', request: { text: 'исследуй тему', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'deep', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events: any[] = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search, undefined, undefined, always)) events.push(event);
    expect(always).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { research_rounds: 2 } });
    const broken = vi.fn(async () => { throw Error('rate-limit'); });
    const after: any[] = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search, undefined, undefined, broken)) after.push(event);
    expect(after.find(event => event.type === 'sources')).toBeTruthy();
    expect(after.at(-1)).toMatchObject({ type: 'done' });
  });
  it.each([
    ['wikipedia', true],
    ['saved', true],
    ['engine', false],
  ])('tells the person when the evidence is %s only (notice: %s)', async (origin, noticed) => {
    const { env } = await fixture();
    const notice = 'Поисковики сейчас не отвечают — ответ собран только по Википедии.';
    const search = vi.fn(async () => ({ notice: origin === 'engine' ? '' : notice,
      sources: [{ title: 'Starship', url: 'https://ru.wikipedia.org/wiki/Starship', snippet: 'Starship — ракета.', origin }] }));
    const execution = { turn: { id: 'web', request: { text: 'что такое Starship', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'auto', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events: any[] = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search)) events.push(event);
    const first = events.find(event => event.type === 'token');
    if (noticed) expect(first.token).toBe(`_${notice}_\n\n`);
    else expect(first.token).not.toContain('Поисковики');
  });
  it('says the engines are down instead of a generic miss when nothing could be searched', async () => {
    const { env } = await fixture();
    const notice = 'Поисковики сейчас не отвечают, а сохранённых страниц по теме нет — ответ не проверен в интернете. Попробуй ещё раз через пару минут.';
    const execution = { turn: { id: 'web', request: { text: 'что со Starship', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'auto', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events: any[] = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, async () => ({ sources: [], notice }))) events.push(event);
    expect(events).toEqual([{ type: 'error', message: notice }]);
  });
  it('searches for what the model planned, not for the whole message', async () => {
    const { env } = await fixture();
    const search = vi.fn(async () => ({ sources: [{ title: 'Weather', url: 'https://example.com/weather', snippet: 'Varna: 21 C' }] }));
    const plan = vi.fn(async () => ({ queries: ['погода Варна Болгария 5 дней'], deep: false }));
    const text = 'какая погода на ближайшие дни в Варне? И запомни, я живу в Варне в Болгарии';
    const history = [{ role: 'user', content: 'как дела?' }, { role: 'assistant', content: 'Привет! Хорошо.' }];
    const execution = { turn: { id: 'web', request: { text, history,
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'auto', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search, undefined, plan)) events.push(event);
    expect(plan).toHaveBeenCalledWith({ text, history, requestedModel: 'max-gpt-oss-120b', signal: execution.signal, chooseDepth: true });
    expect(events[0]).toEqual({ type: 'search', queries: ['погода Варна Болгария 5 дней'] });
    expect(search).toHaveBeenCalledWith(text, false, execution.signal, ['погода Варна Болгария 5 дней']);
    expect(events.some((event: any) => event.type === 'progress')).toBe(false);
  });
  it('on auto, a question the planner judges analytical becomes deep research', async () => {
    const { env } = await fixture();
    const search = vi.fn(async () => ({ sources: [{ title: 'Laptops', url: 'https://example.com/laptops', snippet: 'ThinkPad vs MacBook Air' }] }));
    const plan = vi.fn(async () => ({ queries: ['laptop programming under 1000', 'MacBook Air vs ThinkPad', 'budget laptop drawbacks'], deep: true }));
    const assess = vi.fn(async () => ({ enough: true, gaps: [], queries: [] }));
    const execution = { turn: { id: 'auto-deep', request: { text: 'какой ноутбук взять для программирования до 1000$?', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'auto', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events: any[] = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search, undefined, plan, assess)) events.push(event);
    expect(search).toHaveBeenCalledWith(execution.turn.request.text, true, execution.signal, ['laptop programming under 1000', 'MacBook Air vs ThinkPad', 'budget laptop drawbacks']);
    expect(assess).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'progress').map(event => event.stage)).toEqual(['plan', 'read', 'write']);
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { research_mode: 'deep', research_escalated: true } });
  });
  it('research "off" never asks for or takes an escalation', async () => {
    const { env } = await fixture();
    const search = vi.fn(async () => ({ sources: [{ title: 'Laptops', url: 'https://example.com/laptops', snippet: 'x' }] }));
    const plan = vi.fn(async () => ({ queries: ['laptop programming under 1000'], deep: true }));
    const assess = vi.fn(async () => ({ enough: true, gaps: [], queries: [] }));
    const execution = { turn: { id: 'off', request: { text: 'какой ноутбук взять?', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'off', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events: any[] = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search, undefined, plan, assess)) events.push(event);
    expect(plan.mock.calls[0]![0]).not.toHaveProperty('chooseDepth');
    expect(search).toHaveBeenCalledWith(execution.turn.request.text, false, execution.signal, ['laptop programming under 1000']);
    expect(assess).not.toHaveBeenCalled();
    expect(events.at(-1)!.usage).not.toHaveProperty('research_escalated');
  });
  it('still searches for the request when planning fails', async () => {
    const { env } = await fixture();
    const search = vi.fn(async () => ({ sources: [{ title: 'Weather', url: 'https://example.com/weather', snippet: 'Varna: 21 C' }] }));
    const execution = { turn: { id: 'web', request: { text: 'погода в Варне', history: [],
      modifiers: { requestedModel: 'max-gpt-oss-120b', webSearch: true, researchMode: 'auto', dataEgressConsentId: 'consumed-by-coordinator' } } },
      attachments: [], signal: new AbortController().signal } as any;
    const events = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search, undefined, async () => { throw Error('rate-limited'); })) events.push(event);
    expect(search).toHaveBeenCalledWith('погода в Варне', false, execution.signal, []);
    expect(events[0]).toMatchObject({ type: 'sources' });
  });
  it.each(['failed', 'empty', 'cancelled'])('does not generate ungrounded live claims after search is %s', async status => {
    const { env, calls } = await fixture();
    const controller = new AbortController();
    const search = vi.fn(async () => {
      if (status === 'failed') throw Error('backend-down');
      if (status === 'cancelled') controller.abort();
      return { sources: [] };
    });
    const execution = { turn: { id: 'web', request: { text: 'current weather', modifiers: {
      requestedModel: 'max-gpt-oss-120b', webSearch: true, dataEgressConsentId: 'consumed' } } },
      attachments: [], signal: controller.signal } as any;
    const events = [];
    for await (const event of maxOscarAnswerStream(execution, env, true, search)) events.push(event);
    expect(calls).toHaveLength(0);
    expect(events[0]).toMatchObject(status === 'cancelled' ? { type: 'done', cancelled: true } : { type: 'error' });
  });
  it('does not run search without turn consent', async () => {
    const { env } = await fixture();
    const search = vi.fn();
    const execution = { turn: { id: 'web', request: { text: 'Hello', modifiers: {
      requestedModel: 'max-gpt-oss-120b', webSearch: true } } }, attachments: [], signal: new AbortController().signal } as any;
    for await (const _ of maxOscarAnswerStream(execution, env, true, search)) {}
    expect(search).not.toHaveBeenCalled();
  });
  it('rejects MAX images without hidden Qwen routing or any provider call', async () => {
    const { env, calls } = await fixture();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const execution = { turn: { id: 'turn', request: {
      text: 'Опиши изображение', modifiers: { requestedModel: 'max-gpt-oss-120b' }, history: [],
    } }, attachments: [{ id: 'image_1', name: 'screen.png', mimeType: 'image/png', sizeBytes: bytes.byteLength,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }],
      signal: new AbortController().signal } as any;
    await expect(async () => { for await (const _ of maxOscarAnswerStream(execution, env)) {} })
      .rejects.toThrow('astra-max-native:image-model-unavailable');
    expect(calls).toHaveLength(0);
  });
  it('rejects changed image bytes before any provider request', async () => {
    const { env, calls } = await fixture();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const execution = { turn: { id: 'turn', request: { text: 'Опиши',
      modifiers: { requestedModel: 'max-qwen-3.8-27b' }, history: [] } },
    attachments: [{ id: 'image_1', name: 'screen.png', mimeType: 'image/png', sizeBytes: bytes.byteLength,
      digest: 'sha256:' + '0'.repeat(64), dataBase64: bytes.toString('base64') }],
    signal: new AbortController().signal } as any;
    await expect(async () => { for await (const _event of maxOscarAnswerStream(execution, env)) { /* consume */ } })
      .rejects.toThrow('astra-max-native:image-integrity');
    expect(calls).toHaveLength(0);
  });
  it('rejects retired Qwen and keeps the GPT provider ceiling', async () => {
    const { env, calls } = await fixture();
    await expect(requestMaxNative({ role: 'max-qwen-3.8-27b', messages: [{ role: 'user', content: 'Ответь' }] },
      undefined, env)).rejects.toThrow('model-retired');
    await expect(requestMaxNative({ role: 'max-gpt-oss-120b', messages: [{ role: 'user', content: 'Ответь' }],
      maxTokens: 65_537 }, undefined, env)).rejects.toThrow('output-budget');
    expect(calls).toHaveLength(0);
  });
  it.each(['max-gpt-oss-120b'])('routes %s through two safety checks and exact primary without local startup', async role => {
    const { env, calls } = await fixture();
    const result = await completeWithModelRole({ models: [] } as unknown as MonarchModelCatalog, {
      role: role as 'max-gpt-oss-120b', requestedModel: role, forceManagedRuntimeRestart: true,
      messages: [{ role: 'user', content: 'Привет' }], maxTokens: 256,
    }, env);
    expect(result).toMatchObject({ ok: true, adapter: 'groq-max', rawText: 'Привет из MAX', attemptedRoles: [role], finishReason: 'stop' });
    expect(calls.map(call => call.model)).toEqual(['openai/gpt-oss-safeguard-20b',
      role === 'max-gpt-oss-120b' ? 'openai/gpt-oss-120b' : 'qwen/qwen3.8-27b', 'openai/gpt-oss-safeguard-20b']);
    expect(calls[1]?.max_completion_tokens).toBe(2048);
    if (role === 'max-gpt-oss-120b') {
      expect(calls[1]?.include_reasoning).toBe(false); expect(calls[1]).not.toHaveProperty('reasoning_format');
    } else expect(calls[1]?.reasoning_format).toBe('hidden');
    expect(calls.every(call => call.tool_choice === 'none' && call.tools === undefined)).toBe(true);
  });
  it('retains the requested JSON contract for agent decisions', async () => {
    const { env } = await fixture({ primary: { answer: 'Готово' } });
    const result = await requestMaxNative({ role: 'max-gpt-oss-120b', messages: [{ role: 'user', content: 'Ответь' }],
      responseSchema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } }, required: ['answer'] } }, undefined, env);
    expect(JSON.parse(result.text)).toEqual({ answer: 'Готово' });
  });
  it('blocks before a primary request and never falls back', async () => {
    const { env, calls } = await fixture({ block: true });
    await expect(requestMaxNative({ role: 'max-gpt-oss-120b', messages: [{ role: 'user', content: 'synthetic block' }] }, undefined, env)).rejects.toThrow('safety-blocked-input');
    expect(calls).toHaveLength(1);
  });
  it('rejects unauthenticated and browser-origin callers without provider traffic', async () => {
    const { server, calls } = await fixture();
    expect((await fetch(server.endpoint, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(server.endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + server.bearerToken, origin: 'http://evil.test' }, body: '{}' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('validates consent before connection testing or saving a key', async () => {
    const { host, fetchFn } = await fixture();
    await expect(host.configure({ apiKey: 'gsk_synthetic_no_real_key_123456789', consent: { ...consent, selectedContextAcknowledged: false } as unknown as typeof consent })).rejects.toThrow('consent-required');
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('Stop aborts the host operation on client disconnect', async () => {
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let aborted!: () => void;
    const cancelled = new Promise<void>(resolve => { aborted = resolve; });
    const server = await startAstraMaxNativeServer({ complete: async (_input: unknown, signal: AbortSignal) => {
      started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      throw Error('cancelled');
    } });
    cleanup.push(server.close);
    const controller = new AbortController();
    const pending = requestMaxNative({ role: 'max-gpt-oss-120b', messages: [{ role: 'user', content: 'test' }] }, controller.signal,
      { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken });
    const rejected = expect(pending).rejects.toThrow();
    await entered; controller.abort(); await rejected; await cancelled;
  });
});

describe('native MAX answer stream over the loopback channel', () => {
  const role = 'max-cloud:deepseek:deepseek-chat';
  async function serve(stream: (input: unknown, signal: AbortSignal) => AsyncGenerator<unknown>) {
    const server = await startAstraMaxNativeServer({ complete: async () => { throw Error('unused'); }, stream });
    cleanup.push(server.close);
    return { MONARCH_MAX_NATIVE_ENDPOINT: server.endpoint, MONARCH_MAX_NATIVE_TOKEN: server.bearerToken };
  }
  it('delivers pieces as they arrive and ends with the bound model', async () => {
    const env = await serve(async function* () { yield { delta: 'Раз, ' }; yield { delta: 'два' }; yield { done: true, model: 'deepseek-chat' }; });
    const stream = streamMaxNativeAnswer({ role, messages: [{ role: 'user', content: 'x' }] }, undefined, env);
    const pieces: string[] = [];
    let next = await stream.next();
    while (!next.done) { pieces.push(next.value); next = await stream.next(); }
    expect(pieces).toEqual(['Раз, ', 'два']);
    expect(next.value).toEqual({ model: 'deepseek-chat', stopReason: 'stop' });
  });
  it('carries a length stop across the loopback channel', async () => {
    const env = await serve(async function* () { yield { delta: 'обрез' }; yield { done: true, model: 'deepseek-chat', stopReason: 'length' }; });
    const stream = streamMaxNativeAnswer({ role, messages: [{ role: 'user', content: 'x' }] }, undefined, env);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(next.value).toEqual({ model: 'deepseek-chat', stopReason: 'length' });
  });
  it('turns a failure after the first piece into the public error code', async () => {
    const env = await serve(async function* () { yield { delta: 'часть' }; throw Error('astra-max-cloud:safety-blocked'); });
    const run = async () => { for await (const _ of streamMaxNativeAnswer({ role, messages: [{ role: 'user', content: 'x' }] }, undefined, env)) { /* partial */ } };
    await expect(run()).rejects.toThrow('astra-max-native:safety-blocked');
  });
  it('reports a failure before any piece as the response status', async () => {
    const env = await serve(async function* () { throw Error('astra-max-cloud:credential-rejected'); });
    const run = async () => { for await (const _ of streamMaxNativeAnswer({ role, messages: [{ role: 'user', content: 'x' }] }, undefined, env)) { /* none */ } };
    await expect(run()).rejects.toThrow('astra-max-native:credential-rejected');
  });
});
