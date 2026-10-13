import { createHash, randomUUID } from 'node:crypto';
import type { MonarchExecutionResult } from '../core/contracts';
import type { MonarchKernel } from '../core/kernel';
import { astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';
import type { AstraWorkAdapter, AstraWorkControl, AstraWorkResult } from './work-scheduler';
import { validateComputerWindowSelection } from '../modules/computer/native-bridge';

const CAPABILITY = 'computer.window.observe';
const digest = (value: unknown): string => 'sha256:' + createHash('sha256').update(astraJournalJson(json(value))).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value));
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-computer-observe:' + code); }
export interface AstraComputerWindowSelection {
  id: string; windowRef: string; processId: number; processInstanceId: string; title: string; expiresAt: number;
  /** Trusted original source, not window text or a model-selected handle. */
  source: { conversationId: string; inputMessageId: string; userText: string };
}
interface Input { selectionId: string; timeoutMs: number; workId: string }
export interface AstraComputerObservation {
  authority: 'none'; authorizesInput: false; temporalSemantics: 'snapshot-at-capture';
  observationId: string; observedAt: string; windowRef: string; processId: number; processInstanceId: string; title: string;
  screenshotDigest: string; truncated: boolean; omittedPasswordElements: number; elements: AstraJson[];
}
interface Checkpoint {
  schemaVersion: 'monarch.astra-v3-computer-observe.internal.v1'; workId: string; inputDigest: string;
  phase: 'ready' | 'dispatching' | 'settled'; desired: 'run' | 'pause' | 'cancel'; quiescent: boolean;
  invocation?: { proposalHash: string; idempotencyKey: string; startedAt: number }; observation?: AstraComputerObservation; reason?: string;
}

/** First Computer Use pack on the SAME scheduler/Kernel. One trusted host-selected
 * window, no enumeration, input, vision/model call or default activation. Evidence
 * is historical untrusted data, never a reusable permission to click/type. */
