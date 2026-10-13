import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AstraAgentDecisionGateway, astraAgentCapabilityCatalog, astraAgentCatalogSurface, astraAgentDecisionSchema,
  astraAgentDecisionSurface,
  ASTRA_AGENT_DECISION_LIMITS, ASTRA_AGENT_MAX_ARGS_JSON_CHARS, astraAgentArgsJsonChars,
  type AstraAgentCapabilityCandidate, type AstraAgentCapabilityPage,
  type AstraAgentEvidenceRef } from '../../src/agent-v3/agent-decision-gateway';
import type { AstraContextPlan } from '../../src/agent-v3/context-engine';
import { astraJournalJson, type AstraJson } from '../../src/agent-v3/journal';

const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const candidates: AstraAgentCapabilityCandidate[] = [
  { handle: 'capability_a17', capabilityId: 'workspace.files.write', moduleId: 'workspace', title: 'Write file',
    description: 'Write exact UTF-8 content to an admitted path.', risk: 'write', inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'content'], properties: {
        path: { type: 'string' }, content: { type: 'string' },
      },
    } },
  { handle: 'capability_b29', capabilityId: 'workspace.root.get', moduleId: 'workspace', title: 'Workspace root',
    description: 'Return the current workspace root.', risk: 'read', inputSchema: {
      type: 'object', additionalProperties: false, properties: {},
    } },
];
const evidence: AstraAgentEvidenceRef[] = [{ ref: 'receipt_1', digest: 'sha256:' + 'a'.repeat(64), summary: 'File write acknowledged.' }];

function plan(items = candidates, receipts = evidence, pages: AstraAgentCapabilityPage[] = [], minimumCompletionEvidence?: number): AstraContextPlan {
  const mandatory = [
    { kind: 'goal', ref: 'goal', text: 'Create the requested artifact.' },
    { kind: 'authority', ref: 'authority', text: 'Model output has no execution authority.' },
    { kind: 'workflow', ref: 'workflow', text: 'Choose one admitted capability or complete from receipts.' },
    { kind: 'budget', ref: 'budget', text: 'One bounded decision.' },
    { kind: 'capability', ref: 'astra_agent_catalog', text: astraAgentCatalogSurface(items, receipts, pages, minimumCompletionEvidence) },
    { kind: 'capability', ref: 'astra_agent_decision_schema', text: astraAgentDecisionSurface(items, receipts, pages, minimumCompletionEvidence) },
  ];
  const surface = astraJournalJson({ schemaVersion: 'monarch.astra-v3-context-surface.internal.v1',
    executionId: 'agent_execution', sourceRevision: 3, mandatory, data: [] } as unknown as AstraJson);
  return { executionId: 'agent_execution', sourceRevision: 3, sourceDigest: sha('source'), surfaceDigest: sha(surface), surface,
    tokenCount: 500, utf8Bytes: Buffer.byteLength(surface), tokenizer: {
      driverGeneration: 'driver_generation', modelDigest: 'sha256:' + 'b'.repeat(64), tokenizerDigest: 'sha256:' + 'c'.repeat(64),
    }, budgetDigest: sha('budget'), omittedRefs: [], compaction: null };
}

