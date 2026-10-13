import { describe, expect, it } from 'vitest';
import { AstraJournal, astraJournalJson } from '../../src/agent-v3/journal';
import { AstraContextEngine } from '../../src/agent-v3/context-engine';
import { ASTRA_READ_DECISION_VERSION, AstraReadDecisionGateway, astraReadCatalogSurface, astraReadDecisionSchema,
  type AstraReadCandidate } from '../../src/agent-v3/read-decision-gateway';

const candidates: AstraReadCandidate[] = [{ handle: 'read_handle', requirementId: 'read_requirement', targetHandle: 'file_handle',
  request: { requestId: 'pinned_read', relativePath: 'synthetic.txt', maxBytes: 1024 } }];
async function context() {
  const journal = new AstraJournal(':memory:');
  const engine = new AstraContextEngine({ deployment: 'isolated-validation', journal, executionId: 'decision_test',
    tokenizer: { driverGeneration: 'fixture_driver', modelDigest: 'fixture_model', tokenizerDigest: 'fixture_byte_vocab' },
    countTokens: async surface => Buffer.byteLength(surface), isCurrent: () => true });
  try {
    const result = await engine.prepare({ executionId: 'decision_test', revision: 1, mandatory: [
      { ref: 'goal', kind: 'goal', text: 'Read exact synthetic target; do not infer actions.' },
      { ref: 'authority', kind: 'authority', text: 'Kernel decides current execution permission.' },
      { ref: 'workflow', kind: 'workflow', text: 'read_requirement pending' },
      { ref: 'budget', kind: 'budget', text: 'One read with host-owned 1024-byte limit.' },
      { ref: 'astra_read_catalog', kind: 'capability', text: astraReadCatalogSurface(candidates) },
      { ref: 'astra_read_decision_schema', kind: 'capability', text: astraJournalJson(astraReadDecisionSchema(candidates)) },
    ], optional: [] });
    if (result.status !== 'ready') throw new Error(result.code);
    return result.plan;
  } finally { journal.close(); }
}
async function fixture(options: { current?: () => boolean; now?: () => number } = {}) {
  const gateway = new AstraReadDecisionGateway({ isCurrent: options.current ?? (() => true),
    ...(options.now ? { now: options.now } : {}), ttlMs: 1000 });
  const input = { executionId: 'decision_test', controlEpoch: 0, catalogRevision: 1, context: await context(), candidates };
  return { gateway, input, offer: gateway.offer(input) };
}
const read = { kind: 'read', requirementId: 'read_requirement', capabilityHandle: 'read_handle', targetHandle: 'file_handle' };

