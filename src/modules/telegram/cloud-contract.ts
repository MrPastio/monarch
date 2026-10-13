/** Portable wire contract. A cloud task is a proposal, never a PC permission. */
export interface DeferredPcTask {
  version: 2; id: string; deviceId: string; pairingEpoch: string; revision: number; text: string;
  chatId: number; threadId: number; messageId: number; createdAt: number; expiresAt: number;
  status: 'waiting-pc' | 'accepted' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'expired';
  turnId?: string; result?: string; cancelRequested?: boolean;
}
export interface DeliveryReceipt { taskId: string; revision: number;
  phase: 'stored' | 'accepted' | 'executed' | 'delivered' | 'delivery-uncertain'; at: number; turnId?: string }
/** Canonical immutable proposal, excluding cloud-observed execution state. */
export function deferredTaskApprovalPayload(t: DeferredPcTask): string {
  return JSON.stringify([t.version, t.id, t.deviceId, t.pairingEpoch, t.revision, t.text,
    t.chatId, t.threadId, t.messageId, t.createdAt, t.expiresAt]);
}
export function validDeferredPcTask(value: unknown): value is DeferredPcTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as DeferredPcTask;
  return t.version === 2 && /^[a-zA-Z0-9_.:-]{1,160}$/u.test(t.id) && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(t.deviceId)
    && typeof t.pairingEpoch === 'string' && t.pairingEpoch.length > 0 && t.pairingEpoch.length <= 128
    && Number.isSafeInteger(t.revision) && t.revision > 0 && typeof t.text === 'string' && t.text.length > 0 && t.text.length <= 8000
    && Number.isSafeInteger(t.chatId) && t.chatId > 0 && Number.isSafeInteger(t.threadId) && t.threadId >= 0
    && Number.isSafeInteger(t.messageId) && t.messageId > 0 && Number.isSafeInteger(t.createdAt)
    && Number.isSafeInteger(t.expiresAt) && t.expiresAt > t.createdAt
    && (t.cancelRequested === undefined || typeof t.cancelRequested === 'boolean')
    && ['waiting-pc', 'accepted', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired'].includes(t.status);
}
export const CLOUD_MAX_ANSWER_SCHEMA = { type: 'object', additionalProperties: false,
  properties: { answer: { type: 'string', minLength: 1, maxLength: 16000 } }, required: ['answer'] };
export const TELEGRAM_CLOUD_CONSENT = 'monarch.telegram.personal-cloud.2026-09-08.v1';
