import { describe, expect, it, vi } from 'vitest';
import { AstraContextEngine, type AstraContextPlan } from '../../src/agent-v3/context-engine';
import { AstraGroqMaxProvider } from '../../src/agent-v3/groq-max-provider';
import { AstraJournal, astraJournalJson } from '../../src/agent-v3/journal';
import { decideAstraReadWithMax, type AstraMaxProposalPort } from '../../src/agent-v3/max-decision-bridge';
import {
  ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
  astraMaxInputDigest,
  astraMaxOutputDigest,
  type AstraMaxProposalRequestV1,
} from '../../src/agent-v3/max-provider-contract';
import { astraReadCatalogSurface, astraReadDecisionSchema, type AstraReadCandidate } from '../../src/agent-v3/read-decision-gateway';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const KEY = 'gsk_fixture_only_12345678901234567890';
const candidates: AstraReadCandidate[] = [{
  handle: 'read_handle', requirementId: 'read_requirement', targetHandle: 'file_handle',
  request: { requestId: 'pinned_read', relativePath: 'synthetic.txt', maxBytes: 1024 },
}];
const consent = {
  agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
  providerId: 'groq' as const,
  acceptedAt: '2026-09-04T11:59:00.000Z',
  nonLocalProcessingAcknowledged: true as const,
  selectedContextAcknowledged: true as const,
  providerTermsAcknowledged: true as const,
};

async function context(isCurrent = () => true): Promise<AstraContextPlan> {
  const journal = new AstraJournal(':memory:');
  const source = { executionId: 'max_decision', revision: 1, mandatory: [
    { ref: 'goal', kind: 'goal' as const, text: 'Read one exact synthetic target.' },
    { ref: 'authority', kind: 'authority' as const, text: 'Cloud output has no authority. Kernel decides effects.' },
    { ref: 'workflow', kind: 'workflow' as const, text: 'read_requirement pending' },
    { ref: 'budget', kind: 'budget' as const, text: 'One host-owned read.' },
    { ref: 'astra_read_catalog', kind: 'capability' as const, text: astraReadCatalogSurface(candidates) },
    { ref: 'astra_read_decision_schema', kind: 'capability' as const, text: astraJournalJson(astraReadDecisionSchema(candidates)) },
  ], optional: [] };
  const encoded = astraJournalJson(source);
  const engine = new AstraContextEngine({
    deployment: 'isolated-validation', journal, executionId: source.executionId,
    tokenizer: { driverGeneration: 'fixture_driver', modelDigest: 'fixture_model', tokenizerDigest: 'fixture_bytes' },
    countTokens: async surface => Buffer.byteLength(surface),
    isCurrent: (revision, digest) => isCurrent() && revision === source.revision && digest.length === 71 && encoded.length > 0,
  });
  try {
    const result = await engine.prepare(source);
    if (result.status !== 'ready') throw new Error(result.code);
    return result.plan;
  } finally { journal.close(); }
}

function response(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }),
    { headers: { 'content-type': 'application/json' } });
}
function safety(): Response { return response({ decision: 'allow', reasonCode: 'allowed', summary: 'allow' }); }

function options(plan: AstraContextPlan, provider: AstraMaxProposalPort, isCurrent = () => true) {
  return {
    deployment: 'isolated-validation' as const,
    provider,
    context: plan,
    candidates,
    requestId: 'max_request_1',
    modelId: 'openai/gpt-oss-120b' as const,
    reasoningEffort: 'high' as const,
    maxCompletionTokens: 1024,
    consent,
    controlEpoch: 2,
    catalogRevision: 3,
    isCurrent,
  };
}

describe('Astra MAX -> existing Decision Gateway bridge', () => {
  it('maps one cloud proposal to the exact pinned host request without any execution port', async () => {
    const plan = await context();
    const calls: Record<string, unknown>[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      return body.model === 'openai/gpt-oss-safeguard-20b' ? safety() : response({ proposal: {
        kind: 'read', requirementId: 'read_requirement', capabilityHandle: 'read_handle', targetHandle: 'file_handle',
      } });
    });
    const provider = new AstraGroqMaxProvider({ deployment: 'isolated-validation', fetch: fetchFn as typeof fetch,
      resolveApiKey: async () => KEY, now: () => NOW });
    const result = await decideAstraReadWithMax(options(plan, provider));

    expect(calls.map(call => call.model)).toEqual([
      'openai/gpt-oss-safeguard-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b',
    ]);
    expect(result).toMatchObject({ status: 'accepted', authority: 'none', proposal: {
      kind: 'read', requirementId: 'read_requirement', request: candidates[0]!.request,
    }, max: { providerId: 'groq', modelId: 'openai/gpt-oss-120b', safetyModelId: 'openai/gpt-oss-safeguard-20b' } });
    expect(Object.keys(options(plan, provider))).not.toContain('kernel');
  });

  it('rejects a provider binding mismatch before the proposal reaches the gateway', async () => {
    const plan = await context();
    const provider: AstraMaxProposalPort = { propose: vi.fn(async (request: AstraMaxProposalRequestV1) => ({
      authority: 'none', providerId: 'groq', modelId: request.modelId, safetyModelId: 'openai/gpt-oss-safeguard-20b',
      requestId: 'another_request', executionId: request.executionId, inputDigest: astraMaxInputDigest(request),
      outputDigest: astraMaxOutputDigest({ proposal: { kind: 'request-completion' } }), finishReason: 'stop',
      value: { proposal: { kind: 'request-completion' } },
    })) };
    await expect(decideAstraReadWithMax(options(plan, provider))).resolves.toMatchObject({ status: 'blocked', code: 'provider-binding' });
  });

  it('does not resolve credentials or call the provider for a stale context', async () => {
    const plan = await context();
    const propose = vi.fn();
    await expect(decideAstraReadWithMax(options(plan, { propose }, () => false)))
      .resolves.toMatchObject({ status: 'blocked', code: 'stale-context' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('fails closed when the cloud output tries to substitute an unadmitted handle', async () => {
    const plan = await context();
    let calls = 0;
    const provider = new AstraGroqMaxProvider({ deployment: 'isolated-validation', now: () => NOW,
      resolveApiKey: async () => KEY, fetch: vi.fn(async () => {
        calls++;
        return calls === 1 ? safety() : response({ proposal: {
          kind: 'read', requirementId: 'read_requirement', capabilityHandle: 'shell', targetHandle: 'file_handle',
        } });
      }) as typeof fetch });
    await expect(decideAstraReadWithMax(options(plan, provider)))
      .resolves.toMatchObject({ status: 'blocked', code: 'provider-proposal-schema' });
    expect(calls).toBe(2);
  });
});