describe('Astra V3 generic agent decision gateway', () => {
  it('maps an opaque model handle to one exact admitted capability without keyword activation', () => {
    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const offered = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(), candidates, evidence });
    const result = gateway.accept(offered.offerId, JSON.stringify({ kind: 'act', capabilityHandle: 'capability_a17',
      argsJson: JSON.stringify({ path: 'D:\\fixture\\page.html', content: '<main>готово</main>' }), reason: 'Нужен заявленный файл.' }));
    expect(result).toEqual({ status: 'accepted', authority: 'none', normalized: [], proposal: {
      kind: 'act', capabilityId: 'workspace.files.write',
      args: { path: 'D:\\fixture\\page.html', content: '<main>готово</main>' }, reason: 'Нужен заявленный файл.',
    } });
    expect(JSON.stringify(result)).not.toContain('создай файл');
  });

  it('lets a MAX agent write a source file past the local 4096-char argsJson limit', () => {
    // Live: DeepSeek could not write any game source file over 4096 characters
    // in one step and lost the task on the second identical rejection.
    expect(astraAgentArgsJsonChars('max-cloud:deepseek:deepseek-chat')).toBe(ASTRA_AGENT_MAX_ARGS_JSON_CHARS);
    expect(astraAgentArgsJsonChars('gemma4-balanced')).toBe(ASTRA_AGENT_DECISION_LIMITS.argsJson);
    const schema = astraJournalJson(astraAgentDecisionSchema(candidates, evidence, [], undefined, ASTRA_AGENT_MAX_ARGS_JSON_CHARS));
    expect(schema).toContain('"maxLength":12000');
    expect(astraJournalJson(astraAgentDecisionSchema(candidates, evidence))).toContain('"maxLength":4096');
    expect(() => astraAgentDecisionSchema(candidates, evidence, [], undefined, 50_000)).toThrow('args-json-limit');
    const content = 'const x = 1;\n'.repeat(700);
    const decision = JSON.stringify({ kind: 'act', capabilityHandle: 'capability_a17',
      argsJson: JSON.stringify({ path: 'D:\\fixture\\Game.js', content }), reason: 'Пишу модуль игры.',
      thought: 'Файл больше локального лимита, но в лимит MAX помещается.' });
    const surface = (chars?: number) => {
      const base = plan();
      const parsed = JSON.parse(base.surface) as { mandatory: Array<{ ref: string; text: string }> };
      parsed.mandatory.find(item => item.ref === 'astra_agent_decision_schema')!.text = astraAgentDecisionSurface(candidates, evidence, [], undefined, chars);
      const text = astraJournalJson(parsed as unknown as AstraJson);
      return { ...base, surface: text, surfaceDigest: sha(text), utf8Bytes: Buffer.byteLength(text) };
    };
    const local = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const localOffer = local.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7, context: plan(), candidates, evidence });
    expect(local.accept(localOffer.offerId, decision)).toMatchObject({ status: 'rejected' });
    const max = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const maxOffer = max.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: surface(ASTRA_AGENT_MAX_ARGS_JSON_CHARS), candidates, evidence, argsJsonChars: ASTRA_AGENT_MAX_ARGS_JSON_CHARS });
    expect(max.accept(maxOffer.offerId, decision)).toMatchObject({ status: 'accepted', proposal: { args: { content } } });
  });

  it("shows a MAX model's reasoning beside the step and never asks a local model for it", () => {
    const maxChars = ASTRA_AGENT_MAX_ARGS_JSON_CHARS;
    expect(astraJournalJson(astraAgentDecisionSchema(candidates, evidence))).not.toContain('thought');
    expect(astraAgentDecisionSurface(candidates, evidence)).not.toContain('thought');
    expect(astraJournalJson(astraAgentDecisionSchema(candidates, evidence, [], undefined, maxChars))).toContain('"thought"');
    expect(astraAgentDecisionSurface(candidates, evidence, [], undefined, maxChars)).toContain('"thought"');
    const base = plan();
    const parsed = JSON.parse(base.surface) as { mandatory: Array<{ ref: string; text: string }> };
    parsed.mandatory.find(item => item.ref === 'astra_agent_decision_schema')!.text = astraAgentDecisionSurface(candidates, evidence, [], undefined, maxChars);
    const text = astraJournalJson(parsed as unknown as AstraJson);
    const context = { ...base, surface: text, surfaceDigest: sha(text), utf8Bytes: Buffer.byteLength(text) };
    const decide = (extra: Record<string, unknown>) => {
      const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
      const { offerId } = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7, context,
        candidates, evidence, argsJsonChars: maxChars });
      return gateway.accept(offerId, JSON.stringify({ kind: 'act', capabilityHandle: 'capability_a17',
        argsJson: JSON.stringify({ path: 'D:\\fixture\\a.txt', content: 'x' }), reason: 'Записываю файл.', ...extra }));
    };
    expect(decide({ thought: 'Файл пуст, значит можно писать сразу.' })).toMatchObject({ status: 'accepted',
      proposal: { reason: 'Записываю файл.', thought: 'Файл пуст, значит можно писать сразу.' } });
    // Display-only: a reply without it still acts, never a lost repair turn.
    expect(decide({})).toMatchObject({ status: 'accepted', proposal: { reason: 'Записываю файл.' } });
    expect((decide({}) as { proposal: object }).proposal).not.toHaveProperty('thought');
  });

  it('measures reason in characters, as the schema promises the model', () => {
    // 1000 Cyrillic characters are 2000 UTF-8 bytes and fit the schema's maxLength.
    const reason = 'я'.repeat(ASTRA_AGENT_DECISION_LIMITS.reason);
    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const { offerId } = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7, context: plan(), candidates, evidence });
    expect(gateway.accept(offerId, JSON.stringify({ kind: 'act', capabilityHandle: 'capability_a17',
      argsJson: JSON.stringify({ path: 'D:\\fixture\\a.txt', content: 'x' }), reason })))
      .toMatchObject({ status: 'accepted', proposal: { reason } });
  });

  it('never lets a page description stop mid-command and read as absence', () => {
    // Measured live: the workspace page description was cut at 160 bytes and
    // ended mid-word at "Read f". "Write file" is the twelfth of sixteen
    // commands, so the agent reported — truthfully, from what it was shown —
    // that Monarch has no way to write a file, right after it had created the
    // folder the file was meant to go in.
    const workspace = ['Append file', 'Copy file or directory', 'Permanently delete file',
      'Inspect files in deterministic pages', 'List files', 'Create directory',
      'Move file or directory', 'Read file', 'Replace file text', 'Search files',
      'Move file or directory to Recycle Bin', 'Write file',
      'Resolve a Windows known folder', 'Write file in a known user folder',
      'Get workspace root', 'Audit local storage'];
    const candidates = workspace.map((title, index): AstraAgentCapabilityCandidate => ({
      handle: `opaque_capability_${index}`, capabilityId: `workspace.command.${index}`,
      moduleId: 'workspace', title, description: `${title} description.`, risk: 'write',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    }));
    // One more module so the catalog exceeds the inline budget and pages at all.
    const other = Array.from({ length: 4 }, (_, index): AstraAgentCapabilityCandidate => ({
      handle: `opaque_mail_${index}`, capabilityId: `mail.command.${index}`, moduleId: 'mail',
      title: `Mail ${index}`, description: 'Mail command.', risk: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    }));
    const catalog = astraAgentCapabilityCatalog([...candidates, ...other]);
    const root = catalog.pages.find(page => page.title === 'workspace' && !page.parentPageId);

    expect(root?.description).toContain('Write file');
    // Whole entries only: no half word can pass for a missing command.
    expect(root?.description.endsWith('Read f')).toBe(false);
    for (const page of catalog.pages) {
      const entries = page.description.split('; ');
      // A trimmed list has to say so, so the model expands instead of concluding.
      if (/\+\d+ more/u.test(page.description)) {
        expect(page.description).toContain('expand to list them');
      }
      expect(entries.every(entry => entry.length > 0)).toBe(true);
    }
  });

  it('lets the model expand a semantic host page without matching activation words', () => {
    const large = Array.from({ length: 17 }, (_, index): AstraAgentCapabilityCandidate => ({
      handle: `opaque_capability_${index}`, capabilityId: `service.operation.${index}`, moduleId: index < 9 ? 'mail' : 'workspace',
      title: `Operation ${index}`, description: `Live operation ${index}.`, risk: 'read',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    }));
    const catalog = astraAgentCapabilityCatalog(large);
    const roots = catalog.pages.filter(page => !page.parentPageId);
    expect(roots).toHaveLength(2);
    expect(catalog.pages.flatMap(page => page.candidateHandles).sort())
      .toEqual(large.map(item => item.handle).sort());
    expect(catalog.pages.every(page => Buffer.byteLength(page.description) <= 2048)).toBe(true);
    expect(catalog.pages.every(page => /^catalog_[a-f0-9]{24}$/u.test(page.handle))).toBe(true);
    expect(roots.every(page => page.description.length > 0)).toBe(true);
    expect(roots.find(page => page.title === 'workspace')?.description).toContain('Operation 9');
    const indexSchema = astraAgentDecisionSchema([], [], roots) as { oneOf: Array<{ properties: { kind: { const: string } } }> };
    expect(indexSchema.oneOf.map(branch => branch.properties.kind.const)).toEqual(['expand', 'complete']);
    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const offered = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 8,
      context: plan([], [], roots), candidates: [], pages: roots, evidence: [] });
    const page = roots[1]!;
    expect(gateway.accept(offered.offerId, JSON.stringify({ kind: 'expand', pageHandle: page.handle })))
      .toEqual({ status: 'accepted', authority: 'none', normalized: [], proposal: { kind: 'expand', pageId: page.pageId } });
  });

  it('keeps the native schema host-side and gives a 4K model one compact semantic action surface', () => {
    const annotated = structuredClone(candidates[0]!);
    annotated.inputSchema = {
      ...annotated.inputSchema,
      title: 'Host annotation that is not required for the model action.',
      description: 'x'.repeat(1000),
      default: { path: 'never-authoritative' },
      examples: [{ path: 'never-authoritative' }],
      properties: {
        path: { type: 'string', description: 'Exact admitted target path. '.repeat(20) },
        content: { type: 'string', description: 'Requested UTF-8 content. '.repeat(20) },
      },
    };
    const catalog = astraAgentCatalogSurface([annotated], evidence);
    const decision = astraAgentDecisionSurface([annotated], evidence);
    expect(catalog).not.toContain('workspace.files.write');
    expect(catalog).not.toContain('never-authoritative');
    expect(catalog).toContain('Exact admitted target path');
    expect(catalog).toContain('receipt_1');
    expect(Buffer.byteLength(catalog)).toBeLessThan(1_500);
    expect(Buffer.byteLength(decision)).toBeLessThan(Buffer.byteLength(
      astraJournalJson(astraAgentDecisionSchema([annotated], evidence)),
    ));
  });

  it('states the per-field character ceilings the schema enforces', () => {
    // A remote strict-schema provider validates the finished JSON, so a `complete.text`
    // over the limit is not a truncated answer: the generation is rejected and the task
    // dies with a provider error. The model can only avoid that if it is told the limit.
    const surface = astraAgentDecisionSurface(candidates, evidence);
    const schema = astraJournalJson(astraAgentDecisionSchema(candidates, evidence));
    expect(surface).toContain('"maxChars"');
    expect(surface).toContain(String(ASTRA_AGENT_DECISION_LIMITS.text));
    expect(surface).toContain('name what remains');
    expect(schema).toContain('"maxLength":' + ASTRA_AGENT_DECISION_LIMITS.text);
  });

  it('rejects invented capability identifiers and handle/branch smuggling', () => {
    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const first = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(), candidates, evidence });
    expect(gateway.accept(first.offerId, JSON.stringify({ kind: 'act', capabilityHandle: 'workspace.files.delete',
      argsJson: '{}', reason: 'invented' }))).toMatchObject({ status: 'rejected', code: 'capability-handle' });
    const second = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(), candidates, evidence });
    expect(gateway.accept(second.offerId, JSON.stringify({ kind: 'act', capabilityHandle: 'capability_b29',
      capabilityId: 'workspace.files.write', argsJson: '{}', reason: 'smuggled' }))).toMatchObject({ status: 'rejected', code: 'branch-fields' });
  });

  it('requires a completion to cite an exact retained receipt once effects exist', () => {
    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const missing = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(), candidates, evidence });
    expect(gateway.accept(missing.offerId, JSON.stringify({ kind: 'complete', text: 'Готово.', evidenceRef: 'none' })))
      .toMatchObject({ status: 'rejected', code: 'completion-evidence' });
    const exact = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(), candidates, evidence });
    expect(gateway.accept(exact.offerId, JSON.stringify({ kind: 'complete', text: 'Файл создан.', evidenceRef: 'receipt_1' })))
      .toMatchObject({ status: 'accepted', authority: 'none', proposal: { kind: 'complete', evidenceRefs: ['receipt_1'] } });
  });

  it('does not count retries of one capability as evidence for several required outputs', () => {
    const receipts: AstraAgentEvidenceRef[] = [
      { ref: 'receipt_1', digest: 'sha256:' + '1'.repeat(64), summary: 'Gmail unavailable.', group: 'gmail.connection.status' },
      { ref: 'receipt_2', digest: 'sha256:' + '2'.repeat(64), summary: 'Gmail retry unavailable.', group: 'gmail.connection.status' },
      { ref: 'receipt_3', digest: 'sha256:' + '3'.repeat(64), summary: 'GitHub unavailable.', group: 'github.connection.status' },
    ];
    const minimum = 3;
    const schema = astraAgentDecisionSchema(candidates, receipts, [], minimum) as {
      oneOf: Array<{ properties: { kind: { const: string } } }>;
    };
    expect(schema.oneOf.map(item => item.properties.kind.const)).not.toContain('complete');
    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const offered = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(candidates, receipts, [], minimum), candidates, evidence: receipts,
      minimumCompletionEvidence: minimum });
    expect(gateway.accept(offered.offerId, JSON.stringify({ kind: 'complete', text: 'Все три сервиса проверены.',
      evidenceRefs: ['receipt_2', 'receipt_3'] }))).toMatchObject({ status: 'rejected', code: 'completion-evidence' });

    const completeReceipts = [...receipts,
      { ref: 'receipt_4', digest: 'sha256:' + '4'.repeat(64), summary: 'Calendar unavailable.', group: 'calendar.connection.status' }];
    const ready = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const readyOffer = ready.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 8,
      context: plan(candidates, completeReceipts, [], minimum), candidates, evidence: completeReceipts,
      minimumCompletionEvidence: minimum });
    expect(ready.accept(readyOffer.offerId, JSON.stringify({ kind: 'complete', text: 'Все три сервиса проверены.',
      evidenceRefs: ['receipt_2', 'receipt_3', 'receipt_4'] }))).toMatchObject({ status: 'accepted', proposal: {
        evidenceRefs: ['receipt_2', 'receipt_3', 'receipt_4'],
      } });
  });

  it('does not let a concrete capability page masquerade as fresh runtime evidence', () => {
    const concreteCandidates = [candidates[1]!];
    const concretePages: AstraAgentCapabilityPage[] = [{ handle: 'catalog_concrete_page', pageId: 'page_concrete',
      title: 'Connections', description: 'Inspect current connections.', candidateHandles: concreteCandidates.map(item => item.handle) }];
    const schema = astraAgentDecisionSchema(concreteCandidates, [], concretePages) as {
      oneOf: Array<{ properties: { kind: { const: string } } }>;
    };
    expect(schema.oneOf.map(item => item.properties.kind.const)).toEqual(['act', 'expand', 'ask-user']);
    expect(JSON.stringify(schema.oneOf[0])).toContain('"args"');
    expect(JSON.stringify(schema.oneOf[0])).not.toContain('argsJson');
    expect(astraAgentCatalogSurface(concreteCandidates, [], concretePages)).toContain('presence does not prove current connection');
    expect(astraAgentDecisionSurface(concreteCandidates, [], concretePages)).not.toContain('"kind":"complete"');

    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => true });
    const offered = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(concreteCandidates, [], concretePages), candidates: concreteCandidates, pages: concretePages, evidence: [] });
    expect(gateway.accept(offered.offerId, JSON.stringify({ kind: 'complete', text: 'Gmail доступен.', evidenceRef: 'none' })))
      .toMatchObject({ status: 'rejected', code: 'completion-evidence' });
    const action = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(concreteCandidates, [], concretePages), candidates: concreteCandidates, pages: concretePages, evidence: [] });
    expect(gateway.accept(action.offerId, JSON.stringify({ kind: 'act', capabilityHandle: candidates[1]!.handle,
      args: {}, reason: 'Inspect current state.' }))).toMatchObject({ status: 'accepted', proposal: {
        kind: 'act', capabilityId: candidates[1]!.capabilityId, args: {},
      } });
  });

  it('binds decisions to the current source, catalog, evidence and exact Context surface', () => {
    let current = true;
    const gateway = new AstraAgentDecisionGateway({ isCurrent: () => current });
    const offer = gateway.offer({ executionId: 'agent_execution', controlEpoch: 2, catalogRevision: 7,
      context: plan(), candidates, evidence });
    current = false;
    expect(gateway.accept(offer.offerId, JSON.stringify({ kind: 'ask-user', question: 'Уточни путь.' })))
      .toEqual({ status: 'rejected', code: 'stale-offer' });
    const invalid = structuredClone(plan());
    invalid.surface = invalid.surface.replace('Write file', 'Changed title');
    invalid.surfaceDigest = sha(invalid.surface); invalid.utf8Bytes = Buffer.byteLength(invalid.surface);
    expect(() => new AstraAgentDecisionGateway({ isCurrent: () => true }).offer({ executionId: 'agent_execution',
      controlEpoch: 2, catalogRevision: 7, context: invalid, candidates, evidence }))
      .toThrow('catalog-context-binding');
  });
});
