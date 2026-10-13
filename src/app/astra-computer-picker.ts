import type { MonarchKernel } from '../core/kernel';
import { randomUUID } from 'node:crypto';
import { modelReadDigest as digest, modelReadIdentity as id } from '../agent-v3/model-read-task-state';
import { AstraComputerSelectionStore, validateAstraWindowChoice, type AstraWindowChoice, type AstraWindowSelectionDescriptor } from './astra-computer-selection-store';
import type { AstraPickerSource } from './astra-target-picker';

type Result = { status: 'cancelled' | 'empty' } | { status: 'selected'; selection: AstraWindowSelectionDescriptor };
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-window-picker:' + code); }

/** Explicit local user picker. Only Kernel may enumerate, only the host dialog
 * may choose. The renderer cannot supply a window or authority. No capture,
 * input, control.start, model, second scheduler or implicit target selection. */
export class AstraComputerPicker {
  private pending: { digest: string; result: Promise<Result>; controller: AbortController } | null = null;
  private disposed = false;
  constructor(private readonly options: { deployment: 'isolated-validation'; store: AstraComputerSelectionStore; kernel: MonarchKernel;
    currentSource(): AstraPickerSource; choose(windows: readonly AstraWindowChoice[], signal: AbortSignal): Promise<number | null>;
    ttlMs?: number; timeoutMs?: number }) {
    check(options.deployment === 'isolated-validation', 'deployment');
  }
  pick(raw: unknown, assertCaller: () => void): Promise<Result> {
    try {
      assertCaller(); check(!this.disposed && raw && typeof raw === 'object' && !Array.isArray(raw)
        && Object.keys(raw).length === 2 && (raw as { version: unknown }).version === 1
        && id((raw as { requestId: unknown }).requestId), 'request');
      const requestId = (raw as { requestId: string }).requestId, source = structuredClone(this.options.currentSource());
      check(source.actor?.source === 'desktop' && /^sha256:[a-f0-9]{64}$/u.test(source.actor.id) && id(source.conversationId) && id(source.epoch), 'source');
      const requestDigest = digest({ requestId, source });
      const current = () => { assertCaller(); check(!this.disposed && digest(this.options.currentSource()) === digest(source), 'source-changed'); };
      if (this.pending) {
        check(this.pending.digest === requestDigest, 'busy');
        return this.pending.result.then(value => { current(); return structuredClone(value); });
      }
      const controller = new AbortController();
      const result = this.choose(requestId, source, controller, current);
      const pending = { digest: requestDigest, result, controller }; this.pending = pending;
      void result.finally(() => { if (this.pending === pending) this.pending = null; }).catch(() => {});
      return result;
    } catch (error) { return Promise.reject(error); }
  }
  cancel(): void { this.pending?.controller.abort('picker-source-changed'); }
  dispose(): void { this.disposed = true; this.cancel(); }
  private async choose(requestId: string, source: AstraPickerSource, controller: AbortController, assertCurrent: () => void): Promise<Result> {
    const principal = { actor: source.actor, conversationId: source.conversationId };
    const prior = this.options.store.findIssued(requestId, principal); if (prior) return { status: 'selected', selection: prior };
    // Native modal lifetime is bounded; cancellation does not start another dialog
    // until the old Kernel/dialog promise actually settles.
    const timer = setTimeout(() => controller.abort('picker-timeout'), 120000);
    const current = () => { try { assertCurrent(); return !controller.signal.aborted; } catch { return false; } };
    try {
      check(current(), 'source-changed'); const startedAt = Date.now();
      // A new explicit attempt after cancellation needs a fresh metadata query;
      // do not reuse an old Kernel list receipt. Issued selections replay above.
      const invocationId = 'window_picker_' + digest([requestId, source, randomUUID()]).slice(7, 39);
      const proposal = this.options.kernel.prepareActionProposal({ capabilityId: 'computer.windows.list', proposalId: invocationId,
        args: { limit: 32 }, reason: 'Explicit local user window picker; metadata only.' },
      { requestedBy: 'user:astra-window-picker', intentId: invocationId });
      const returned = await this.options.kernel.executeActionProposal(proposal, { requestedBy: 'user:astra-window-picker', intentId: invocationId,
        source: 'desktop', signal: controller.signal, dispatchGuard: current });
      check(current(), 'source-changed');
      const output = returned.result.output as { verified?: boolean; observedAt?: string; windows?: unknown[] } | undefined;
      check(returned.proposal.canonicalHash === proposal.canonicalHash && returned.result.ok && output?.verified === true
        && typeof output.observedAt === 'string' && Date.parse(output.observedAt) >= startedAt && Date.parse(output.observedAt) <= Date.now() + 1000
        && Array.isArray(output.windows) && output.windows.length <= 32, 'enumeration-unavailable');
      const windows = output.windows.map(raw => {
        const value = raw as AstraWindowChoice;
        const item = { windowRef: value.windowRef, processId: value.processId, processInstanceId: value.processInstanceId,
          title: value.title, processName: value.processName };
        validateAstraWindowChoice(item); return item;
      });
      check(new Set(windows.map(item => item.windowRef)).size === windows.length, 'duplicate-window');
      if (!windows.length) return { status: 'empty' };
      const selected = await this.options.choose(structuredClone(windows), controller.signal);
      check(current(), 'source-changed'); if (selected === null) return { status: 'cancelled' };
      check(Number.isSafeInteger(selected) && selected >= 0 && selected < windows.length, 'dialog-choice');
      const selection = this.options.store.issue({ ...principal, requestId, window: windows[selected]!, ttlMs: this.options.ttlMs ?? 120000,
        timeoutMs: this.options.timeoutMs ?? 5000 }, current);
      assertCurrent(); return { status: 'selected', selection };
    } finally { clearTimeout(timer); }
  }
}
