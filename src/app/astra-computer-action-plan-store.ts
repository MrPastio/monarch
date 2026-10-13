import { AstraJournal, astraJournalJson } from '../agent-v3/journal';
import { modelReadDigest as digest, modelReadIdentity as id, modelReadJson as json } from '../agent-v3/model-read-task-state';
import type { AstraComputerObservation } from '../agent-v3/computer-observe-work-adapter';
import type { AstraComputerAction } from '../agent-v3/computer-action-work-adapter';
import { validateComputerTextInput, validateComputerWindowSelection } from '../modules/computer/native-bridge';
import { COMPUTER_WINDOW_KEY_VALUES } from '../modules/computer/manifest';
import type { AstraAuthenticatedHttpActor, AstraComputerActionPlanCatalog, AstraComputerActionPlanSnapshot,
  AstraComputerSelectionSnapshot, AstraTaskSourceContext } from './astra-task-facade';

type Principal = { actor: AstraAuthenticatedHttpActor; conversationId: string };
interface Issue extends Principal { requestId: string; source: AstraComputerSelectionSnapshot;
  observation: AstraComputerObservation; action: AstraComputerAction; ttlMs: number; timeoutMs: number }
interface Record { schemaVersion: 'monarch.astra-computer-action-plan.internal.v1'; configDigest: string;
  selectionId: string; input: Issue; inputDigest: string; issuedAt: number; expiresAt: number; revoked: boolean }
interface Index { schemaVersion: 'monarch.astra-computer-action-plan-index.internal.v1'; configDigest: string; plans: string[] }
export interface AstraComputerActionPlanDescriptor { selectionId: string; title: string; summary: string; expiresAt: number;
  authority: 'approval-required'; grantScope: 'none' }

function check(value: unknown, code: string, statusCode = 409): asserts value {
  if (!value) throw Object.assign(Error('astra-computer-action-plan:' + code), { statusCode, code: 'astra-computer-action-plan-' + code });
}
function principal(value: Principal): void { check(value && id(value.conversationId) && value.actor
  && Object.keys(value.actor).length === 2 && /^sha256:[a-f0-9]{64}$/u.test(value.actor.id)
  && value.actor.source === 'desktop', 'principal', 403); }
const fields = (value: object, allowed: string[]) => Object.keys(value).length === allowed.length
  && Object.keys(value).every(key => allowed.includes(key));

/** Durable host-issued proposal, never permission. It stores only the selected
 * element's eligibility flags rather than duplicating the full UIA tree. The
 * exact action still requires the normal one-use Kernel policy confirmation. */