describe('Astra V3 exact Context/Catalog → read Decision Gateway (no model execution)', () => {
  it('constrains model identifiers to the counted catalog without exposing file arguments', () => {
    const one = JSON.stringify(astraReadDecisionSchema(candidates));
    expect(one).toContain('"const":"read_handle"');
    expect(one).not.toContain('synthetic.txt');
    expect(one).not.toContain('maxBytes');
    const many = JSON.stringify(astraReadDecisionSchema([...candidates,
      { ...candidates[0]!, handle: 'second_handle', requirementId: 'second_requirement', targetHandle: 'second_file' }]));
    expect(many).toContain('"enum":["read_handle","second_handle"]');
    const responseOnly = JSON.stringify(astraReadDecisionSchema([]));
    expect(responseOnly).not.toContain('"const":"read"');
    expect(responseOnly).toContain('"const":"respond"');
  });
  it('admits a response-only turn with no executable candidate', async () => {
    const empty: AstraReadCandidate[] = [], journal = new AstraJournal(':memory:');
    const engine = new AstraContextEngine({ deployment: 'isolated-validation', journal, executionId: 'response_only',
      tokenizer: { driverGeneration: 'fixture_driver', modelDigest: 'fixture_model', tokenizerDigest: 'fixture_byte_vocab' },
      countTokens: async surface => Buffer.byteLength(surface), isCurrent: () => true });
    try {
      const prepared = await engine.prepare({ executionId: 'response_only', revision: 1, mandatory: [
        { ref: 'goal', kind: 'goal', text: 'Answer only from retained observations.' },
        { ref: 'authority', kind: 'authority', text: 'No execution authority.' },
        { ref: 'workflow', kind: 'workflow', text: 'All admitted reads are already observed.' },
        { ref: 'budget', kind: 'budget', text: 'One bounded response.' },
        { ref: 'astra_read_catalog', kind: 'capability', text: astraReadCatalogSurface(empty) },
        { ref: 'astra_read_decision_schema', kind: 'capability', text: astraJournalJson(astraReadDecisionSchema(empty)) },
      ], optional: [] });
      if (prepared.status !== 'ready') throw Error(prepared.code);
      const gateway = new AstraReadDecisionGateway({ isCurrent: () => true });
      const offer = gateway.offer({ executionId: 'response_only', controlEpoch: 0, catalogRevision: 2,
        context: prepared.plan, candidates: empty });
      expect(offer.candidates).toEqual([]);
      expect(gateway.accept(offer.offerId, '{"kind":"respond","text":"Grounded answer."}')).toMatchObject({
        status: 'accepted', authority: 'none', proposal: { kind: 'respond', text: 'Grounded answer.' },
      });
      const second = gateway.offer({ executionId: 'response_only', controlEpoch: 0, catalogRevision: 2,
        context: prepared.plan, candidates: empty });
      expect(gateway.accept(second.offerId, JSON.stringify(read))).toEqual({ status: 'rejected', code: 'goal-target-binding' });
    } finally { journal.close(); }
  });
  it('accepts a pinned read proposal with no execution authority and no model-supplied file arguments', async () => {
    const f = await fixture();
    expect(f.offer.candidates).toEqual([{ handle: 'read_handle', requirementId: 'read_requirement', targetHandle: 'file_handle' }]);
    expect(JSON.stringify(f.offer)).not.toContain('synthetic.txt');
    const raw = JSON.stringify(read), result = f.gateway.accept(f.offer.offerId, raw);
    expect(result).toMatchObject({ status: 'accepted', authority: 'none', proposal: {
      kind: 'read', requirementId: 'read_requirement', request: candidates[0]!.request,
    } });
    expect(f.gateway.accept(f.offer.offerId, raw)).toEqual(result);
    expect(f.gateway.accept(f.offer.offerId, JSON.stringify({ kind: 'request-completion' }))).toEqual({ status: 'rejected', code: 'offer-already-consumed' });
    if (result.status === 'accepted' && result.proposal.kind === 'read') result.proposal.request.relativePath = 'changed';
    expect(f.gateway.accept(f.offer.offerId, raw)).toMatchObject({ proposal: { request: { relativePath: 'synthetic.txt' } } });
  });

  it('normalizes a JSON fence and only explicitly versioned inert fields without a repair call', async () => {
    const f = await fixture();
    const raw = '```json\n' + JSON.stringify({ kind: 'respond', text: 'Narrative only.', schemaVersion: ASTRA_READ_DECISION_VERSION, auditCorrelation: 'local_1' }) + '\n```';
    expect(f.gateway.accept(f.offer.offerId, raw)).toEqual({ status: 'accepted', authority: 'none',
      proposal: { kind: 'respond', text: 'Narrative only.' }, normalized: ['json-fence', 'checked-schema-version', 'inert-audit-correlation'] });
  });

  it.each(['capabilityId', 'input', 'arguments', 'target', 'approval', 'authorization', 'evidence', 'artifactIds', 'claimIds', 'unknownMetadata'])(
    'rejects %s in another branch, never stripping it as harmless metadata', async field => {
      const f = await fixture();
      expect(f.gateway.accept(f.offer.offerId, JSON.stringify({ kind: 'respond', text: 'done', [field]: 'extra' })))
        .toEqual({ status: 'rejected', code: 'branch-fields' });
    },
  );

  it.each([
    ['target', { ...read, targetHandle: 'different_file' }],
    ['goal', { ...read, requirementId: 'different_goal' }],
    ['capability', { ...read, capabilityHandle: 'execute_shell' }],
  ])('rejects model substitution of %s', async (_label, decision) => {
    const f = await fixture();
    expect(f.gateway.accept(f.offer.offerId, JSON.stringify(decision))).toEqual({ status: 'rejected', code: 'goal-target-binding' });
  });

  it.each([
    '{"kind":"respond","kind":"read"}',
    '{"kind":"respond","text":"a","te\\u0078t":"b"}',
    '{"kind":"respond","text":"a","extra":{"x":1,"x":2}}',
    '{"kind":"respond","text":"a","extra":[{"x":1,"x":2}]}',
  ])('rejects duplicate keys including escaped/nested forms (%#)', async raw => {
    const f = await fixture();
    expect(f.gateway.accept(f.offer.offerId, raw)).toEqual({ status: 'rejected', code: 'duplicate-key' });
  });

  it('treats completion as a request to the future Certifier, not a successful execution', async () => {
    const f = await fixture();
    const result = f.gateway.accept(f.offer.offerId, '{"kind":"request-completion"}');
    expect(result).toEqual({ status: 'accepted', authority: 'none', proposal: { kind: 'request-completion' }, normalized: [] });
    expect(JSON.stringify(result)).not.toContain('verified');
  });

  it('rejects stale or expired replies even if the same reply was accepted earlier', async () => {
    let current = true, now = 1000;
    const f = await fixture({ current: () => current, now: () => now });
    const raw = JSON.stringify(read);
    expect(f.gateway.accept(f.offer.offerId, raw).status).toBe('accepted');
    current = false; expect(f.gateway.accept(f.offer.offerId, raw)).toEqual({ status: 'rejected', code: 'stale-offer' });
    current = true; now = 2000; expect(f.gateway.accept(f.offer.offerId, raw)).toEqual({ status: 'rejected', code: 'stale-offer' });
  });

  it('requires the exact schema/catalog to have been included in the counted context', async () => {
    const f = await fixture();
    const changed = structuredClone(candidates); changed[0]!.request.relativePath = 'different.txt';
    expect(() => f.gateway.offer({ ...f.input, candidates: changed })).toThrow('catalog-context-binding');
    expect(() => f.gateway.offer({ ...f.input, executionId: 'other_execution' })).toThrow('context-binding');
    expect(() => f.gateway.offer({ ...f.input, context: { ...f.input.context, surface: 'changed' } })).toThrow('context-binding');
  });

  it('bounds outstanding offers and rejects overlarge model output without returning its contents', async () => {
    const f = await fixture();
    expect(f.gateway.accept(f.offer.offerId, 'x'.repeat(16385))).toEqual({ status: 'rejected', code: 'decision-size' });
    for (let count = 1; count < 32; count++) f.gateway.offer(f.input);
    expect(() => f.gateway.offer(f.input)).toThrow('offer-budget');
  });
});
