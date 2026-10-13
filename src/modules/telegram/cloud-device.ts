import { setTimeout as delay } from 'node:timers/promises';
import { deferredTaskApprovalPayload, validDeferredPcTask, type DeferredPcTask } from './cloud-contract';
import { TelegramV2Store, telegramDigest } from './v2-store';
import type { TelegramSecretTransport } from './host-transport';

export interface CloudDevicePorts {
  ingress(update: unknown): Promise<void>;
  admit(task: DeferredPcTask): Promise<string>;
  inspect(turnId: string): Promise<{ status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'; summary: string }>;
  sync(): Promise<unknown[]>;
  importEvent(event: unknown): Promise<void>;
  cancel?(turnId: string): Promise<void>;
  cancelDeferred?(task: DeferredPcTask): Promise<string | null>;
}
interface LocalTask { task: DeferredPcTask; turnId?: string; approval?: { revision: number; digest: string; proposalDigest: string; expiresAt: number; grantId: string | null }; error?: string }
export class TelegramCloudDevice {
  ports: CloudDevicePorts | undefined;
  private healthy = false;
  constructor(readonly store: TelegramV2Store, private readonly transport: TelegramSecretTransport) {}
  async configuration(): Promise<{ enabled: boolean; deviceId?: string; pairingEpoch?: string; endpoint?: string }> {
    if (!this.transport.available) return { enabled: false };
    return this.transport.request({ kind: 'cloud-status' });
  }
  status() { return { connected: this.healthy, queueMode: this.store.settings().queueMode,
    pendingRevocations: this.store.list('cloud-revoke').length,
    tasks: this.store.list<LocalTask>('pc-task').map(t => ({ ...t.task, turnId: t.turnId ?? null, error: t.error ?? null, approved: Boolean(t.approval) })) }; }
  approve(items: { id: string; revision: number; digest: string; proposalDigest: string }[]): void {
    if (!items.length || items.length > 30 || this.store.settings().paused) throw Error('Проверь список поручений.');
    this.store.transaction(() => {
      for (const item of items) {
        const local = this.store.read<LocalTask>('pc-task', item.id);
        if (!local || local.task.revision !== item.revision || telegramDigest(local.task.text) !== item.digest
          || telegramDigest(deferredTaskApprovalPayload(local.task)) !== item.proposalDigest || local.turnId || local.task.cancelRequested
          || local.task.expiresAt <= Date.now() || !['waiting-pc', 'accepted'].includes(local.task.status)) throw Error('Список поручений изменился. Обнови его.');
        this.store.put('pc-task', item.id, { ...local, approval: { revision: item.revision, digest: item.digest,
          proposalDigest: item.proposalDigest,
          expiresAt: Date.now() + 10 * 60_000, grantId: this.store.activeGrant()?.id ?? null } });
      }
    });
  }
  private request<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> { return this.transport.request({ kind: 'cloud', request }, signal); }
  async revokeConversation(threadId: number, revision = this.store.binding(threadId)?.cloudRevision ?? 1): Promise<{ cloudConfirmed: boolean }> {
    const configuration = await this.configuration();
    if (!configuration.endpoint) { this.store.remove('cloud-revoke', String(threadId)); return { cloudConfirmed: true }; }
    this.store.put('cloud-revoke', String(threadId), { threadId, revision });
    try { await this.request({ action: 'revoke-dialog', threadId, revision });
      if (this.store.read<{ revision: number }>('cloud-revoke', String(threadId))?.revision === revision) this.store.remove('cloud-revoke', String(threadId));
      return { cloudConfirmed: true }; }
    catch { return { cloudConfirmed: false }; }
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.tick(signal); this.healthy = true; }
      catch { this.healthy = false; }
      await delay(10_000, undefined, { signal }).catch(() => undefined);
    }
    this.healthy = false;
  }
  async tick(signal?: AbortSignal): Promise<void> {
    const configuration = await this.configuration(); const s = this.store.settings();
    for (const r of this.store.list<{ threadId: number; revision: number }>('cloud-revoke')) await this.revokeConversation(r.threadId, r.revision);
    if (!configuration.enabled || configuration.pairingEpoch !== s.pairingEpoch || !s.enabled || !this.ports) throw Error('telegram-cloud:local-binding');
    const currentBinding = () => this.store.settings().enabled && this.store.settings().pairingEpoch === s.pairingEpoch;
    const data = await this.request<{ tasks: unknown[]; ingress: { id: string; update: unknown; expiresAt: number }[]; cloudEvents: { id: string }[] }>({ action: 'pull' }, signal);
    if (!Array.isArray(data.tasks) || data.tasks.length > 100 || !Array.isArray(data.ingress) || data.ingress.length > 30
      || !Array.isArray(data.cloudEvents) || data.cloudEvents.length > 100) throw Error('telegram-cloud:response-budget');
    if (!currentBinding()) throw Error('telegram-cloud:local-binding');
    for (const candidate of data.tasks) {
      if (!validDeferredPcTask(candidate) || candidate.deviceId !== configuration.deviceId || candidate.pairingEpoch !== s.pairingEpoch
        || candidate.chatId !== s.controlChatId) continue;
      const prior = this.store.read<LocalTask>('pc-task', candidate.id);
      const unchanged = prior && deferredTaskApprovalPayload(candidate) === deferredTaskApprovalPayload(prior.task);
      if (prior?.turnId && !unchanged) continue;
      // Cloud never supplies the approval or local Turn identity.
      this.store.put('pc-task', candidate.id, { task: candidate,
        ...(prior?.turnId ? { turnId: prior.turnId } : {}),
        ...(prior?.approval && unchanged ? { approval: prior.approval } : {}) });
    }
    for (const incoming of data.ingress) {
      if (!currentBinding()) return;
      if (!/^[0-9]{1,20}$/u.test(incoming.id) || incoming.expiresAt <= Date.now()) continue;
      await this.ports.ingress(incoming.update); await this.request({ action: 'ack-ingress', id: incoming.id }, signal);
    }
    for (const event of data.cloudEvents) {
      if (!currentBinding()) return;
      if (this.store.settings().paused) break;
      if (typeof event.id !== 'string' || event.id.length > 160) continue;
      await this.ports.importEvent(event); await this.request({ action: 'ack-event', id: event.id }, signal);
    }
    for (const local of this.store.list<LocalTask>('pc-task')) {
      signal?.throwIfAborted();
      if (!currentBinding()) return;
      if (local.task.pairingEpoch !== s.pairingEpoch || local.task.deviceId !== configuration.deviceId) continue;
      try {
      if (local.task.cancelRequested) {
        if (local.turnId) await this.ports.cancel?.(local.turnId);
        else {
          if (!this.ports.cancelDeferred) continue;
          const turnId = await this.ports.cancelDeferred(local.task);
          if (turnId) { local.turnId = turnId; this.store.put('pc-task', local.task.id, local); }
          else {
            await this.request({ action: 'cancel-unstarted', id: local.task.id, revision: local.task.revision }, signal);
            this.store.put('pc-task', local.task.id, { ...local, approval: undefined, task: { ...local.task, status: 'cancelled' } });
            continue;
          }
        }
      }
      // Keep the cancellation channel alive during pause, without admitting work,
      // uploading outcomes or synchronizing conversation content.
      if (this.store.settings().paused) continue;
      if (local.task.expiresAt <= Date.now() && !local.turnId || ['cancelled', 'expired', 'completed', 'partial', 'failed'].includes(local.task.status)) continue;
      if (!local.turnId) {
        const grant = this.store.activeGrant();
        if (!local.approval && this.store.settings().queueMode === 'scoped-auto' && grant && ['waiting-pc', 'accepted'].includes(local.task.status)) {
          local.approval = { revision: local.task.revision, digest: telegramDigest(local.task.text),
            proposalDigest: telegramDigest(deferredTaskApprovalPayload(local.task)), expiresAt: grant.expiresAt, grantId: grant.id };
          this.store.put('pc-task', local.task.id, local);
        }
        const approval = local.approval;
        if (!approval || approval.expiresAt <= Date.now() || approval.revision !== local.task.revision
          || approval.proposalDigest !== telegramDigest(deferredTaskApprovalPayload(local.task))
          || approval.digest !== telegramDigest(local.task.text) || approval.grantId !== (grant?.id ?? null)) continue;
        // Cloud rechecks cancellation/revision before acceptance. Approval remains local.
        const accepted = await this.request<{ task: DeferredPcTask }>({ action: 'accept', id: local.task.id, revision: local.task.revision }, signal);
        if (!validDeferredPcTask(accepted.task) || accepted.task.text !== local.task.text || accepted.task.revision !== approval.revision
          || telegramDigest(deferredTaskApprovalPayload(accepted.task)) !== approval.proposalDigest
          || accepted.task.id !== local.task.id || accepted.task.deviceId !== configuration.deviceId || accepted.task.pairingEpoch !== s.pairingEpoch
          || accepted.task.chatId !== local.task.chatId || accepted.task.threadId !== local.task.threadId || accepted.task.messageId !== local.task.messageId
          || accepted.task.cancelRequested || !['accepted', 'running'].includes(accepted.task.status)) throw Error('telegram-cloud:acceptance-changed');
        if (this.store.settings().paused || this.store.settings().pairingEpoch !== local.task.pairingEpoch
          || approval.expiresAt <= Date.now() || local.task.expiresAt <= Date.now() || accepted.task.expiresAt <= Date.now()
          || approval.grantId !== (this.store.activeGrant()?.id ?? null)) continue;
        try { local.turnId = await this.ports.admit(local.task); this.store.put('pc-task', local.task.id, local); }
        catch { this.store.put('pc-task', local.task.id, { ...local, error: 'Не удалось принять задачу. Проверь Monarch, модель и разрешения.' }); continue; }
      }
      const result = await this.ports.inspect(local.turnId);
      await this.request({ action: 'result', id: local.task.id, revision: local.task.revision, turnId: local.turnId, status: result.status, summary: result.summary }, signal);
      if (result.status !== 'running') this.store.put('pc-task', local.task.id, { ...local, task: { ...local.task, status: result.status } });
      } catch (error) {
        signal?.throwIfAborted();
        this.store.put('pc-task', local.task.id, { ...local, error: 'Состояние этой задачи не подтверждено. Повторная связь продолжит наблюдение за тем же поручением.' });
      }
    }
    if (!currentBinding() || this.store.settings().paused) return;
    const dialogs = await this.ports.sync();
    if (!currentBinding() || this.store.settings().paused) return;
    await this.request({ action: 'sync', dialogs }, signal);
  }
}
