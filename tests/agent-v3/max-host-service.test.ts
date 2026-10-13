import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AstraContextEngine, type AstraContextPlan } from '../../src/agent-v3/context-engine';
import { AstraMaxHostService } from '../../src/agent-v3/max-host-service';
import { AstraJournal, astraJournalJson } from '../../src/agent-v3/journal';
import { ASTRA_MAX_PROVIDER_AGREEMENT_VERSION } from '../../src/agent-v3/max-provider-contract';
import { AstraMaxSettingsStore } from '../../src/agent-v3/max-settings-store';
import { astraReadCatalogSurface, astraReadDecisionSchema, type AstraReadCandidate } from '../../src/agent-v3/read-decision-gateway';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const KEY = 'gsk_fixture_only_12345678901234567890';
const roots: string[] = [];
const candidates: AstraReadCandidate[] = [{ handle: 'read_handle', requirementId: 'read_requirement', targetHandle: 'file_handle',
  request: { requestId: 'pinned_read', relativePath: 'synthetic.txt', maxBytes: 1024 } }];
const protectedStorage = { isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8').map(byte => byte ^ 0x5a),
  decryptString: (value: Buffer) => Buffer.from(value).map(byte => byte ^ 0x5a).toString('utf8') };

beforeAll(async () => { await mkdir(path.join(process.cwd(), 'runtime'), { recursive: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(fetchFn?: typeof fetch) {
  const root = await mkdtemp(path.join(process.cwd(), 'runtime', 'astra-max-host-'));
  roots.push(root);
  const settings = new AstraMaxSettingsStore({ deployment: 'isolated-validation', rootPath: root, protectedStorage,
    restrictAccess: async () => true, now: () => NOW });
  return { settings, host: new AstraMaxHostService({ deployment: 'isolated-validation', settings,
    ...(fetchFn ? { fetch: fetchFn } : {}), now: () => NOW }) };
}

async function context(): Promise<AstraContextPlan> {
  const journal = new AstraJournal(':memory:');
  const engine = new AstraContextEngine({ deployment: 'isolated-validation', journal, executionId: 'max_host',
    tokenizer: { driverGeneration: 'fixture_driver', modelDigest: 'fixture_model', tokenizerDigest: 'fixture_bytes' },
    countTokens: async surface => Buffer.byteLength(surface), isCurrent: () => true });
  try {
    const result = await engine.prepare({ executionId: 'max_host', revision: 1, mandatory: [
      { ref: 'goal', kind: 'goal', text: 'Read exact synthetic target.' },
      { ref: 'authority', kind: 'authority', text: 'Cloud output has no execution authority.' },
      { ref: 'workflow', kind: 'workflow', text: 'read_requirement pending' },
      { ref: 'budget', kind: 'budget', text: 'One host-owned read.' },
      { ref: 'astra_read_catalog', kind: 'capability', text: astraReadCatalogSurface(candidates) },
      { ref: 'astra_read_decision_schema', kind: 'capability', text: astraJournalJson(astraReadDecisionSchema(candidates)) },
    ], optional: [] });
    if (result.status !== 'ready') throw new Error(result.code);
    return result.plan;
  } finally { journal.close(); }
}

function completion(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }),
    { headers: { 'content-type': 'application/json' } });
}

describe('Astra MAX isolated host composition', () => {
  it('keeps ordinary setup status simple and blocks cloud work before configuration', async () => {
    const fetchFn = vi.fn();
    const { host } = await fixture(fetchFn as unknown as typeof fetch);
    expect(await host.setupView()).toEqual({ state: 'not-configured', connectionVerified: false, title: 'Подключи MAX',
      detail: 'Monarch пошагово поможет подключить облачные модели.', nextAction: 'connect' });
    expect(JSON.stringify(await host.setupView())).not.toMatch(/token|sha|runtime|credential/iu);
    await expect(host.decideRead({ context: await context(), candidates, requestId: 'request_1',
      modelId: 'openai/gpt-oss-120b', reasoningEffort: 'high', maxCompletionTokens: 1024,
      controlEpoch: 1, catalogRevision: 1, isCurrent: () => true }))
      .resolves.toMatchObject({ status: 'blocked', code: 'settings-not-configured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('composes protected setup, safety, cloud proposal and the existing gateway without a Kernel port', async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      return body.model === 'openai/gpt-oss-safeguard-20b'
        ? completion({ decision: 'allow', reasonCode: 'allowed', summary: 'allow' })
        : completion({ proposal: { kind: 'read', requirementId: 'read_requirement',
          capabilityHandle: 'read_handle', targetHandle: 'file_handle' } });
    });
    const { host } = await fixture(fetchFn as unknown as typeof fetch);
    expect(await host.configure({ apiKey: KEY, consent: { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
      providerId: 'groq', acceptedAt: '2026-09-04T11:59:00.000Z', nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true, providerTermsAcknowledged: true } }))
      .toMatchObject({ state: 'ready', connectionVerified: false, title: 'Ключ MAX сохранён' });
    expect(calls).toHaveLength(0);

    const result = await host.decideRead({ context: await context(), candidates, requestId: 'request_1',
      modelId: 'openai/gpt-oss-120b', reasoningEffort: 'high', maxCompletionTokens: 1024,
      controlEpoch: 1, catalogRevision: 1, isCurrent: () => true });
    expect(result).toMatchObject({ status: 'accepted', authority: 'none', proposal: {
      kind: 'read', request: candidates[0]!.request,
    } });
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(Object.keys(host)).not.toContain('kernel');
    expect(await host.setupView()).toMatchObject({ state: 'ready', connectionVerified: true, title: 'MAX готов' });
  });

  it('uses the same protected connection for a sealed prepared-model proposal', async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push(body);
      return body.model === 'openai/gpt-oss-safeguard-20b'
        ? completion({ decision: 'allow', reasonCode: 'allowed', summary: 'allow' })
        : completion({ kind: 'request-completion' });
    });
    const { host } = await fixture(fetchFn as unknown as typeof fetch);
    await host.configure({ apiKey: KEY, consent: { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
      providerId: 'groq', acceptedAt: '2026-09-04T11:59:00.000Z', nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true, providerTermsAcknowledged: true } });
    const result = await host.proposePrepared({ requestId: 'prepared_request', executionId: 'prepared_execution',
      modelId: 'openai/gpt-oss-120b', reasoningEffort: 'high', maxCompletionTokens: 256,
      messages: [{ role: 'system', content: 'Return only the exact schema.' }, { role: 'user', content: 'Finish the bounded plan.' }],
      responseSchema: { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string', const: 'request-completion' } }, required: ['kind'] } });
    expect(result).toMatchObject({ authority: 'none', requestId: 'prepared_request', executionId: 'prepared_execution',
      value: { kind: 'request-completion' } });
    expect(calls.map(call => call.model)).toEqual([
      'openai/gpt-oss-safeguard-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b',
    ]);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(await host.setupView()).toMatchObject({ state: 'ready', connectionVerified: true, title: 'MAX готов' });
  });

  it('keeps a saved key retryable without claiming that a failed provider connection was verified', async () => {
    const { host } = await fixture(vi.fn(async () => { throw new Error('fixture-network-failure'); }) as unknown as typeof fetch);
    await host.configure({ apiKey: KEY, consent: { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
      providerId: 'groq', acceptedAt: '2026-09-04T11:59:00.000Z', nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true, providerTermsAcknowledged: true } });
    await expect(host.proposePrepared({ requestId: 'failed_request', executionId: 'failed_execution',
      modelId: 'openai/gpt-oss-120b', reasoningEffort: 'high', maxCompletionTokens: 256,
      messages: [{ role: 'user', content: 'Synthetic failure.' }],
      responseSchema: { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string', const: 'request-completion' } }, required: ['kind'] } }))
      .rejects.toThrow();
    expect(await host.setupView()).toMatchObject({ state: 'ready', connectionVerified: false,
      title: 'Ключ MAX сохранён', nextAction: 'none' });
  });

  it('does not let an older in-flight request verify a newly replaced key', async () => {
    let releaseFirstCall: (() => void) | undefined;
    const firstCallBlocked = new Promise<void>(resolve => { releaseFirstCall = resolve; });
    let callCount = 0;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      callCount += 1;
      if (callCount === 1) await firstCallBlocked;
      return body.model === 'openai/gpt-oss-safeguard-20b'
        ? completion({ decision: 'allow', reasonCode: 'allowed', summary: 'allow' })
        : completion({ kind: 'request-completion' });
    });
    const { host } = await fixture(fetchFn as unknown as typeof fetch);
    const consent = { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, providerId: 'groq' as const,
      acceptedAt: '2026-09-04T11:59:00.000Z', nonLocalProcessingAcknowledged: true,
      selectedContextAcknowledged: true, providerTermsAcknowledged: true };
    await host.configure({ apiKey: KEY, consent });
    const pending = host.proposePrepared({ requestId: 'older_request', executionId: 'older_execution',
      modelId: 'openai/gpt-oss-120b', reasoningEffort: 'high', maxCompletionTokens: 256,
      messages: [{ role: 'user', content: 'Synthetic older request.' }],
      responseSchema: { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string', const: 'request-completion' } }, required: ['kind'] } });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await host.configure({ apiKey: 'gsk_fixture_replacement_12345678901234567890', consent });
    releaseFirstCall?.();
    await expect(pending).resolves.toMatchObject({ value: { kind: 'request-completion' } });
    expect(await host.setupView()).toMatchObject({ state: 'ready', connectionVerified: false,
      title: 'Ключ MAX сохранён' });
  });
});