export class AstraComputerActionPlanStore implements AstraComputerActionPlanCatalog {
  private readonly configDigest: string; private readonly indexId: string; private readonly limit: number;
  constructor(private readonly options: { deployment: 'isolated-validation'; journal: AstraJournal; scopeId: string;
    maxPlans?: number; now?: () => number; onRevoked?: () => void }) {
    this.limit = options.maxPlans ?? 16;
    check(options.deployment === 'isolated-validation' && id(options.scopeId)
      && Number.isSafeInteger(this.limit) && this.limit >= 1 && this.limit <= 32, 'configuration');
    this.configDigest = digest({ scopeId: options.scopeId, version: 1, compactObservation: true, limit: this.limit });
    this.indexId = 'computer_action_plan_index_' + digest(options.scopeId).slice(7, 39);
    if (!options.journal.read(this.indexId)) options.journal.appendAtomic({ primary: { streamId: this.indexId, requestId: 'initialize', expectedRevision: 0,
      reservationId: this.indexId, checkpoint: json({ schemaVersion: 'monarch.astra-computer-action-plan-index.internal.v1',
        configDigest: this.configDigest, plans: [] }), events: [{ type: 'computer-action-plan.index-initialized' }] },
      reserve: [{ id: this.indexId, allocations: [{ streamId: this.indexId, commits: this.limit + 1,
        eventBytes: 512 * (this.limit + 1), checkpointBytes: 4096 }] }] });
    this.index();
  }
  usesJournal(journal: AstraJournal): boolean { return this.options.journal === journal; }
  issue(raw: Issue, guard: () => boolean): AstraComputerActionPlanDescriptor {
    const input = this.input(raw); check(guard(), 'source-changed');
    const selectionId = this.key(input.requestId, input), previous = this.options.journal.read(selectionId);
    if (previous) { const record = this.record(selectionId); check(record.inputDigest === digest(input), 'request-conflict');
      this.active(record); return this.descriptor(record); }
    const before = this.options.journal.read(this.indexId)!, index = this.index();
    check(index.plans.length < this.limit, 'cohort-capacity', 429);
    const issuedAt = this.now(), record: Record = { schemaVersion: 'monarch.astra-computer-action-plan.internal.v1', configDigest: this.configDigest,
      selectionId, input, inputDigest: digest(input), issuedAt, expiresAt: Math.min(input.source.expiresAt, issuedAt + input.ttlMs), revoked: false };
    check(record.expiresAt > issuedAt && Number.isSafeInteger(record.expiresAt), 'expiry');
    const plans = [...index.plans, selectionId];
    this.options.journal.appendAtomic({ primary: { streamId: selectionId, requestId: 'issue', expectedRevision: 0, reservationId: selectionId,
      checkpoint: json(record), events: [{ type: 'computer-action-plan.issued', inputDigest: record.inputDigest }] },
      additional: [{ streamId: this.indexId, requestId: selectionId, expectedRevision: before.revision, reservationId: this.indexId,
        checkpoint: json({ ...index, plans }), events: [{ type: 'computer-action-plan.indexed', selectionId }] }],
      reserve: [{ id: selectionId, allocations: [{ streamId: selectionId, commits: 2, eventBytes: 1024,
        checkpointBytes: Buffer.byteLength(astraJournalJson(json(record))) + 512 }] }] }, guard);
    return this.descriptor(record);
  }
  resolve(selectionId: string, context: AstraTaskSourceContext): AstraComputerActionPlanSnapshot {
    const record = this.owned(selectionId, context); this.active(record); const input = record.input;
    return { selectionId, actor: structuredClone(input.actor), conversationId: input.conversationId, revision: 1,
      windowRef: input.source.windowRef, processId: input.source.processId, processInstanceId: input.source.processInstanceId,
      title: input.source.title, expiresAt: record.expiresAt, timeoutMs: input.timeoutMs,
      observation: structuredClone(input.observation), action: structuredClone(input.action) };
  }
  list(context: Principal): AstraComputerActionPlanDescriptor[] {
    principal(context); const now = this.now(); return this.index().plans.map(key => this.record(key))
      .filter(record => this.matches(record, context) && !record.revoked && now >= record.issuedAt && now < record.expiresAt).map(record => this.descriptor(record));
  }
  revoke(selectionId: string, context: Principal): void {
    const record = this.owned(selectionId, context);
    if (!record.revoked) this.options.journal.appendAtomic({ primary: { streamId: selectionId, requestId: 'revoke',
      expectedRevision: this.options.journal.read(selectionId)!.revision, reservationId: selectionId,
      checkpoint: json({ ...record, revoked: true }), events: [{ type: 'computer-action-plan.revoked' }] }, release: [selectionId] });
    this.options.onRevoked?.();
  }
  private input(raw: Issue, requireActiveSource = true): Issue {
    const input = structuredClone(raw); principal(input);
    check(fields(input, ['actor', 'conversationId', 'requestId', 'source', 'observation', 'action', 'ttlMs', 'timeoutMs']) && id(input.requestId)
      && Number.isSafeInteger(input.ttlMs) && input.ttlMs >= 1000 && input.ttlMs <= 90000
      && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs >= 50 && input.timeoutMs <= 10000, 'request');
    const source = input.source; check(source && fields(source, ['selectionId', 'actor', 'conversationId', 'revision', 'windowRef', 'processId',
      'processInstanceId', 'title', 'expiresAt', 'timeoutMs']) && id(source.selectionId) && digest(source.actor) === digest(input.actor)
      && source.conversationId === input.conversationId && Number.isSafeInteger(source.revision) && source.revision > 0
      && Number.isSafeInteger(source.expiresAt) && (!requireActiveSource || source.expiresAt > this.now())
      && Number.isSafeInteger(source.timeoutMs) && source.timeoutMs >= 50 && source.timeoutMs <= 10000
      && /^hwnd:[0-9a-fA-F]{1,16}$/u.test(source.windowRef), 'source');
    validateComputerWindowSelection({ processId: source.processId, processInstanceId: source.processInstanceId, title: source.title });
    const observation = input.observation; check(observation && observation.authority === 'none' && observation.authorizesInput === false
      && observation.temporalSemantics === 'snapshot-at-capture' && observation.windowRef === source.windowRef
      && observation.processId === source.processId && observation.processInstanceId === source.processInstanceId && observation.title === source.title
      && /^computer-observation-[0-9a-f-]{36}$/u.test(observation.observationId) && Number.isFinite(Date.parse(observation.observedAt))
      && Date.parse(observation.observedAt) <= this.now() + 1000 && /^sha256:[a-f0-9]{64}$/u.test(observation.screenshotDigest)
      && typeof observation.truncated === 'boolean' && Number.isSafeInteger(observation.omittedPasswordElements)
      && observation.omittedPasswordElements >= 0 && Array.isArray(observation.elements) && observation.elements.length <= 128
      && Buffer.byteLength(astraJournalJson(json(observation))) <= 65536, 'observation');
    const action = input.action; check(action && typeof action === 'object' && !Array.isArray(action), 'action');
    if (action.kind === 'type') { check(fields(action, ['kind', 'elementId', 'text', 'textMode']), 'action'); validateComputerTextInput(action.text, action.textMode); }
    else if (action.kind === 'click') check(fields(action, ['kind', 'elementId', 'button', 'clicks'])
      && ['left', 'right', 'middle'].includes(action.button) && [1, 2].includes(action.clicks), 'action');
    else if (action.kind === 'scroll') check(fields(action, ['kind', 'elementId', 'deltaY'])
      && Number.isSafeInteger(action.deltaY) && action.deltaY !== 0 && Math.abs(action.deltaY) <= 1200, 'action');
    else if (action.kind === 'key') check(fields(action, ['kind', 'key', 'modifiers']) && (COMPUTER_WINDOW_KEY_VALUES as readonly string[]).includes(action.key)
      && Array.isArray(action.modifiers) && action.modifiers.length <= 3 && new Set(action.modifiers).size === action.modifiers.length
      && action.modifiers.every(value => ['ctrl', 'alt', 'shift'].includes(value)), 'action');
    else check(action.kind === 'close' && fields(action, ['kind']), 'action');
    if ('elementId' in action) {
      check(typeof action.elementId === 'string' && action.elementId.length >= 2 && action.elementId.length <= 100, 'element');
      const matches = observation.elements.filter(value => value && typeof value === 'object' && !Array.isArray(value)
        && (value as { [key: string]: unknown }).elementId === action.elementId) as { [key: string]: unknown }[];
      check(matches.length === 1 && matches[0]!.enabled === true && matches[0]!.offscreen === false && matches[0]!.password !== true, 'element');
      if (action.kind === 'type') check(matches[0]!.controlType === 'Edit'
        || Array.isArray(matches[0]!.patterns) && matches[0]!.patterns.includes('value'), 'text-element');
      input.observation.elements = [{ elementId: action.elementId, enabled: true, offscreen: false, password: false,
        ...(action.kind === 'type' && matches[0]!.controlType === 'Edit' ? { controlType: 'Edit' }
          : action.kind === 'type' ? { patterns: ['value'] } : {}) }];
    } else input.observation.elements = [];
    check(Buffer.byteLength(astraJournalJson(json(input))) <= 16384, 'retained-budget'); return input;
  }
  private index(): Index { const index = this.options.journal.read(this.indexId)?.checkpoint as unknown as Index;
    check(index?.schemaVersion === 'monarch.astra-computer-action-plan-index.internal.v1' && index.configDigest === this.configDigest
      && fields(index, ['schemaVersion', 'configDigest', 'plans']) && Array.isArray(index.plans) && index.plans.length <= this.limit
      && index.plans.every(key => /^computer_action_plan_[a-f0-9]{32}$/u.test(key)) && new Set(index.plans).size === index.plans.length, 'index'); return index; }
  private record(selectionId: string): Record { const record = this.options.journal.read(selectionId)?.checkpoint as unknown as Record; check(record, 'not-found', 404);
    check(record.schemaVersion === 'monarch.astra-computer-action-plan.internal.v1' && record.configDigest === this.configDigest
      && fields(record, ['schemaVersion', 'configDigest', 'selectionId', 'input', 'inputDigest', 'issuedAt', 'expiresAt', 'revoked'])
      && record.selectionId === selectionId && record.inputDigest === digest(record.input) && typeof record.revoked === 'boolean'
      && Number.isSafeInteger(record.issuedAt) && record.issuedAt > 0 && Number.isSafeInteger(record.expiresAt)
      && record.expiresAt === Math.min(record.input.source.expiresAt, record.issuedAt + record.input.ttlMs)
      && selectionId === this.key(record.input.requestId, record.input), 'record'); this.input(record.input, false); return record; }
  private owned(selectionId: string, context: Principal): Record { principal(context); check(/^computer_action_plan_[a-f0-9]{32}$/u.test(selectionId), 'not-found', 404);
    const record = this.record(selectionId); check(this.matches(record, context), 'not-found', 404); return record; }
  private matches(record: Record, context: Principal): boolean { return digest(record.input.actor) === digest(context.actor)
    && record.input.conversationId === context.conversationId; }
  private key(requestId: string, context: Principal): string { return 'computer_action_plan_' + digest({ config: this.configDigest,
    requestId, actor: context.actor, conversationId: context.conversationId }).slice(7, 39); }
  private active(record: Record): void { const now = this.now(); check(!record.revoked && now >= record.issuedAt && now < record.expiresAt, 'unavailable'); }
  private now(): number { const now = (this.options.now ?? Date.now)(); check(Number.isSafeInteger(now) && now > 0, 'clock'); return now; }
  private descriptor(record: Record): AstraComputerActionPlanDescriptor { return { selectionId: record.selectionId, title: record.input.source.title,
    summary: summary(record.input.action), expiresAt: record.expiresAt, authority: 'approval-required', grantScope: 'none' }; }
}

function summary(action: AstraComputerAction): string {
  if (action.kind === 'type') return action.textMode === 'replace' ? 'Заменить значение выбранного поля' : 'Вставить текст в выбранное поле';
  if (action.kind === 'click') return `Клик ${action.button}, ${action.clicks} раз`;
  if (action.kind === 'scroll') return `Прокрутить выбранную область на ${action.deltaY}`;
  if (action.kind === 'key') return `Нажать ${[...action.modifiers, action.key].join(' + ')}`;
  return 'Закрыть выбранное окно';
}