export class AstraComputerObserveWorkAdapter implements AstraWorkAdapter {
  readonly id = 'computer-observe'; readonly version = 'v1';
  private readonly selection: AstraComputerWindowSelection;
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: { deployment: 'isolated-validation'; kernel: MonarchKernel; journal: AstraJournalAccess;
    selection: AstraComputerWindowSelection; isSourceCurrent: () => boolean }) {
    check(options.deployment === 'isolated-validation', 'isolated-only');
    const s = structuredClone(options.selection); validateComputerWindowSelection({ processId: s.processId,
      processInstanceId: s.processInstanceId, title: s.title });
    check(identity(s.id) && /^hwnd:[0-9a-fA-F]{1,16}$/u.test(s.windowRef) && Number.isSafeInteger(s.expiresAt)
      && identity(s.source?.conversationId) && identity(s.source?.inputMessageId)
      && typeof s.source.userText === 'string' && s.source.userText.trim().length > 0 && Buffer.byteLength(s.source.userText) <= 8192, 'selection');
    this.selection = s;
  }
  compile(raw: AstraJson, context: { jobId: string; scopeId: string; controlBudget: number }): ReturnType<AstraWorkAdapter['compile']> {
    const workId = 'computer_observe_' + digest([context.scopeId, context.jobId]).slice(7, 39);
    check(raw && typeof raw === 'object' && !Array.isArray(raw)
      && Object.keys(raw).every(key => ['selectionId', 'timeoutMs', 'workId'].includes(key)), 'input');
    check(raw.selectionId === this.selection.id && (raw.workId === undefined || raw.workId === workId), 'source-binding');
    const timeoutMs = raw.timeoutMs ?? 10000;
    check(Number.isSafeInteger(timeoutMs) && Number(timeoutMs) >= 50 && Number(timeoutMs) <= 10000, 'timeout');
    check(this.current(), 'source-stale');
    const input = { selectionId: this.selection.id, timeoutMs: Number(timeoutMs), workId };
    const commits = 12 + 4 * context.controlBudget;
    return { input: json(input), bindingDigest: this.binding(true), activationBudgetMs: Number(timeoutMs) + 1000,
      resources: { kernelSlots: 1, modelSlots: 0, declaredBytes: 8 * 1024 * 1024,
        exclusiveKeys: ['computer_window_' + digest(this.selection.windowRef).slice(7)] },
      storage: { maxActivations: 4 + 2 * context.controlBudget,
        streams: [{ streamId: workId, commits, eventBytes: commits * 1024, checkpointBytes: 73728 }] } };
  }
  async execute(raw: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult> {
    const input = this.input(raw), journal = control.journal;
    check(control.isCurrent(), 'activation-fenced');
    let before = this.admit(input, journal, control.ownerIsCurrent);
    if (before.checkpoint.phase !== 'ready' || before.checkpoint.desired !== 'run') return this.project(before);
    const binding = this.binding();
    const current = () => { try { return control.isCurrent() && this.current() && this.binding() === binding; } catch { return false; } };
    if (!current()) return this.project(this.save(input, journal, before, { ...before.checkpoint, phase: 'settled', reason: 'source-stale' }, control.ownerIsCurrent));
    const proposal = this.options.kernel.prepareActionProposal({ capabilityId: CAPABILITY, proposalId: input.workId,
      args: { windowRef: this.selection.windowRef, captureNonce: input.workId,
        selectionBinding: { processId: this.selection.processId, processInstanceId: this.selection.processInstanceId, title: this.selection.title } },
      reason: 'Astra V3 host-selected exact-window observation.' },
    { requestedBy: 'agent:astra-v3', intentId: input.workId, originatingUserText: this.selection.source.userText });
    before = this.save(input, journal, before, { ...before.checkpoint, phase: 'dispatching', quiescent: false,
      invocation: { proposalHash: proposal.canonicalHash, idempotencyKey: proposal.idempotencyKey, startedAt: Date.now() } }, current);
    const controller = new AbortController(); this.active.set(input.workId, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = this.options.kernel.executeActionProposal(proposal, { requestedBy: 'agent:astra-v3', intentId: input.workId,
      source: 'desktop', originatingUserText: this.selection.source.userText, signal: AbortSignal.any([control.signal, controller.signal]), dispatchGuard: current,
    }).then(returned => {
      const fresh = this.read(input, journal)!;
      if (!control.ownerIsCurrent() || fresh.checkpoint.phase !== 'dispatching') return this.project(fresh);
      check(returned.proposal.canonicalHash === fresh.checkpoint.invocation!.proposalHash, 'proposal-binding');
      return this.settle(input, journal, fresh, returned.result, control.ownerIsCurrent);
    }, () => this.project(this.read(input, journal)!)).finally(() => {
      if (this.active.get(input.workId) === controller) this.active.delete(input.workId);
    });
    try {
      return await Promise.race([completion, new Promise<AstraWorkResult>((resolve, reject) => { timer = setTimeout(() => {
        controller.abort('observation-deadline'); try { resolve(this.project(this.read(input, journal)!)); } catch (error) { reject(error); }
      }, input.timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  control(raw: AstraJson, command: 'pause' | 'resume' | 'cancel', owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.admit(input, journal, owner), cp = before.checkpoint;
    if (command === 'resume') check(cp.desired === 'pause' && cp.quiescent && this.current(), 'not-resumable');
    const desired = command === 'resume' ? 'run' : command;
    if (desired !== cp.desired) this.save(input, journal, before, { ...cp, desired,
      ...(command === 'cancel' && cp.phase === 'ready' ? { phase: 'settled' as const, reason: 'cancelled-before-capture' } : {}) }, owner);
    if (command === 'cancel') this.active.get(input.workId)?.abort('observation-cancelled');
    return this.project(this.read(input, journal)!);
  }
  reconcile(raw: AstraJson, owner: () => boolean, journal = this.options.journal): AstraWorkResult {
    const input = this.input(raw), before = this.admit(input, journal, owner);
    if (before.checkpoint.phase !== 'dispatching') return this.project(before);
    const record = this.receipt(input, before.checkpoint);
    if (!record?.result || !['completed', 'failed'].includes(record.status) || record.error === 'interrupted-before-completion'
      || record.result.error === 'interrupted-before-completion') return this.project(before);
    return this.settle(input, journal, before, record.result, owner);
  }
  inspect(raw: AstraJson) { return { ...this.read(this.input(raw), this.options.journal)!, nativeCompletionCertified: false as const }; }
  private settle(input: Input, journal: AstraJournalAccess, before: { revision: number; checkpoint: Checkpoint }, result: MonarchExecutionResult, owner: () => boolean): AstraWorkResult {
    let observation: AstraComputerObservation | undefined, reason: string | undefined;
    if (result.ok) {
      const record = this.receipt(input, before.checkpoint);
      check(record?.status === 'completed' && record.result?.ok && digest(record.result.output) === digest(result.output)
        && (result.metadata?.dispatchControl as { dispatched?: boolean } | undefined)?.dispatched === true, 'receipt-binding');
      try { observation = this.observation(result.output, before.checkpoint.invocation!.startedAt); } catch { reason = 'observation-evidence-invalid'; }
    } else reason = 'observation-unavailable';
    return this.project(this.save(input, journal, before, { ...before.checkpoint, phase: 'settled', quiescent: true,
      ...(observation ? { observation } : {}), ...(reason ? { reason } : {}) }, owner));
  }
  private observation(raw: unknown, startedAt: number): AstraComputerObservation {
    const value = raw as Record<string, any>;
    check(value?.verified === true && value.windowRef === this.selection.windowRef
      && value.window?.windowRef === this.selection.windowRef && value.window?.processId === this.selection.processId
      && value.window?.processInstanceId === this.selection.processInstanceId
      && value.window?.title === this.selection.title && value.selectionBinding?.processId === this.selection.processId
      && value.selectionBinding?.processInstanceId === this.selection.processInstanceId
      && value.selectionBinding?.title === this.selection.title && typeof value.observationId === 'string'
      && /^computer-observation-[0-9a-f-]{36}$/u.test(value.observationId)
      && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
      && Date.parse(value.observedAt) >= startedAt && Date.parse(value.observedAt) <= Date.now() + 1000
      && typeof value.screenshot?.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.screenshot.sha256)
      && typeof value.truncated === 'boolean' && Array.isArray(value.elements) && value.elements.length <= 128, 'observation-binding');
    let omittedPasswordElements = 0;
    const elements: AstraJson[] = [];
    for (const item of value.elements) {
      check(item && typeof item.password === 'boolean', 'element');
      if (item.password) { omittedPasswordElements++; continue; }
      const selected: Record<string, AstraJson> = {};
      for (const key of ['elementId', 'name', 'automationId', 'className', 'controlType']) {
        check(typeof item[key] === 'string' && item[key].length <= 4096, 'element-field'); selected[key] = item[key];
      }
      if (item.value !== undefined) { check(typeof item.value === 'string' && item.value.length <= 4096, 'element-value'); selected.value = item.value; }
      for (const key of ['enabled', 'offscreen', 'focused']) { check(typeof item[key] === 'boolean', 'element-state'); selected[key] = item[key]; }
      elements.push(selected);
    }
    const observation: AstraComputerObservation = { authority: 'none', authorizesInput: false, temporalSemantics: 'snapshot-at-capture',
      observationId: value.observationId, observedAt: value.observedAt, windowRef: this.selection.windowRef,
      processId: this.selection.processId, processInstanceId: this.selection.processInstanceId, title: this.selection.title,
      screenshotDigest: 'sha256:' + value.screenshot.sha256,
      truncated: value.truncated, omittedPasswordElements, elements };
    check(Buffer.byteLength(astraJournalJson(json(observation))) <= 65536, 'evidence-budget'); return observation;
  }
  private receipt(input: Input, cp: Checkpoint) {
    check(cp.invocation, 'invocation-missing'); const record = this.options.kernel.getActionLedgerRecord(cp.invocation.idempotencyKey);
    if (record) check(record.idempotencyKey === cp.invocation.idempotencyKey && record.proposalId === input.workId
      && record.intentId === input.workId && record.proposalHash === cp.invocation.proposalHash
      && record.capabilityId === CAPABILITY && record.moduleId === 'computer', 'receipt-binding'); return record;
  }
  private current(): boolean { try { return Date.now() < this.selection.expiresAt && this.options.isSourceCurrent() === true; } catch { return false; } }
  private binding(admission = false): string {
    const capability = this.options.kernel.listCapabilities().find(item => item.id === CAPABILITY), readiness = this.options.kernel.getCapabilityReadiness(CAPABILITY);
    check(capability?.moduleId === 'computer' && capability.risk === 'read' && readiness?.status === 'active', 'capability-unavailable');
    return digest({ selection: this.selection, version: this.version, capability, readiness: admission
      ? { capabilityId: readiness.capabilityId, moduleId: readiness.moduleId, moduleVersion: readiness.moduleVersion, status: readiness.status } : readiness });
  }
  private input(raw: AstraJson): Input {
    check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 3
      && raw.selectionId === this.selection.id && identity(raw.workId) && Number.isSafeInteger(raw.timeoutMs)
      && Number(raw.timeoutMs) >= 50 && Number(raw.timeoutMs) <= 10000, 'compiled-input'); return raw as unknown as Input;
  }
  private admit(input: Input, journal: AstraJournalAccess, owner: () => boolean) {
    const prior = this.read(input, journal); if (prior) return prior;
    return this.save(input, journal, { revision: 0 }, { schemaVersion: 'monarch.astra-v3-computer-observe.internal.v1',
      workId: input.workId, inputDigest: digest([input, this.selection]), phase: 'ready', desired: 'run', quiescent: true }, owner);
  }
  private read(input: Input, journal: AstraJournalAccess): { revision: number; checkpoint: Checkpoint } | null {
    const view = journal.read(input.workId); if (!view) return null;
    const cp = view.checkpoint as unknown as Checkpoint;
    check(cp.schemaVersion === 'monarch.astra-v3-computer-observe.internal.v1' && cp.workId === input.workId
      && cp.inputDigest === digest([input, this.selection]) && ['ready', 'dispatching', 'settled'].includes(cp.phase)
      && ['run', 'pause', 'cancel'].includes(cp.desired) && typeof cp.quiescent === 'boolean', 'checkpoint-binding');
    if (cp.phase === 'dispatching' || cp.observation) check(cp.invocation && /^[a-f0-9]{64}$/u.test(cp.invocation.proposalHash)
      && typeof cp.invocation.idempotencyKey === 'string' && Number.isSafeInteger(cp.invocation.startedAt), 'invocation-binding');
    if (cp.observation) check(cp.phase === 'settled' && cp.quiescent && cp.observation.authority === 'none'
      && cp.observation.authorizesInput === false && cp.observation.temporalSemantics === 'snapshot-at-capture'
      && cp.observation.windowRef === this.selection.windowRef && cp.observation.processId === this.selection.processId
      && cp.observation.processInstanceId === this.selection.processInstanceId
      && cp.observation.title === this.selection.title && Array.isArray(cp.observation.elements)
      && cp.observation.elements.length <= 128 && Buffer.byteLength(astraJournalJson(json(cp.observation))) <= 65536, 'stored-observation-binding');
    return { revision: view.revision, checkpoint: cp };
  }
  private save(input: Input, journal: AstraJournalAccess, before: { revision: number }, cp: Checkpoint, owner: () => boolean) {
    check(owner(), 'owner-fenced');
    journal.append({ streamId: input.workId, requestId: 'observe_' + randomUUID(), expectedRevision: before.revision, checkpoint: json(cp),
      events: [{ type: 'computer-observe.' + cp.phase, desired: cp.desired, quiescent: cp.quiescent }] });
    return this.read(input, journal)!;
  }
  private project(view: { revision: number; checkpoint: Checkpoint }): AstraWorkResult {
    const cp = view.checkpoint;
    const state = !cp.quiescent ? cp.desired === 'cancel' ? 'cancelling' : cp.desired === 'pause' ? 'pausing' : 'indeterminate'
      : cp.desired === 'cancel' ? 'cancelled' : cp.desired === 'pause' ? 'paused'
      : cp.phase === 'ready' ? 'queued' : cp.observation ? 'observed' : 'blocked';
    return { state, checkpointRef: cp.workId, checkpointRevision: view.revision,
      progressDigest: digest({ phase: cp.phase, quiescent: cp.quiescent, observation: cp.observation ?? null }), ...(cp.reason ? { reason: cp.reason } : {}) };
  }
}
