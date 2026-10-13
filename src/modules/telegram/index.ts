import { createHash, randomInt, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TelegramSecretTransport } from './host-transport';
import { TelegramSecretary } from './v2-secretary';
import { TelegramCloudDevice } from './cloud-device';
import type { DeferredPcTask } from './cloud-contract';
import { TelegramV2Store } from './v2-store';
import { TelegramV2Interface } from './v2-interface';
import { extractTelegramDocument } from './document-extractor';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntentResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
} from '../../core';
import { resolveMonarchRuntimePaths } from '../../core';
import {
  assertTelegramBotApiMethodAllowed,
  assertTelegramBotApiMethodName,
  findTelegramApiChatReferenceViolation,
  parseTelegramApiCommandParameters,
  readTelegramApiCapabilityInput,
  telegramApiInputHelp,
} from './api-guard';
import { serializeTelegramAgentCommand } from './agent-command-contract';
import { telegramManifest } from './manifest';
import {
  PAIRING_ATTEMPT_LIMIT,
  PAIRING_ATTEMPT_WINDOW_MS,
  TRANSIENT_LOCK_STALE_MS,
  TRANSIENT_LOCK_TIMEOUT_MS,
  acquireFileLock,
  defaultTelegramState,
  isNotFoundError,
  pairingAttemptKey,
  readPairingAttempts,
  readPairingSnapshot,
  releaseFileLock,
  validPendingTaskDelivery,
  validArtifactEgressOffer,
  validPairing,
  validReminder,
  writeAtomicJson,
  type TelegramPairing,
  type TelegramArtifactEgressOffer,
  type TelegramPendingTaskDelivery,
  type TelegramReminder,
  type TelegramState,
} from './state-store';
import { runInBackground } from '../../core/background-work';

const DEFAULT_API_BASE = 'https://api.telegram.org';
const PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGE_CHARS = 3800;
const MAX_COMMAND_CHARS = 16_000;
const MAX_OUTBOUND_MESSAGE_CHARS = 16_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const PAIRING_COOLDOWN_MS = 30 * 60 * 1000;
const OFFICIAL_TELEGRAM_API_HOST = 'api.telegram.org';
const MAX_TABLE_COLUMNS = 8;
const MAX_TABLE_ROWS = 24;
const MAX_TABLE_CELL_CHARS = 120;
const MAX_TABLE_TITLE_CHARS = 160;
const MAX_TABLE_MARKDOWN_CHARS = 3_600;
const MIN_POLL_OPTIONS = 1;
const MAX_POLL_OPTIONS = 12;
const MAX_POLL_QUESTION_CHARS = 300;
const MAX_POLL_OPTION_CHARS = 100;
const MAX_REMINDER_TEXT_CHARS = 2_000;
const REMINDER_WATCH_DEBOUNCE_MS = 50;
const REMINDER_WATCH_FALLBACK_MS = 60_000;
const REMINDER_POLL_FALLBACK_MS = 1_000;
const MAX_TRACKED_RATE_LIMIT_USERS = 2_048;
const MEDIA_GROUP_NOTICE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_TASK_DELIVERIES = 128;
const MAX_ARTIFACT_EGRESS_OFFERS = 64;
const TELEGRAM_ARTIFACT_OFFER_TTL_MS = 60 * 60 * 1000;
const TELEGRAM_API_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const TELEGRAM_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const TELEGRAM_TEXT_ATTACHMENT_MAX_BYTES = 32 * 1024;
const TELEGRAM_VOICE_MAX_DURATION_SECONDS = 5 * 60;
const TELEGRAM_API_CALL_TIMEOUT_MS = 15_000;
const TELEGRAM_LONG_POLL_TIMEOUT_MS = 35_000;
const TELEGRAM_STANDBY_RETRY_MS = 2_000;
const TELEGRAM_REMINDER_RETRY_BASE_MS = 5_000;
const TELEGRAM_REMINDER_RETRY_MAX_MS = 5 * 60_000;
const TELEGRAM_PAIRED_CHAT_API_METHODS = new Set([
  'sendmessage', 'sendphoto', 'sendaudio', 'senddocument', 'sendvideo', 'sendanimation', 'sendvoice',
  'sendvideonote', 'sendpaidmedia', 'sendmediagroup', 'sendlocation', 'sendvenue', 'sendcontact',
  'sendpoll', 'senddice', 'sendchataction', 'sendinvoice', 'sendrichmessage',
  'copymessage', 'copymessages', 'forwardmessage', 'forwardmessages',
  'editmessagetext', 'editmessagecaption', 'editmessagemedia', 'editmessagereplymarkup',
  'editmessagelivelocation', 'stopmessagelivelocation', 'editmessagechecklist',
  'deletemessage', 'deletemessages', 'pinchatmessage', 'unpinchatmessage', 'unpinallchatmessages',
  'banchatmember', 'unbanchatmember', 'restrictchatmember', 'promotechatmember',
  'setchatadministratorcustomtitle', 'banchatsenderchat', 'unbanchatsenderchat',
  'setchatpermissions', 'exportchatinvitelink', 'createchatinvitelink', 'editchatinvitelink',
  'createchatsubscriptioninvitelink', 'editchatsubscriptioninvitelink', 'revokechatinvitelink',
  'approvechatjoinrequest', 'declinechatjoinrequest', 'setchatphoto', 'deletechatphoto',
  'setchattitle', 'setchatdescription', 'pinchatmessage', 'setchatstickerset', 'deletechatstickerset',
  'createforumtopic', 'editforumtopic', 'closeforumtopic',
  'reopenforumtopic', 'deleteforumtopic', 'unpinallforumtopicmessages', 'editgeneralforumtopic',
  'closegeneralforumtopic', 'reopengeneralforumtopic', 'hidegeneralforumtopic',
  'unhidegeneralforumtopic', 'unpinallgeneralforumtopicmessages', 'leavechat',
  'getchat', 'getchatadministrators', 'getchatmembercount', 'getchatmember', 'getchatboosts',
  'getuserchatboosts', 'setmessagereaction', 'stoppoll',
]);

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

class TelegramBotApiError extends Error {
  readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'TelegramBotApiError';
    this.retryAfterMs = retryAfterMs;
  }
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  media_group_id?: string;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

type TelegramImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
type TelegramTextMimeType = 'text/plain' | 'text/markdown' | 'application/json';
type TelegramAttachmentMimeType = TelegramImageMimeType | TelegramTextMimeType;

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  stopped_message_generation?: { chat: { id: number; type: string }; message_thread_id?: number; draft_id: number };
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramIntentDispatchRequest {
  text: string;
  attachments?: TelegramIntentAttachment[];
  voiceNote?: TelegramIntentVoiceNote;
  astraRemote?: { operation: 'workspace-read'; targetAlias: string };
  approval?: {
    action: 'arm' | 'approve' | 'deny';
    approvalId: string;
  };
  context: Record<string, unknown>;
}

export interface TelegramIntentAttachment {
  idempotencyKey: string;
  name: string;
  mimeType: TelegramAttachmentMimeType;
  dataBase64: string;
}

export interface TelegramIntentVoiceNote {
  idempotencyKey: string;
  mimeType: 'audio/ogg';
  durationMs: number;
  dataBase64: string;
}

export interface TelegramIntentAdmission {
  /** Deterministic Telegram update binding used by the delivery queue. */
  clientRequestId: string;
  /** The admitted or refocused Oscar Turn's own idempotency key. */
  turnClientRequestId: string;
  turnId: string;
  privacyMode: 'persistent';
}

export interface TelegramIntentActivity {
  turnId: string;
  status: 'accepted' | 'routing' | 'answering' | 'running' | 'waiting-for-user' | 'waiting-for-approval' | 'waiting-for-runtime';
  updatedAt: string;
}

export interface TelegramArtifactOfferDescriptor {
  turnId: string;
  taskId: string;
  artifactId: string;
  name: string;
  checksum: string;
}

export interface TelegramArtifactEgressPayload extends TelegramArtifactOfferDescriptor {
  permitDigest: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: string;
  dataBase64: string;
}

export interface TelegramIntentDispatcher {
  (request: TelegramIntentDispatchRequest, signal?: AbortSignal): Promise<MonarchIntentResult>;
  admit?: (request: TelegramIntentDispatchRequest, signal?: AbortSignal) => Promise<TelegramIntentAdmission>;
  resume?: (admission: TelegramIntentAdmission, context: Record<string, unknown>,
    signal?: AbortSignal) => Promise<MonarchIntentResult>;
  listArtifacts?: (admission: TelegramIntentAdmission, context: Record<string, unknown>,
    signal?: AbortSignal) => Promise<TelegramArtifactOfferDescriptor[]>;
  prepareArtifact?: (offer: TelegramArtifactOfferDescriptor, context: Record<string, unknown>,
    signal?: AbortSignal) => Promise<TelegramArtifactEgressPayload>;
  inspect?: (context: Record<string, unknown>) => Promise<TelegramIntentActivity | null>;
  cancelLatest?: (context: Record<string, unknown>) => Promise<MonarchIntentResult | null>;
}

/** Attempts one Telegram update gets before it is skipped. */
const MAX_UPDATE_ATTEMPTS = 5;

export class TelegramIntentRejectedError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string) {
    super('Telegram intent was rejected before durable admission.');
    this.name = 'TelegramIntentRejectedError';
    this.userMessage = userMessage;
  }
}

interface TelegramOwnerDevPolicy {
  zeroRetentionEnabled?: boolean;
}

class TelegramUpdateRetryError extends Error {
  constructor(cause: unknown) {
    super(`Telegram update was not durably admitted: ${safeError(cause)}`, { cause });
    this.name = 'TelegramUpdateRetryError';
  }
}

export interface TelegramModuleOptions {
  projectRoot?: string;
  stateRoot?: string;
  secretsRoot?: string;
  apiBase?: string;
  token?: string;
  autoStart?: boolean;
  /** Inbound flood guard per Telegram user. Defaults to 20 messages per minute;
   * only isolated harnesses raise it to exercise the transport itself. */
  inboundRateLimit?: { limit: number; windowMs: number };
}

/** Host-only factual binding for Astra alias issuance. The pairing epoch is
 * sourced from durable Telegram state, never from a renderer or caller. */
export interface TelegramAstraPairingBinding {
  chatId: number;
  userId: number;
  pairingEpoch: string;
  paired: true;
  remotePaused: boolean;
}

export class TelegramModule implements MonarchModule {
  readonly manifest = telegramManifest;
  readonly v2: TelegramV2Store;
  readonly v2Interface: TelegramV2Interface;
  readonly secretary: TelegramSecretary;
  readonly cloud: TelegramCloudDevice;
  private cloudMode = false;
  private readonly topicContext = new AsyncLocalStorage<{ threadId: number; epoch?: string; ownerId?: number; chatId?: number; conversationBound?: boolean; cancellationOnly?: boolean }>();
  private readonly pendingDeliveryContext = new AsyncLocalStorage<TelegramPendingTaskDelivery>();
  private readonly projectRoot: string;
  private readonly statePath: string;
  private readonly stateLockPath: string;
  private readonly pairingPath: string;
  private readonly pairingLockPath: string;
  private readonly pollingLockPath: string;
  private readonly tokenPath: string;
  private readonly optionToken: string;
  private readonly apiBase: string;
  private readonly inboundRateLimit: { limit: number; windowMs: number };
  private readonly autoStart: boolean;
  private token = '';
  private readonly secretTransport = new TelegramSecretTransport();
  private state: TelegramState = defaultTelegramState(false);
  private dispatcher: TelegramIntentDispatcher | null = null;
  private context: MonarchKernelContext | null = null;
  private running = false;
  private standby = false;
  private pollingLockToken = '';
  private pollingAbort: AbortController | null = null;
  private pollingTask: Promise<void> | null = null;
  private autoStartTask: Promise<void> | null = null;
  private standbyTimer: ReturnType<typeof setTimeout> | null = null;
  private standbyTakeoverTask: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  private reminderWatcher: FSWatcher | null = null;
  private reminderRefreshMs = REMINDER_WATCH_FALLBACK_MS;
  private reminderDeliveryActive = false;
  private reminderDeliveryTask: Promise<void> | null = null;
  private reminderDeliveryAbort: AbortController | null = null;
  private reminderDeliveryPaused = true;
  private reminderFailureStreak = 0;
  private reminderRetryNotBefore = 0;
  private pairingCode = '';
  private pairingExpiresAt = 0;
  private botIdentity: Record<string, unknown> | null = null;
  private lastError = '';
  private readonly rateWindows = new Map<number, number[]>();
  private readonly rateLimitNotices = new Map<number, number>();
  private readonly mediaGroupNotices = new Map<string, number>();
  private readonly attachmentIngressAborts = new Set<AbortController>();
  private readonly artifactEgressAborts = new Set<AbortController>();
  private readonly artifactEgressRuns = new Set<string>();
  private lastStateReadError = '';
  private ownerDevSettingsProvider: () => TelegramOwnerDevPolicy = () => ({});
  private readonly taskDeliveryRuns = new Map<string, Promise<void>>();
  private readonly taskDeliveryAborts = new Map<string, AbortController>();
  private taskDeliveryGeneration = 0;

  constructor(options: TelegramModuleOptions = {}) {
    this.projectRoot = path.resolve(options.projectRoot || process.cwd());
    const runtimePaths = resolveMonarchRuntimePaths(this.projectRoot);
    const stateRoot = path.resolve(options.stateRoot || runtimePaths.dataRoot);
    const secretsRoot = path.resolve(options.secretsRoot || runtimePaths.secretsRoot);
    this.v2 = new TelegramV2Store(stateRoot, this.projectRoot);
    this.v2Interface = new TelegramV2Interface(this.v2, (method, parameters) => this.callApi(method, parameters));
    this.secretary = new TelegramSecretary(this.v2, this.secretTransport);
    this.cloud = new TelegramCloudDevice(this.v2, this.secretTransport);
    this.v2Interface.secretary = (action, _message, render) => this.secretary.present(action, render);
    this.v2Interface.stopAll = () => this.stopRemoteComponents();
    this.v2Interface.reminders = {
      list: async threadId => { await this.refreshState(); const s = this.v2.settings();
        return this.state.reminders.filter(r => r.chatId === s.controlChatId && r.threadId === threadId && r.pairingEpoch === s.pairingEpoch)
          .map(r => ({ id: r.id, text: r.text, dueAt: r.dueAt, uncertain: Boolean(r.deliveryState) })); },
      create: async (threadId, text, dueAt) => {
        const s = this.v2.settings(); this.v2.assertOwner(s.controlChatId, s.ownerUserId);
        if (Date.parse(dueAt) <= Date.now()) throw Error('Выбери будущее время.');
        await this.createReminder(s.controlChatId, text, dueAt, undefined, { threadId, pairingEpoch: s.pairingEpoch });
      },
      cancel: async (threadId, id) => { const s = this.v2.settings(); this.v2.assertOwner(s.controlChatId, s.ownerUserId);
        await this.mutateState(state => { state.reminders = state.reminders.filter(r => !(r.id === id && r.chatId === s.controlChatId
          && r.threadId === threadId && r.pairingEpoch === s.pairingEpoch)); }); },
    };
    this.statePath = path.join(stateRoot, 'telegram-state.json');
    this.stateLockPath = path.join(stateRoot, 'telegram-state.lock');
    this.pairingPath = path.join(stateRoot, 'telegram-pairing.json');
    this.pairingLockPath = path.join(stateRoot, 'telegram-pairing.lock');
    this.pollingLockPath = path.join(stateRoot, 'telegram-polling.lock');
    this.tokenPath = path.join(secretsRoot, 'telegram_bot_token.txt');
    this.apiBase = normalizeApiBase(options.apiBase || process.env.MONARCH_TELEGRAM_API_BASE || DEFAULT_API_BASE);
    const inbound = options.inboundRateLimit;
    this.inboundRateLimit = inbound && Number.isSafeInteger(inbound.limit) && inbound.limit >= 1
      && Number.isSafeInteger(inbound.windowMs) && inbound.windowMs >= 1_000
      ? { limit: inbound.limit, windowMs: inbound.windowMs } : { limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS };
    this.optionToken = String(options.token || '').trim();
    this.token = this.optionToken;
    this.autoStart = options.autoStart ?? process.env.MONARCH_TELEGRAM_AUTO_START !== '0';
  }

  async resolveAstraPairing(chatId: number, userId: number): Promise<TelegramAstraPairingBinding> {
    if (!Number.isSafeInteger(chatId) || chatId === 0
      || !Number.isSafeInteger(userId) || userId <= 0) {
      throw Object.assign(Error('telegram:astra-pairing-binding-invalid'), {
        statusCode: 400,
        code: 'telegram-astra-pairing-binding-invalid',
      });
    }
    await this.refreshState();
    const pairing = this.state.pairings.find((entry) => entry.chatId === chatId && entry.userId === userId);
    if (!pairing) {
      throw Object.assign(Error('telegram:astra-pairing-not-found'), {
        statusCode: 403,
        code: 'telegram-astra-pairing-not-found',
      });
    }
    return {
      chatId,
      userId,
      pairingEpoch: pairing.pairedAt,
      paired: true,
      remotePaused: this.state.remotePaused,
    };
  }

  setIntentDispatcher(dispatcher: TelegramIntentDispatcher): void {
    this.dispatcher = dispatcher;
  }

  /** Called only by the desktop-principal HTTP endpoint, never a capability. */
  private async syncGlobalMax(): Promise<void> {
    if (!this.v2.followsGlobalModel()) return;
    const selected = await this.secretTransport.request<{ available: boolean; role?: string }>({ kind: 'max-selection' }).catch(() => ({ available: false, role: undefined }));
    this.v2.configureGlobalModel(true, selected.available ? selected.role : undefined);
  }
  async desktopV2Control(input: Record<string, unknown>): Promise<unknown> {
    const action = input.action;
    if (action === 'model') {
      const enabled = input.consent === true;
      const selected = enabled ? await this.secretTransport.request<{ available: boolean; role?: string }>({ kind: 'max-selection' }) : null;
      if (enabled && !selected?.available) throw Error('Подключи выбранного провайдера в настройках MAX.');
      this.v2.configureGlobalModel(enabled, selected?.role); return { role: this.v2.allowedModel() ?? null };
    }
    if (action === 'status') await this.syncGlobalMax();
    if (action === 'stop-all') return { summary: await this.stopRemoteComponents() };
    if (action === 'secretary-pause') { await this.secretary.pause(); return this.secretary.status(); }
    if (action === 'transport-switch') {
      if (!this.context || !this.v2.settings().enabled || !['cloud', 'polling'].includes(String(input.mode))) throw Error('Сначала подключи V2 и выбери транспорт.');
      await this.stop(this.context);
      const result = await this.secretTransport.request({ kind: 'cloud-switch', mode: input.mode });
      await this.start(this.context); return result;
    }
    if (action === 'cloud-pause' || action === 'cloud-resume') {
      return this.secretTransport.request({ kind: 'cloud', request: { action: 'cloud-control', paused: action === 'cloud-pause' } });
    }
    if (action === 'queue-mode') {
      if (input.mode !== 'confirm' && input.mode !== 'scoped-auto') throw Error('Выбери режим очереди.');
      this.v2.setQueueMode(input.mode); return this.cloud.status();
    }
    if (action === 'queue-approve') {
      if (!Array.isArray(input.items) || input.items.some(x => !x || typeof x.id !== 'string' || typeof x.revision !== 'number' || typeof x.digest !== 'string')) throw Error('Проверь список задач.');
      this.cloud.approve(input.items); return this.cloud.status();
    }
    if (action === 'cloud-dialog') {
      if (typeof input.id !== 'string' || typeof input.enabled !== 'boolean') throw Error('Выбери диалог.');
      const b = this.v2.updateBinding(input.id, { cloudEnabled: input.enabled });
      return input.enabled ? this.cloud.status() : this.cloud.revokeConversation(b.threadId);
    }
    if (action === 'secretary-configure') {
      if (!Array.isArray(input.chats) || !input.chats.every(x => typeof x === 'number') || typeof input.enabled !== 'boolean') throw Error('Выбери переписки секретаря.');
      await this.secretary.stop(); this.secretary.configure(input.chats, input.enabled);
      if (input.enabled) await this.secretary.start();
      return this.secretary.status();
    }
    if (action === 'secretary-rule') {
      if (typeof input.chatId !== 'number' || typeof input.template !== 'string' || typeof input.ttlMs !== 'number') throw Error('Проверь правило автоответа.');
      this.secretary.setRule({ chatId: input.chatId, template: input.template, ttlMs: input.ttlMs }); return { rules: this.secretary.rules() };
    }
    if (action === 'secretary-rule-remove') {
      if (typeof input.chatId !== 'number') throw Error('Выбери получателя.');
      this.secretary.removeRule(input.chatId); return { rules: this.secretary.rules() };
    }
    if (action === 'pair') {
      if (!this.secretTransport.available) throw Error('V2 требует защищённое подключение в приложении Monarch. Сохрани ключ в настройках Telegram.');
      if (!this.botIdentity?.username) throw Error('Сначала подключи и запусти бота.');
      const challenge = this.v2.pairingChallenge();
      return { expiresAt: challenge.expiresAt, url: `https://t.me/${this.botIdentity.username}?start=v2_${challenge.token}` };
    }
    if (action === 'confirm-pair') {
      const c = this.v2.read<{ userId: number; chatId: number; botId: number; expiresAt: number }>('pair-candidate', 'current');
      if (!c || c.expiresAt <= Date.now() || input.userId !== c.userId || input.chatId !== c.chatId
        || c.botId !== this.botIdentity?.id || input.historyEnabled !== true) throw Error('Проверь актуальный запрос привязки и разрешение на историю.');
      const epoch = new Date().toISOString();
      this.v2.configure({ ownerUserId: c.userId, controlChatId: c.chatId, botId: c.botId, pairingEpoch: epoch, historyEnabled: true });
      this.v2.remove('pair-candidate', 'current');
      await this.mutateState(s => {
        s.pairings = [{ userId: c.userId, chatId: c.chatId, pairedAt: epoch }];
        s.remotePaused = false;
      });
    } else if (action === 'grant') {
      if (typeof input.root !== 'string' || !Array.isArray(input.capabilities)
        || !input.capabilities.every(c => typeof c === 'string')) throw Error('Выбери папку и допустимые операции.');
      this.v2.grant(input.root, input.capabilities, typeof input.ttlMs === 'number' ? input.ttlMs : undefined);
    } else if (action === 'revoke-grant') this.v2.revokeGrant();
    else if (action === 'pause') await this.setRemotePaused(true);
    else if (action === 'resume') await this.setRemotePaused(false);
    else if (action === 'revoke') await this.revokePairingCapability({});
    else if (action === 'conversation') {
      if (typeof input.id !== 'string' || typeof input.localOnly !== 'boolean') throw Error('Выбери диалог.');
      const b = this.v2.updateBinding(input.id, { localOnly: input.localOnly });
      if (input.localOnly) return this.cloud.revokeConversation(b.threadId);
    } else if (action !== 'status' && action !== 'confirm-pair') throw Error('Неизвестное действие Telegram V2.');
    return { bot: { username: this.botIdentity?.username ?? null }, settings: this.v2.settings(), cloud: this.cloud.status(), secretary: this.secretary.status(), candidate: this.v2.read('pair-candidate', 'current'),
      grant: this.v2.activeGrant(), maxEnabled: this.v2.followsGlobalModel() || Boolean(this.v2.allowedModel()), modelRole: this.v2.allowedModel() ?? null, conversations: this.v2.bindings() };
  }

  setOwnerDevSettingsProvider(provider: () => TelegramOwnerDevPolicy): void {
    this.ownerDevSettingsProvider = provider;
  }

  async applyOwnerDevSettings(policy: TelegramOwnerDevPolicy): Promise<void> {
    if (policy.zeroRetentionEnabled !== true) return;
    await this.refreshState();
    if (this.lastStateReadError) {
      await this.context?.audit('telegram', 'Zero-retention cleanup could not inspect unreadable Telegram state; transport remains fail-closed.', {}, 'warn');
      return;
    }
    let removed = 0;
    await this.withReminderDeliveryPaused(
      new Error('Telegram reminders were removed by Owner DEV zero-retention policy.'),
      async () => this.mutateState((state) => {
        removed = state.reminders.length;
        state.reminders = [];
        state.artifactEgressOffers = [];
      }),
    );
    this.reminderFailureStreak = 0;
    this.reminderRetryNotBefore = 0;
    if (removed > 0) {
      await this.context?.emit('telegram.reminders.removed.zero-retention', this.manifest.id, { removed });
      await this.context?.audit('telegram', 'Stored Telegram reminders removed by zero-retention policy.', {
        removed,
      }, 'info');
    }
  }

  private isZeroRetentionEnabled(): boolean {
    try {
      return this.ownerDevSettingsProvider().zeroRetentionEnabled === true;
    } catch {
      return true;
    }
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    this.context = context;
    await this.loadState();
    if (this.state.artifactEgressOffers.some((entry) => entry.status === 'attempting')) {
      await this.mutateState((state) => {
        state.artifactEgressOffers = state.artifactEgressOffers.map((entry) => (
          entry.status === 'attempting' ? { ...entry, status: 'uncertain' as const } : entry
        ));
      });
    }
    await this.applyOwnerDevSettings({ zeroRetentionEnabled: this.isZeroRetentionEnabled() });
    if (this.secretTransport.available) {
      const status = await this.secretTransport.request<{ configured: boolean }>({ kind: 'status' }).catch(() => ({ configured: false }));
      this.token = status.configured ? 'host-managed' : '';
    } else if (!this.token) {
      this.token = String(process.env.MONARCH_TELEGRAM_BOT_TOKEN || '').trim() || await readSecret(this.tokenPath);
    }
    await this.ensureFreshPairingCode();
    await context.emit('telegram.activated', this.manifest.id, this.statusPayload(true));
    await this.secretary.start().catch(() => undefined);
    if (this.token && this.autoStart) {
      // Connecting is several Telegram API round trips (getMe, webhook check,
      // command menu): ~1.4 s of every Monarch start inside Kernel activation.
      // The bot connects in the background; deactivate waits for it.
      this.autoStartTask = this.start(context).then(() => undefined, (error) => {
        this.lastError = safeError(error);
      }).finally(() => { this.autoStartTask = null; });
    }
  }

  async deactivate(context: MonarchKernelContext): Promise<void> {
    await this.autoStartTask;
    await this.stop(context);
    await this.secretary.stop();
    this.context = null;
    this.v2.close();
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: this.token
        ? this.running
          ? 'Telegram bot is polling in this Monarch runtime.'
          : this.standby
            ? 'Telegram bot is active through another local Monarch runtime.'
            : 'Telegram bot is configured but stopped.'
        : 'Telegram bot token is not configured.',
      output: this.statusPayload(false),
    };
  }


  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    control: { signal?: AbortSignal } = {},
  ): Promise<MonarchExecutionResult> {
    control.signal?.throwIfAborted();
    await this.refreshState();
    switch (request.capabilityId) {
    case 'telegram.status':
      return { ok: true, summary: 'Telegram integration status loaded.', output: this.statusPayload(true) };
    case 'telegram.capabilities.describe':
      return this.describeCapabilitiesCapability(request.input);
    case 'telegram.pairing.rotate':
      await this.rotatePairingCode();
      return { ok: true, summary: 'Fresh Telegram pairing code created.', output: this.statusPayload(true) };
    case 'telegram.pairing.revoke':
      return this.revokePairingCapability(request.input);
    case 'telegram.remote.pause':
      return this.setRemotePaused(true);
    case 'telegram.remote.resume':
      return this.setRemotePaused(false);
    case 'telegram.bot.start':
      return this.start(context);
    case 'telegram.bot.stop':
      return this.stop(context);
    case 'telegram.message.send':
      return this.sendCapability(request.input, control.signal);
    case 'telegram.poll.send':
      return this.pollCapability(request.input, control.signal);
    case 'telegram.reminder.create':
      return this.createReminderCapability(request.input, control.signal);
    case 'telegram.reminder.list':
      return this.listRemindersCapability(request.input);
    case 'telegram.reminder.cancel':
      return this.cancelReminderCapability(request.input, control.signal);
    case 'telegram.api.call':
      return this.genericApiCapability(request.input, control.signal);
    default:
      return { ok: false, summary: `Unsupported Telegram capability: ${request.capabilityId}`, error: 'unsupported-capability' };
    }
  }

  private async start(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    await this.refreshState();
    if (this.lastStateReadError) {
      return {
        ok: false,
        summary: 'Telegram bot was not started because its local state file is unavailable. Repair or restore the state before retrying.',
        error: 'telegram-state-unavailable',
        output: this.statusPayload(false),
      };
    }
    if (this.running) {
      return { ok: true, summary: 'Telegram bot is already running.', output: this.statusPayload(false) };
    }
    if (this.standby) {
      return { ok: true, summary: 'Telegram bot is already owned by another local Monarch runtime.', output: this.statusPayload(false) };
    }
    if (this.secretTransport.available) {
      const status = await this.secretTransport.request<{ configured: boolean }>({ kind: 'status' });
      this.token = status.configured ? 'host-managed' : '';
    } else if (!this.optionToken) {
      this.token = String(process.env.MONARCH_TELEGRAM_BOT_TOKEN || '').trim()
        || await readSecret(this.tokenPath);
    }
    if (!this.token) {
      return {
        ok: false,
        summary: `Telegram token is missing. Set MONARCH_TELEGRAM_BOT_TOKEN or write it to ${this.tokenPath}.`,
        error: 'telegram-token-missing',
        output: this.statusPayload(true),
      };
    }
    const me = await this.callApi<Record<string, unknown>>('getMe', {});
    if (this.v2.settings().enabled && this.v2.settings().botId !== me.id) throw Error('Ключ относится к другому боту. Отзови прежнюю привязку локально перед подключением.');
    this.botIdentity = me;
    const cloudConfiguration = await this.cloud.configuration();
    this.cloudMode = cloudConfiguration.enabled;
    if (this.v2.settings().enabled) {
      if (cloudConfiguration.enabled && cloudConfiguration.pairingEpoch !== this.v2.settings().pairingEpoch) throw Error('Облачная привязка не совпадает с локальной.');
      const webhook = await this.callApi<{ url: string }>('getWebhookInfo', {});
      if (webhook.url !== (cloudConfiguration.enabled ? `${cloudConfiguration.endpoint}/telegram` : '')) throw Error('Получатель Telegram не совпадает с выбранным режимом. Заверши переключение webhook по инструкции.');
    }
    this.lifecycleGeneration += 1;
    const ownsPolling = await this.acquirePollingLock();
    if (!ownsPolling) {
      this.standby = true;
      this.lastError = '';
      this.scheduleStandbyTakeover(context, this.lifecycleGeneration);
      await context.emit('telegram.started', this.manifest.id, this.statusPayload(false));
      return {
        ok: true,
        summary: 'Telegram bot is shared with another local Monarch runtime; duplicate polling was suppressed.',
        output: this.statusPayload(true),
      };
    }
    await this.callApi('setMyCommands', { commands: telegramBotCommands() }).catch(async (error) => {
      await context.audit('telegram', 'Telegram command menu registration failed.', {
        error: safeError(error),
      }, 'warn');
    });
    this.running = true;
    this.standby = false;
    this.lastError = '';
    this.taskDeliveryGeneration += 1;
    this.pollingAbort = new AbortController();
    this.pollingTask = this.cloudMode ? this.cloud.run(this.pollingAbort.signal) : this.pollLoop(this.pollingAbort.signal);
    try {
      this.resumePendingTaskDeliveries();
      await this.startReminderScheduler();
      await context.emit('telegram.started', this.manifest.id, this.statusPayload(false));
    } catch (error) {
      this.running = false;
      this.taskDeliveryGeneration += 1;
      this.reminderDeliveryPaused = true;
      this.reminderDeliveryAbort?.abort(error);
      this.pollingAbort.abort(error);
      this.pollingAbort = null;
      if (this.reminderTimer) clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
      this.reminderWatcher?.close();
      this.reminderWatcher = null;
      await this.reminderDeliveryTask?.catch(() => undefined);
      this.reminderDeliveryTask = null;
      this.reminderDeliveryAbort = null;
      await this.pollingTask?.catch(() => undefined);
      this.pollingTask = null;
      await this.settleTaskDeliveryRuns();
      await this.releasePollingLock();
      throw error;
    }
    return { ok: true, summary: this.cloudMode ? 'Telegram подключён через личное облако.' : 'Telegram bot started with local long polling.', output: this.statusPayload(true) };
  }

  private async stop(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const wasRunning = this.running;
    const wasStandby = this.standby;
    this.running = false;
    this.standby = false;
    this.lifecycleGeneration += 1;
    if (this.standbyTimer) clearTimeout(this.standbyTimer);
    this.standbyTimer = null;
    await this.standbyTakeoverTask?.catch(() => undefined);
    this.standbyTakeoverTask = null;
    this.taskDeliveryGeneration += 1;
    this.reminderDeliveryPaused = true;
    this.reminderDeliveryAbort?.abort(new Error('Telegram reminder delivery stopped with its polling owner.'));
    this.pollingAbort?.abort();
    this.pollingAbort = null;
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
    this.reminderWatcher?.close();
    this.reminderWatcher = null;
    await this.reminderDeliveryTask?.catch(() => undefined);
    this.reminderDeliveryTask = null;
    this.reminderDeliveryAbort = null;
    await this.pollingTask?.catch(() => undefined);
    this.pollingTask = null;
    await this.settleTaskDeliveryRuns();
    await this.releasePollingLock();
    if (wasRunning || wasStandby) await context.emit('telegram.stopped', this.manifest.id, this.statusPayload(false));
    return {
      ok: true,
      summary: wasRunning ? 'Telegram bot stopped.' : wasStandby ? 'Telegram standby connection stopped.' : 'Telegram bot was already stopped.',
      output: this.statusPayload(false),
    };
  }

  private async stopRemoteComponents(): Promise<string> {
    // Close intake and local action grants synchronously before contacting any component.
    this.v2.pause(); this.v2.revokeGrant();
    const results = await Promise.allSettled([
      (async () => {
        await this.setRemotePaused(true);
        if (!this.v2Interface.bridge) throw Error('task-control-unavailable');
        const tasks = await this.v2Interface.bridge.tasks();
        const cancellations = await Promise.allSettled(tasks.map(t => this.v2Interface.bridge!.cancel(t.id, t.conversationId)));
        const failed = cancellations.filter(r => r.status === 'rejected').length;
        return `Задачи Telegram на ПК: остановка запрошена для ${tasks.length - failed}${failed ? `, не подтверждена для ${failed}` : ''}. Доступ к папке закрыт.`;
      })(),
      (async () => { await this.secretary.pause(); return 'Секретарь: приостановлен.'; })(),
      (async () => {
        if (!this.secretTransport.available) return 'Облако: защищённое подключение не настроено; удалённая остановка не подтверждена.';
        const config = await this.secretTransport.request<{ endpoint?: string }>({ kind: 'cloud-status' }, AbortSignal.timeout(10_000));
        if (!config.endpoint) return 'Облако: не настроено.';
        const result = await this.secretTransport.request<{ paused?: boolean; confirmed?: boolean }>({ kind: 'cloud', request: { action: 'cloud-control', paused: true } }, AbortSignal.timeout(10_000));
        if (result.paused !== true || result.confirmed !== true) throw Error('cloud-stop-unconfirmed');
        return 'Облачный MAX: пауза подтверждена. Очередь и напоминания сохранены.';
      })(),
    ]);
    return ['Удалённый запуск приостановлен.', ...results.map((r, i) => r.status === 'fulfilled' ? r.value
      : `${['Задачи ПК', 'Секретарь', 'Облачный MAX'][i]}: остановка не подтверждена. Проверь компонент в Monarch.`),
    'Уже выполненные действия не откатываются. Возобновляй компоненты отдельно в Monarch.'].join('\n');
  }

  private async setRemotePaused(paused: boolean): Promise<MonarchExecutionResult> {
    if (paused) {
      if (this.v2.settings().enabled) {
        this.v2.pause();
        for (const controller of this.taskDeliveryAborts.values()) controller.abort('remote-paused');
        runInBackground('telegram-delivery-resume', this.settleTaskDeliveryRuns().then(() => {
          if (this.running && !this.v2.settings().paused) this.resumePendingTaskDeliveries();
        }));
      }
      for (const controller of this.attachmentIngressAborts) {
        controller.abort(new Error('Telegram image ingress stopped by local lockdown.'));
      }
      for (const controller of this.artifactEgressAborts) {
        controller.abort(new Error('Telegram artifact egress stopped by local lockdown.'));
      }
    }
    await this.mutateState((state) => {
      state.remotePaused = paused;
    });
    if (this.v2.settings().enabled) { if (paused) this.v2.pause(); else this.v2.resume(); }
    if (!paused && this.running) this.resumePendingTaskDeliveries();
    await this.context?.emit(paused ? 'telegram.remote.paused' : 'telegram.remote.resumed', this.manifest.id, {
      pairedChats: this.state.pairings.length,
    });
    await this.context?.audit('telegram', paused ? 'Telegram remote tasks paused.' : 'Telegram remote tasks resumed.', {
      pairedChats: this.state.pairings.length,
    }, paused ? 'warn' : 'info');
    return {
      ok: true,
      summary: paused ? 'Telegram remote task intake paused.' : 'Telegram remote task intake resumed.',
      output: this.statusPayload(false),
    };
  }

  private async revokePairingCapability(input: unknown): Promise<MonarchExecutionResult> {
    const requestedChatId = readNumber(input, 'chatId');
    if (requestedChatId === undefined || requestedChatId === this.v2.settings().controlChatId) this.v2.revoke();
    const before = this.state.pairings.length;
    await this.withReminderDeliveryPaused(
      new Error('Telegram pairing scope changed during reminder delivery.'),
      async () => this.mutateState((state) => {
        state.pairings = requestedChatId === undefined
          ? []
          : state.pairings.filter((entry) => entry.chatId !== requestedChatId);
        const pairedChats = new Set(state.pairings.map((entry) => entry.chatId));
        const pairedActors = new Set(state.pairings.map((entry) => `${entry.chatId}:${entry.userId}`));
        state.reminders = state.reminders.filter((entry) => pairedChats.has(entry.chatId));
        state.pendingTaskDeliveries = state.pendingTaskDeliveries
          .filter((entry) => pairedActors.has(`${entry.chatId}:${entry.userId}`));
        state.artifactEgressOffers = state.artifactEgressOffers
          .filter((entry) => pairedActors.has(`${entry.chatId}:${entry.userId}`));
      }),
    );
    this.taskDeliveryGeneration += 1;
    for (const controller of this.taskDeliveryAborts.values()) {
      controller.abort(new Error('Telegram pairing scope changed during result delivery.'));
    }
    await this.settleTaskDeliveryRuns();
    if (this.running) this.resumePendingTaskDeliveries();
    this.scheduleReminderDelivery();
    const revoked = before - this.state.pairings.length;
    if (revoked > 0) {
      await this.context?.emit('telegram.pairing.revoked', this.manifest.id, {
        chatId: requestedChatId ?? null,
        revoked,
      });
    }
    return {
      ok: revoked > 0,
      summary: revoked > 0 ? `Revoked ${revoked} Telegram pairing(s).` : 'No matching Telegram pairing was found.',
      ...(revoked > 0 ? {} : { error: 'telegram-pairing-not-found' }),
      output: this.statusPayload(false),
    };
  }

  private readonly updateFailures = new Map<number, number>();

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.callApi<TelegramUpdate[]>('getUpdates', {
          offset: this.state.offset,
          timeout: 25,
          limit: 50,
          allowed_updates: ['message', 'callback_query', ...(this.v2.settings().enabled ? ['stopped_message_generation'] : [])],
        }, signal);
        this.lastError = '';
        // A mock, proxy, or degraded Bot API may return an empty long-poll
        // immediately instead of holding it. Yield cooperatively so the retry
        // loop cannot starve other routing work.
        if (updates.length === 0) {
          await delay(25);
          continue;
        }
        for (const update of updates) {
          await this.refreshState();
          if (update.update_id < this.state.offset) continue;
          const nextOffset = update.update_id + 1;
          await this.context?.emit('telegram.update.received', this.manifest.id, { updateId: update.update_id });
          try {
            await this.handleUpdate(update, signal);
            this.updateFailures.delete(update.update_id);
          } catch (error) {
            // A transient failure retries the same update; one that keeps
            // failing would hold the cursor and every later message forever.
            const failures = (this.updateFailures.get(update.update_id) ?? 0) + 1;
            if (signal.aborted || failures < MAX_UPDATE_ATTEMPTS) {
              this.updateFailures.set(update.update_id, failures);
              throw error;
            }
            this.updateFailures.delete(update.update_id);
            await this.context?.audit('telegram', 'Telegram update skipped after repeated failures.',
              { updateId: update.update_id, attempts: failures, error: safeError(error) }, 'warn');
          }
          // Commit the Telegram cursor only after the update reached its durable
          // Turn-admission or synchronous-result boundary. Agent dispatch uses deterministic message ids,
          // so crash redelivery resumes the same Turn instead of losing a command
          // in the former offset-before-admission window.
          await this.advanceOffset(nextOffset);
        }
      } catch (error) {
        if (signal.aborted || !this.running) break;
        this.lastError = safeError(error);
        await this.context?.audit('telegram', 'Telegram polling failed.', { error: this.lastError }, 'warn');
        if (/409|terminated by other getUpdates/i.test(this.lastError)) {
          const ownershipMoved = new Error('Telegram polling ownership moved to another local runtime.');
          this.running = false;
          this.taskDeliveryGeneration += 1;
          this.reminderDeliveryPaused = true;
          this.reminderDeliveryAbort?.abort(ownershipMoved);
          this.pollingAbort?.abort(ownershipMoved);
          this.pollingAbort = null;
          if (this.reminderTimer) clearTimeout(this.reminderTimer);
          this.reminderTimer = null;
          this.reminderWatcher?.close();
          this.reminderWatcher = null;
          await this.reminderDeliveryTask?.catch(() => undefined);
          this.reminderDeliveryTask = null;
          this.reminderDeliveryAbort = null;
          await this.settleTaskDeliveryRuns();
          await this.releasePollingLock();
          this.standby = true;
          await this.context?.audit('telegram', 'Duplicate Telegram polling detected; this runtime switched to standby.', {}, 'warn');
          if (this.context) this.scheduleStandbyTakeover(this.context, this.lifecycleGeneration);
          break;
        }
        await delay(telegramRetryDelay(error, 1_500));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate, signal?: AbortSignal): Promise<void> {
    if (update.stopped_message_generation) {
      const stop = update.stopped_message_generation; const s = this.v2.settings();
      if (!s.enabled || stop.chat.type !== 'private' || stop.chat.id !== s.controlChatId || s.botId !== this.botIdentity?.id) return;
      const draft = this.v2.read<{ turnId: string; conversationId: string; threadId: number; epoch: string; expiresAt: number }>('draft-stop', String(stop.draft_id));
      if (!draft || draft.epoch !== s.pairingEpoch || draft.threadId !== (stop.message_thread_id ?? 0) || draft.expiresAt <= Date.now()) return;
      await this.v2Interface.bridge?.cancel(draft.turnId, draft.conversationId);
      this.v2.remove('draft-stop', String(stop.draft_id)); return;
    }
    const message = update.message ?? update.callback_query?.message;
    const threadId = message?.message_thread_id ?? 0;
    if (!Number.isSafeInteger(threadId) || threadId < 0) return;
    await this.topicContext.run({ threadId }, async () => {
      const startText = update.message?.text?.trim() ?? '';
      const pairingToken = startText.match(/^\/start(?:@\w+)?\s+v2_([A-Za-z0-9_-]{32})$/iu)?.[1];
      if (pairingToken && update.message?.chat.type === 'private' && update.message.from && !update.message.from.is_bot) {
        try {
          this.v2.proposePairing(pairingToken, { userId: update.message.from.id, chatId: update.message.chat.id,
            botId: Number(this.botIdentity?.id) });
          await this.sendText(update.message.chat.id, 'Запрос привязки получен. Подтверди свой аккаунт в Monarch на компьютере.');
        } catch { await this.sendText(update.message.chat.id, 'Ссылка привязки истекла. Создай новую в Monarch.'); }
        return;
      }
      // A plain Start in an existing V1 chat does not carry the one-time challenge.
      // Explain the pending migration without treating old pairing as V2 consent.
      if (update.message?.chat.type === 'private' && update.message.from && !update.message.from.is_bot
        && /^\/start(?:@\w+)?(?:\s+v2_\S*)?$/iu.test(startText)) {
        const challenge = this.v2.read<{ expiresAt: number }>('pair-challenge', 'current');
        if (challenge && challenge.expiresAt > Date.now()) {
          if (!this.consumeRateLimit(update.message.from.id)) return;
          await this.sendText(update.message.chat.id, 'Monarch ждёт привязку Oscar V2. Обычный /start не содержит код подключения. Вернись к шагу 2 в Monarch и открой новую ссылку. Если Telegram открывает старый чат, раскрой «Уже пользовался этим ботом?» и скопируй команду оттуда целиком. Затем подтверди аккаунт на компьютере.');
          return;
        }
      }
      if (this.v2.settings().pairingEpoch) {
        const userId = update.message?.from?.id ?? update.callback_query?.from.id;
        if (!message || message.chat.type !== 'private' || !userId) return;
        const settings = this.v2.settings();
        if (!settings.enabled || settings.controlChatId !== message.chat.id || settings.ownerUserId !== userId
          || settings.botId !== this.botIdentity?.id) return;
        if (!this.consumeRateLimit(userId)) return;
        await this.syncGlobalMax();
        Object.assign(this.topicContext.getStore()!, { epoch: settings.pairingEpoch, ownerId: userId, chatId: message.chat.id });
        if (settings.paused) {
          // The UI independently verifies the exact owner/topic/message handle.
          // Only cancellation cards can execute in this restricted context.
          this.topicContext.getStore()!.cancellationOnly = true;
          if (update.callback_query && await this.v2Interface.callback(update.callback_query)) return;
          await this.sendText(message.chat.id, 'Удалённый доступ остановлен. Кнопки остановки задач продолжают работать. Возобновление доступно в Monarch.'); return;
        }
        if (update.callback_query) {
          const handle = update.callback_query.data?.startsWith('v2:') ? update.callback_query.data.slice(3) : '';
          const button = handle && this.v2.read<{ action: { kind: string } }>('ui-button', handle);
          if (button && ['cancel', 'stop-all'].includes(button.action.kind)) this.topicContext.getStore()!.cancellationOnly = true;
          if (await this.v2Interface.callback(update.callback_query)) return;
        }
        if (update.callback_query?.data?.startsWith('v2a:')) {
          const key = update.callback_query.data.slice(4);
          const b = this.v2.read<{ data: string; messageId: number; threadId: number; epoch: string; expiresAt: number }>('action-button', key);
          if (!b || b.messageId !== message.message_id || b.threadId !== threadId || b.epoch !== settings.pairingEpoch || b.expiresAt <= Date.now()) {
            await this.callApi('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Подтверждение устарело.' }); return;
          }
          this.v2.remove('action-button', key);
          this.topicContext.getStore()!.conversationBound = true;
          await this.handleCallback({ ...update.callback_query, data: b.data }); return;
        }
        if (/^(arm|approve|deny):/u.test(update.callback_query?.data ?? '')) {
          await this.callApi('answerCallbackQuery', { callback_query_id: update.callback_query!.id, text: 'Старая карточка не переносит разрешения V2.' }); return;
        }
        if (update.message && await this.v2Interface.message(update.message)) return;
        this.topicContext.getStore()!.conversationBound = true;
        const text = message.text ?? (message as TelegramMessage).caption ?? '';
        if (/MONARCH_TELEGRAM_COMMAND_V1/u.test(text)
          || text.startsWith('/') && !/^\/(help|status|stop_task)(?:@\w+)?(?:\s|$)/u.test(text)) {
          await this.sendText(message.chat.id, 'Общий доступ к API закрыт. Используй меню и обычные поручения.'); return;
        }
      }
      await this.handleTransportUpdate(update, signal);
    });
  }

  async receiveCloudUpdate(update: unknown): Promise<void> {
    if (!this.cloudMode || !this.running || !update || typeof update !== 'object') throw Error('telegram-cloud:inactive');
    await this.handleUpdate(update as TelegramUpdate, this.pollingAbort?.signal);
  }

  async prepareCloudTaskContext(task: DeferredPcTask): Promise<Record<string, unknown>> {
    if (!this.cloudMode || !this.running || this.v2.settings().paused) throw Error('telegram-cloud:inactive');
    await this.syncGlobalMax();
    const owner = this.v2.settings();
    if (task.chatId !== owner.controlChatId || task.pairingEpoch !== owner.pairingEpoch) throw Error('telegram-cloud:owner');
    if (!this.v2.binding(task.threadId)) {
      const conversation = await this.v2Interface.bridge?.create('Поручение из Telegram');
      if (!conversation) throw Error('telegram-cloud:history-unavailable');
      this.v2.bind(task.threadId, conversation.id, conversation.title);
    }
    return this.v2.context(task.chatId, owner.ownerUserId, task.threadId, task.messageId,
      telegramIntentContext(task.chatId, owner.ownerUserId, task.messageId, false, owner.pairingEpoch, false, false), task.text);
  }

  private async handleTransportUpdate(update: TelegramUpdate, signal?: AbortSignal): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.from || message.from.is_bot) return;
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasDocument = Boolean(message.document);
    const hasImageDocument = isValidTelegramImageDocument(message.document);
    const hasTextDocument = isValidTelegramTextDocument(message.document);
    const hasOfficeDocument = this.v2.settings().enabled && isValidTelegramOfficeDocument(message.document);
    const hasImageAttachment = hasPhoto || hasImageDocument;
    const hasFileAttachment = hasImageAttachment || hasTextDocument || hasOfficeDocument;
    const hasVoiceNote = Boolean(message.voice);
    const text = String(message.text || message.caption
      || (hasTextDocument || hasOfficeDocument ? 'Разбери приложенный документ.'
        : hasImageAttachment || hasDocument ? 'Опиши это изображение.'
        : hasVoiceNote ? 'Выполни задачу из голосового сообщения.' : '')).trim();
    if (!text || text.length > MAX_COMMAND_CHARS) return;
    if (!this.v2.settings().enabled && !this.consumeRateLimit(message.from.id)) {
      if (this.shouldSendRateLimitNotice(message.from.id)) {
        await this.sendText(message.chat.id, 'Слишком много запросов. Telegram-вход временно приторможен.');
      }
      return;
    }

    const pairingInput = /^\/pair(?:@\w+)?(?:\s+\d{6})?\s*$/i.test(text) || /^\d{6}$/.test(text);
    const pairingReplay = pairingInput && this.state.pairings.some((entry) => (
      entry.chatId === message.chat.id
      && entry.userId === message.from!.id
      && entry.sourceMessageId === message.message_id
    ));
    if (pairingReplay) {
      await this.sendText(message.chat.id, 'Готово — этот Telegram update уже создал текущую привязку Monarch.');
      return;
    }
    if (/^\/pair(?:@\w+)?(?:\s+\d{6})?\s*$/i.test(text)) {
      await this.handlePair(message, text);
      return;
    }
    if (/^\d{6}$/.test(text) && !this.isPaired(message.chat.id, message.from.id)) {
      await this.handlePair(message, `/pair ${text}`);
      return;
    }
    if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(text) && !this.isPaired(message.chat.id, message.from.id)) {
      await this.ensureFreshPairingCode();
      await this.sendText(message.chat.id, this.state.remotePaused
        ? 'Новые привязки временно отключены локальным режимом защиты Monarch.'
        : telegramPairingHelp());
      return;
    }
    if (!this.isPaired(message.chat.id, message.from.id)) {
      await this.sendText(message.chat.id, this.state.remotePaused
        ? 'Новые привязки временно отключены локальным режимом защиты Monarch.'
        : telegramPairingHelp());
      return;
    }
    if (typeof message.media_group_id === 'string' && message.media_group_id.trim()) {
      if (this.shouldSendMediaGroupNotice(message.chat.id, message.media_group_id)) {
        await this.sendText(message.chat.id, 'Альбом не принят: отправь одно изображение отдельно, чтобы Monarch создал ровно одну Agent-задачу.');
      }
      return;
    }
    if (hasPhoto && hasDocument) {
      await this.sendText(message.chat.id, 'Один Telegram update может содержать только одно изображение для Agent-задачи.');
      return;
    }
    if (hasVoiceNote && (hasFileAttachment || hasDocument)) {
      await this.sendText(message.chat.id, 'Один Telegram update не может одновременно стать голосовой и файловой Agent-задачей.');
      return;
    }
    if (hasDocument && !hasImageDocument && !hasTextDocument && !hasOfficeDocument) {
      await this.sendText(message.chat.id, 'Файл не принят: доступны PNG/JPEG/WebP до 8 МиБ либо строгий UTF-8 TXT/Markdown/JSON до 32 КиБ. PDF/DOCX требуют отдельного безопасного extractor и пока не передаются агенту.');
      return;
    }
    if (hasFileAttachment || hasVoiceNote) {
      const attachmentCommand = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase() || '';
      if (this.state.remotePaused) {
        await this.sendText(message.chat.id, `${hasVoiceNote ? 'Голосовое сообщение' : hasTextDocument ? 'Документ' : 'Изображение'} не загружено: удалённые задачи остановлены локальным защитным режимом.`);
        return;
      }
      if (attachmentCommand && attachmentCommand !== 'task') {
        await this.sendText(message.chat.id, 'Медиа можно отправить обычной Agent-задачей. Команды управления не принимают вложения.');
        return;
      }
      const replayRequestId = `telegram:${message.chat.id}:${message.message_id}`;
      const pendingReplay = this.state.pendingTaskDeliveries.find((entry) => (
        entry.clientRequestId === replayRequestId
        && entry.chatId === message.chat.id
        && entry.userId === message.from!.id
        && entry.sourceMessageId === message.message_id
      ));
      if (pendingReplay) {
        this.schedulePendingTaskDelivery(pendingReplay);
        return;
      }
    }
    let attachments: TelegramIntentAttachment[] = [];
    let voiceNote: TelegramIntentVoiceNote | undefined;
    if (hasFileAttachment || hasVoiceNote) {
      const ingressAbort = new AbortController();
      const ingressSignal = signal
        ? AbortSignal.any([signal, ingressAbort.signal])
        : ingressAbort.signal;
      this.attachmentIngressAborts.add(ingressAbort);
      try {
        if (hasVoiceNote) voiceNote = await this.prepareVoiceNote(message, ingressSignal);
        else if (hasOfficeDocument) {
          const document = message.document!;
          const data = await this.downloadTelegramAttachment(document.file_id, ingressSignal);
          const format = document.mime_type === 'application/pdf' ? 'pdf' : 'docx';
          const extracted = await extractTelegramDocument(this.projectRoot, format, data, ingressSignal);
          attachments = [{ idempotencyKey: telegramAttachmentIdempotencyKey(message, document.file_unique_id),
            name: `telegram-${format}-${message.message_id}.txt`, mimeType: 'text/plain', dataBase64: Buffer.from(extracted).toString('base64') }];
        }
        else if (hasTextDocument) attachments = [await this.prepareTextDocumentAttachment(message, ingressSignal)];
        else attachments = [await this.prepareImageAttachment(message, ingressSignal)];
      } catch (error) {
        if (signal?.aborted) throw new TelegramUpdateRetryError(error);
        if (ingressAbort.signal.aborted) {
          await this.sendText(message.chat.id, `${hasVoiceNote ? 'Голосовое сообщение' : hasTextDocument ? 'Документ' : 'Изображение'} не загружено: удалённые задачи остановлены локальным защитным режимом.`)
            .catch(() => undefined);
          return;
        }
        const failure = await this.projectRemoteFailure('attachment', error);
        await this.sendText(message.chat.id, `${hasVoiceNote ? 'Голосовое сообщение' : hasTextDocument ? 'Документ' : 'Изображение'} не принято: ${failure}`).catch(() => undefined);
        return;
      } finally {
        this.attachmentIngressAborts.delete(ingressAbort);
      }
    }
    try {
      await this.handlePairedMessage(message, text, attachments, voiceNote);
    } catch (error) {
      if (error instanceof TelegramUpdateRetryError) throw error;
      if (signal?.aborted) throw new TelegramUpdateRetryError(error);
      const failure = await this.projectRemoteFailure('command', error);
      await this.sendText(message.chat.id, `Команда Telegram не выполнена: ${failure}`).catch(() => undefined);
    }
  }

  private async handlePair(message: TelegramMessage, text: string): Promise<void> {
    const code = text.replace(/^\/pair(?:@\w+)?(?:\s+|$)/i, '').trim();
    await this.ensureFreshPairingCode();
    if (this.state.remotePaused) {
      await this.sendText(message.chat.id, 'Новые привязки временно отключены локальным режимом защиты Monarch.');
      return;
    }
    if (message.chat.type !== 'private' && process.env.MONARCH_TELEGRAM_ALLOW_GROUPS !== '1') {
      await this.sendText(message.chat.id, 'Для первой привязки используй личный чат с ботом.');
      return;
    }
    if (!code) {
      await this.sendText(message.chat.id, 'Открой Monarch Control → Telegram, создай код и пришли сюда шесть цифр одним сообщением.');
      return;
    }
    if (!message.from || !(await this.canAttemptPairing(message.chat.id, message.from.id))) {
      await this.sendText(message.chat.id, 'Слишком много неверных попыток. Новая проверка будет доступна позже.');
      return;
    }
    if (code !== this.pairingCode || Date.now() > this.pairingExpiresAt) {
      await this.recordPairingFailure(message.chat.id, message.from.id);
      await this.sendText(message.chat.id, 'Этот код не подошёл или уже истёк. Создай новый в Monarch Control → Telegram и пришли шесть цифр ещё раз.');
      return;
    }
    await this.clearPairingFailures(message.chat.id, message.from.id);
    const pairing: TelegramPairing = {
      chatId: message.chat.id,
      userId: message.from.id,
      pairedAt: new Date().toISOString(),
      sourceMessageId: message.message_id,
    };
    if (message.from.username) pairing.username = message.from.username;
    await this.mutateState((state) => {
      state.pairings = state.pairings.filter((entry) => entry.chatId !== pairing.chatId && entry.userId !== pairing.userId);
      state.pendingTaskDeliveries = state.pendingTaskDeliveries
        .filter((entry) => entry.chatId !== pairing.chatId || entry.userId !== pairing.userId);
      state.artifactEgressOffers = state.artifactEgressOffers
        .filter((entry) => entry.chatId !== pairing.chatId || entry.userId !== pairing.userId);
      state.pairings.push(pairing);
    });
    await this.rotatePairingCode();
    await this.context?.emit('telegram.paired', this.manifest.id, { chatId: pairing.chatId, userId: pairing.userId });
    await this.callApi('sendMessage', {
      chat_id: message.chat.id,
      text: 'Готово — связал этот чат с Monarch. Теперь просто напиши задачу обычным сообщением.',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Проверить связь', callback_data: 'quick:status' },
          { text: 'Что умеет бот', callback_data: 'quick:help' },
        ]],
      },
    });
  }

  private async handlePairedMessage(
    message: TelegramMessage,
    text: string,
    attachments: TelegramIntentAttachment[] = [],
    voiceNote?: TelegramIntentVoiceNote,
  ): Promise<void> {
    const command = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    const name = command?.[1]?.toLowerCase() || '';
    const args = command?.[2]?.trim() || '';
    const pendingCount = this.state.pendingTaskDeliveries.length;
    const pausedControlCommands = new Set([
      'start', 'help', 'status', 'whoami', 'unlink', 'lockdown', 'pending', 'stop_task',
      'plugins', 'security', 'skills', 'capabilities',
    ]);
    const plainControlQuestion = !name && (
      isTelegramStatusQuestion(text)
      || isTelegramCapabilityQuestion(text)
      || isTelegramPluginQuestion(text)
      || isTelegramSecurityQuestion(text)
    );
    if ((attachments.length > 0 || voiceNote) && name && name !== 'task') {
      await this.sendText(message.chat.id, 'Медиа можно отправить обычной Agent-задачей. Команды управления не принимают медиа.');
      return;
    }
    if (this.state.remotePaused && !pausedControlCommands.has(name) && !plainControlQuestion) {
      await this.sendText(message.chat.id, 'Удалённые задачи приостановлены. Возобновить их можно только локально в Monarch Control.');
      return;
    }
    if (name === 'start' || name === 'help') {
      await this.sendText(message.chat.id, telegramHelp());
      return;
    }
    if (name === 'status') {
      await this.sendText(message.chat.id, telegramStatusMessage(this.statusPayload(false), pendingCount));
      return;
    }
    if (name === 'whoami') {
      await this.sendText(message.chat.id, [
        'Текущая локальная привязка:',
        `chat_id: ${message.chat.id}`,
        `user_id: ${message.from!.id}`,
        `тип: ${message.chat.type}`,
      ].join('\n'));
      return;
    }
    if (name === 'unlink') {
      await this.callApi('sendMessage', {
        chat_id: message.chat.id,
        text: 'Отвязать этот Telegram-чат от Monarch? Активные доставки и напоминания этого чата будут удалены.',
        reply_markup: { inline_keyboard: [[
          { text: 'Отвязать этот чат', callback_data: 'control:unlink' },
          { text: 'Оставить связь', callback_data: 'control:keep' },
        ]] },
      });
      return;
    }
    if (name === 'lockdown') {
      const wasPaused = this.state.remotePaused;
      await this.setRemotePaused(true);
      await this.sendText(message.chat.id, wasPaused
        ? 'Защитный режим уже включён. Новые удалённые задачи заблокированы.'
        : 'Защитный режим включён немедленно. Новые привязки, задачи и подтверждения заблокированы до локального возобновления.');
      return;
    }
    if (name === 'pending') {
      const activity = await this.dispatcher?.inspect?.(this.telegramContext(message.chat.id, message.from!.id));
      await this.sendText(message.chat.id, formatTelegramActivity(activity, pendingCount));
      return;
    }
    if (name === 'stop_task') {
      const result = await this.dispatcher?.cancelLatest?.(this.telegramContext(message.chat.id, message.from!.id));
      await this.sendText(message.chat.id, result ? formatIntentResult(result) : 'Нет активной задачи этого чата для отмены.');
      return;
    }
    if (name === 'security') {
      if (this.state.remotePaused) {
        await this.sendText(message.chat.id, telegramSecurityHelp(this.statusPayload(false), pendingCount));
        return;
      }
      await this.dispatchTask(message.chat.id, message.from!.id, serializeTelegramAgentCommand(
        'telegram.capabilities.describe', { topic: 'security' }, message.chat.id,
      ), message.message_id);
      return;
    }
    if (name === 'skills' || name === 'capabilities') {
      if (this.state.remotePaused) {
        await this.sendText(message.chat.id, telegramCapabilityHelp(this.statusPayload(false), pendingCount, this.context));
        return;
      }
      await this.dispatchTask(message.chat.id, message.from!.id, serializeTelegramAgentCommand(
        'telegram.capabilities.describe', { topic: 'capabilities' }, message.chat.id,
      ), message.message_id);
      return;
    }
    if (name === 'plugins') {
      const result = this.describeCapabilitiesCapability({ topic: 'plugins' });
      await this.sendText(message.chat.id, String((result.output as Record<string, unknown>).reply || result.summary));
      return;
    }
    if (name === 'remind') {
      if (this.isZeroRetentionEnabled()) {
        await this.sendText(message.chat.id, 'Напоминания отключены: Owner DEV «Полная незапись» запрещает сохранять их текст на диск.');
        return;
      }
      await this.dispatchReminderCreation(message.chat.id, message.from!.id, args, message.message_id);
      return;
    }
    if (name === 'astra_read') {
      const [targetAlias = '', ...promptParts] = args.split(/\s+/u);
      const prompt = promptParts.join(' ').trim();
      if (!/^astra_remote_alias_[a-f0-9]{32}$/u.test(targetAlias) || !prompt) {
        await this.sendText(message.chat.id, 'Формат: /astra_read ALIAS что именно прочитать. Alias заранее выдаётся локально в Monarch.');
        return;
      }
      await this.dispatchTask(message.chat.id, message.from!.id, prompt, message.message_id, false,
        { operation: 'workspace-read', targetAlias });
      return;
    }
    if (name === 'reminders') {
      await this.dispatchTask(
        message.chat.id,
        message.from!.id,
        serializeTelegramAgentCommand('telegram.reminder.list', { chatId: message.chat.id }, message.chat.id),
        message.message_id,
      );
      return;
    }
    if (name === 'cancel') {
      await this.dispatchReminderCancellation(message.chat.id, message.from!.id, args, message.message_id);
      return;
    }
    if (name === 'poll') {
      await this.dispatchPollFromCommand(message.chat.id, message.from!.id, args, message.message_id);
      return;
    }
    if (name === 'table') {
      await this.dispatchTableFromCommand(message.chat.id, message.from!.id, args, message.message_id);
      return;
    }
    if (name === 'api') {
      await this.callApiFromCommand(message.chat.id, message.from!.id, args, message.message_id);
      return;
    }
    if (name && name !== 'task') {
      await this.sendText(message.chat.id, `Команды /${name} нет. Используй /help или просто напиши задачу обычным текстом.`);
      return;
    }
    const naturalReminder = parseNaturalReminder(text);
    if (naturalReminder) {
      if (attachments.length > 0 || voiceNote) {
        await this.sendText(message.chat.id, 'Напоминание с медиа пока не поддерживается. Отправь медиа отдельной Agent-задачей.');
        return;
      }
      if (this.isZeroRetentionEnabled()) {
        await this.sendText(message.chat.id, 'Напоминания отключены: Owner DEV «Полная незапись» запрещает сохранять их текст на диск.');
        return;
      }
      const reminderInput = parseReminderPayload(naturalReminder.text, naturalReminder.dueAt);
      if (!reminderInput.ok) {
        await this.sendText(message.chat.id, reminderCommandErrorMessage(reminderInput.summary));
        return;
      }
      await this.dispatchTask(
        message.chat.id,
        message.from!.id,
        serializeTelegramAgentCommand('telegram.reminder.create', {
          chatId: message.chat.id, text: reminderInput.text, dueAt: reminderInput.dueAt,
        }, message.chat.id),
        message.message_id,
      );
      return;
    }
    await this.dispatchTask(
      message.chat.id,
      message.from!.id,
      name === 'task' ? args : text,
      message.message_id,
      name !== 'task',
      undefined,
      attachments,
      voiceNote,
    );
  }

  private async dispatchTask(
    chatId: number,
    userId: number,
    text: string,
    messageId?: number,
    allowContinuation = false,
    astraRemote?: TelegramIntentDispatchRequest['astraRemote'],
    attachments: TelegramIntentAttachment[] = [],
    voiceNote?: TelegramIntentVoiceNote,
  ): Promise<void> {
    if (!text || !this.dispatcher) {
      await this.sendText(chatId, this.dispatcher ? 'Напиши задачу после /task.' : 'Monarch ещё не подключил внутренний dispatcher.');
      return;
    }
    const context = this.telegramContext(chatId, userId, messageId, allowContinuation, text);
    if (astraRemote && (!this.dispatcher.admit || !this.dispatcher.resume || this.isZeroRetentionEnabled())) {
      await this.sendText(chatId, 'Astra remote read сейчас недоступен: нужен persistent режим и активный Astra pilot.');
      return;
    }
    if (this.isZeroRetentionEnabled()
      || !Number.isSafeInteger(messageId)
      || Number(messageId) <= 0
      || !this.dispatcher.admit
      || !this.dispatcher.resume) {
      await this.dispatchTaskSynchronously(chatId, text, context, attachments, voiceNote);
      return;
    }
    const clientRequestId = String(context.clientRequestId || '');
    await this.refreshState();
    const existing = this.state.pendingTaskDeliveries.find((entry) => entry.clientRequestId === clientRequestId);
    if (existing) {
      this.schedulePendingTaskDelivery(existing);
      return;
    }
    let progress: TelegramMessage;
    try {
      progress = await this.callApi<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: 'Проверяю задачу и условия запуска…',
      });
    } catch (error) {
      throw new TelegramUpdateRetryError(error);
    }
    try {
      const ownerSignal = this.pollingAbort?.signal;
      const admission = await this.dispatcher.admit({
        text,
        context,
        ...(astraRemote ? { astraRemote } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(voiceNote ? { voiceNote } : {}),
      }, ownerSignal);
      if (admission.clientRequestId !== clientRequestId || admission.privacyMode !== 'persistent') {
        throw new Error('Telegram dispatcher returned a mismatched durable admission.');
      }
      const pending: TelegramPendingTaskDelivery = {
        ...admission,
        ...(this.v2.settings().enabled ? { threadId: this.topicContext.getStore()?.threadId ?? 0,
          pairingEpoch: this.v2.settings().pairingEpoch } : {}),
        chatId,
        userId,
        sourceMessageId: Number(messageId),
        progressMessageId: progress.message_id,
        projectedTurnStatus: 'accepted',
        createdAt: new Date().toISOString(),
      };
      await this.mutateState((state) => {
        const replay = state.pendingTaskDeliveries.find((entry) => entry.clientRequestId === clientRequestId);
        if (replay && replay.turnId !== pending.turnId) {
          throw new Error('Telegram client request is already bound to another Turn.');
        }
        if (!replay) {
          if (state.pendingTaskDeliveries.length >= MAX_PENDING_TASK_DELIVERIES) {
            throw new Error('Telegram durable delivery queue is full.');
          }
          state.pendingTaskDeliveries.push(pending);
        }
      });
      if (pending.pairingEpoch) await this.v2Interface.bindTaskCard({ message_id: pending.progressMessageId,
        message_thread_id: pending.threadId ?? 0, chat: { id: pending.chatId, type: 'private' } }, pending.turnId).catch(() => undefined);
      this.schedulePendingTaskDelivery(pending);
    } catch (error) {
      if (this.pollingAbort?.signal.aborted) throw new TelegramUpdateRetryError(error);
      if (error instanceof TelegramIntentRejectedError) {
        await this.completeTaskMessage(chatId, progress.message_id, error.userMessage).catch(() => undefined);
        return;
      }
      const failure = await this.projectRemoteFailure('admission', error);
      await this.completeTaskMessage(chatId, progress.message_id, `Задача пока не принята: ${failure} Повторяю безопасно.`)
        .catch(() => undefined);
      throw new TelegramUpdateRetryError(error);
    }
  }

  private async dispatchTaskSynchronously(
    chatId: number,
    text: string,
    context: Record<string, unknown>,
    attachments: TelegramIntentAttachment[] = [],
    voiceNote?: TelegramIntentVoiceNote,
  ): Promise<void> {
    const ownerSignal = this.pollingAbort?.signal;
    let progress: TelegramMessage;
    try {
      progress = await this.callApi<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: 'Проверяю задачу и условия запуска…',
      }, ownerSignal);
    } catch (error) {
      // Nothing was dispatched yet, so redelivery is harmless - exactly as on
      // the durable admission path. Reported as an ordinary command failure, a
      // transient 429 here advanced the cursor and silently lost the message.
      throw new TelegramUpdateRetryError(error);
    }
    const sendTyping = () => this.callApi('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    }, ownerSignal).catch(() => undefined);
    await sendTyping();
    const typingTimer = setInterval(() => void sendTyping(), 4_000);
    try {
      const result = await this.dispatcher!({
        text,
        context,
        ...(attachments.length ? { attachments } : {}),
        ...(voiceNote ? { voiceNote } : {}),
      }, ownerSignal);
      ownerSignal?.throwIfAborted();
      await this.deliverTaskResult(chatId, progress.message_id, result, undefined, ownerSignal);
    } catch (error) {
      if (ownerSignal?.aborted) throw new TelegramUpdateRetryError(error);
      if (error instanceof TelegramIntentRejectedError) {
        await this.completeTaskMessage(chatId, progress.message_id, error.userMessage).catch(() => undefined);
        return;
      }
      const failure = await this.projectRemoteFailure('task', error);
      await this.completeTaskMessage(chatId, progress.message_id, `Не получилось завершить задачу: ${failure}`);
    } finally {
      clearInterval(typingTimer);
    }
  }

  private resumePendingTaskDeliveries(): void {
    if (this.isZeroRetentionEnabled() || !this.dispatcher?.resume) return;
    for (const pending of this.state.pendingTaskDeliveries) this.schedulePendingTaskDelivery(pending);
  }

  private schedulePendingTaskDelivery(pending: TelegramPendingTaskDelivery, delayMs = 0): void {
    if (this.taskDeliveryRuns.has(pending.clientRequestId)) return;
    const generation = this.taskDeliveryGeneration;
    const begin = () => {
      if (!this.running || generation !== this.taskDeliveryGeneration || this.taskDeliveryRuns.has(pending.clientRequestId)) return;
      const ownerSignal = this.pollingAbort?.signal;
      if (!ownerSignal || ownerSignal.aborted) return;
      const deliveryAbort = new AbortController();
      const deliverySignal = AbortSignal.any([ownerSignal, deliveryAbort.signal]);
      this.taskDeliveryAborts.set(pending.clientRequestId, deliveryAbort);
      let retryDelay: number | null = null;
      const run = this.topicContext.run({ threadId: pending.threadId ?? 0 }, () => this.deliverPendingTask(pending, generation, deliverySignal))
        .then((delay) => { retryDelay = delay; })
        .finally(() => {
          if (this.taskDeliveryAborts.get(pending.clientRequestId) === deliveryAbort) {
            this.taskDeliveryAborts.delete(pending.clientRequestId);
          }
          if (this.taskDeliveryRuns.get(pending.clientRequestId) === run) {
            this.taskDeliveryRuns.delete(pending.clientRequestId);
            if (retryDelay !== null) this.schedulePendingTaskDelivery(pending, retryDelay);
          }
        });
      this.taskDeliveryRuns.set(pending.clientRequestId, run);
    };
    if (delayMs <= 0) begin();
    else {
      const timer = setTimeout(begin, delayMs);
      timer.unref?.();
    }
  }

  private async deliverPendingTask(
    pending: TelegramPendingTaskDelivery,
    generation: number,
    ownerSignal: AbortSignal,
  ): Promise<number | null> {
    return this.pendingDeliveryContext.run(pending, () => this.deliverPendingTaskOnce(pending, generation, ownerSignal));
  }

  private pendingDeliveryAllowed(pending: TelegramPendingTaskDelivery): boolean {
    if (!pending.pairingEpoch) return !this.v2.settings().pairingEpoch;
    const settings = this.v2.settings();
    const binding = this.v2.binding(pending.threadId ?? 0);
    return settings.enabled && !settings.paused && settings.pairingEpoch === pending.pairingEpoch
      && settings.ownerUserId === pending.userId && settings.controlChatId === pending.chatId
      && Boolean(binding && !binding.localOnly && !binding.archived);
  }

  private async deliverPendingTaskOnce(
    pending: TelegramPendingTaskDelivery,
    generation: number,
    ownerSignal: AbortSignal,
  ): Promise<number | null> {
    try {
      if (ownerSignal.aborted) return null;
      const settings = this.v2.settings();
      if (settings.enabled && (settings.paused || pending.pairingEpoch !== settings.pairingEpoch)) return null;
      const result = await this.dispatcher!.resume!(pending, this.telegramContext(
        pending.chatId,
        pending.userId,
        pending.sourceMessageId,
      ), ownerSignal);
      if (!this.running || generation !== this.taskDeliveryGeneration) return null;
      if (ownerSignal.aborted || !this.pendingDeliveryAllowed(pending)) return null;
      if (result.execution?.error === 'turn-running') {
        if (pending.pairingEpoch) await this.projectNativeDraft(pending, ownerSignal);
        await this.projectDurableTaskProgress(pending, result, ownerSignal);
        return 1_000;
      }
      const artifactOffers = result.execution?.ok
        ? await this.dispatcher!.listArtifacts?.(
          pending,
          this.telegramContext(pending.chatId, pending.userId, pending.sourceMessageId),
          ownerSignal,
        ) || []
        : [];
      if (ownerSignal.aborted || !this.pendingDeliveryAllowed(pending)) return null;
      await this.deliverTaskResult(
        pending.chatId,
        pending.progressMessageId,
        result,
        pending,
        ownerSignal,
        artifactOffers,
      );
      await this.mutateState((state) => {
        state.pendingTaskDeliveries = state.pendingTaskDeliveries
          .filter((entry) => entry.clientRequestId !== pending.clientRequestId);
      });
      return null;
    } catch (error) {
      if (!this.running || generation !== this.taskDeliveryGeneration) return null;
      if (ownerSignal.aborted || !this.pendingDeliveryAllowed(pending)) return null;
      if (error instanceof TelegramIntentRejectedError) {
        // A rejection is final: retrying it every few seconds only hides the
        // reply. Tell the person and release the delivery binding.
        try {
          await this.completeTaskMessage(pending.chatId, pending.progressMessageId, error.userMessage, pending, ownerSignal);
          await this.mutateState((state) => {
            state.pendingTaskDeliveries = state.pendingTaskDeliveries
              .filter((entry) => entry.clientRequestId !== pending.clientRequestId);
          });
          return null;
        } catch (projectionError) {
          this.lastError = `Telegram result delivery pending: ${safeError(projectionError)}`;
          return telegramRetryDelay(projectionError, 5_000);
        }
      }
      this.lastError = `Telegram result delivery pending: ${safeError(error)}`;
      await this.context?.audit('telegram', 'Durable Telegram result delivery will be retried.', {
        clientRequestId: pending.clientRequestId,
        turnId: pending.turnId,
        error: safeError(error),
      }, 'warn');
      return telegramRetryDelay(error, 5_000);
    }
  }

  private async projectDurableTaskProgress(
    pending: TelegramPendingTaskDelivery,
    result: MonarchIntentResult,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = readTelegramDurableProgressStatus(result);
    if (!status || status === pending.projectedTurnStatus) return;
    await this.editTaskMessage({
      chat_id: pending.chatId,
      message_id: pending.progressMessageId,
      text: formatTelegramDurableProgress(status),
      link_preview_options: { is_disabled: true },
    }, signal);
    await this.mutateState((state) => {
      const entry = state.pendingTaskDeliveries.find((item) => (
        item.clientRequestId === pending.clientRequestId
        && item.turnId === pending.turnId
        && item.chatId === pending.chatId
        && item.progressMessageId === pending.progressMessageId
      ));
      if (!entry) throw new Error('Telegram progress projection lost its durable Turn binding.');
      entry.projectedTurnStatus = status;
    });
    pending.projectedTurnStatus = status;
  }

  private async projectNativeDraft(pending: TelegramPendingTaskDelivery, signal: AbortSignal): Promise<void> {
    const key = String(pending.progressMessageId);
    const existing = this.v2.read<{ updatedAt?: number; unsupported?: boolean }>('draft-stop', key);
    if (existing?.unsupported || (existing?.updatedAt ?? 0) > Date.now() - 20_000) return;
    const binding = this.v2.binding(pending.threadId ?? 0); if (!binding || !this.v2Interface.bridge) return;
    this.v2.put('draft-stop', key, { turnId: pending.turnId, conversationId: binding.conversationId,
      threadId: pending.threadId ?? 0, epoch: pending.pairingEpoch, expiresAt: Date.now() + 40_000, updatedAt: Date.now() });
    try { await this.callApi('sendMessageDraft', { chat_id: pending.chatId, ...(pending.threadId ? { message_thread_id: pending.threadId } : {}),
      draft_id: pending.progressMessageId, text: '', can_stop: true, keep_on_stop: false }, signal); }
    catch { this.v2.put('draft-stop', key, { unsupported: true }); }
  }

  private async deliverTaskResult(
    chatId: number,
    progressMessageId: number,
    result: MonarchIntentResult,
    pending?: TelegramPendingTaskDelivery,
    signal?: AbortSignal,
    artifactOffers: TelegramArtifactOfferDescriptor[] = [],
  ): Promise<void> {
    const presentation = readTelegramApprovalPresentation(result);
    if (result.execution?.error === 'confirmation-required' && presentation) {
      const action = presentation.requiresArm ? 'arm' : 'approve';
      const actionLabel = presentation.requiresArm ? 'Arm' : 'Разрешить один раз';
      const callbackData = (value: string) => this.sealActionButton(value, progressMessageId);
      await this.editTaskMessage({
        chat_id: chatId,
        message_id: progressMessageId,
        text: formatTelegramApprovalCard(result.execution.summary, presentation),
        reply_markup: {
          inline_keyboard: [[
            { text: actionLabel, callback_data: callbackData(`${action}:${presentation.approvalId}`) },
            { text: 'Отклонить', callback_data: callbackData(`deny:${presentation.approvalId}`) },
          ]],
        },
      }, signal);
      return;
    }
    if (result.execution && !result.execution.ok) {
      const failure = await this.projectRemoteFailure(
        'task',
        new Error(result.execution.summary || result.summary || 'Telegram task failed.'),
        readExecutionUserFacingMessage(result.execution),
      );
      await this.completeTaskMessage(chatId, progressMessageId, `Не получилось: ${failure}`, pending, signal);
      return;
    }
    const replyMarkup = pending && artifactOffers.length > 0
      ? await this.sealArtifactEgressOffers(pending, artifactOffers)
      : undefined;
    await this.completeTaskMessage(chatId, progressMessageId, formatIntentResult(result), pending, signal, replyMarkup);
  }

  private sealActionButton(data: string, messageId: number, ttlMs = 600_000): string {
    if (!this.v2.settings().enabled) return data;
    const key = randomUUID().replaceAll('-', '');
    this.v2.put('action-button', key, { data, messageId,
      threadId: this.topicContext.getStore()?.threadId ?? 0,
      epoch: this.v2.settings().pairingEpoch, expiresAt: Date.now() + ttlMs });
    return `v2a:${key}`;
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const chatId = callback.message?.chat.id;
    if (!chatId || !this.isPaired(chatId, callback.from.id)) return;
    const [actionValue, id] = String(callback.data || '').split(':', 2);
    const action = actionValue || '';
    if (action === 'quick') {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => undefined);
      await this.sendText(chatId, id === 'status'
        ? 'Связь работает. Этот чат подключён к локальному Monarch.'
        : telegramHelp());
      return;
    }
    if (action === 'control' && ['unlink', 'keep'].includes(id || '')) {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => undefined);
      if (id === 'unlink') await this.revokePairingCapability({ chatId });
      if (callback.message?.message_id) {
        await this.editTaskMessage({
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: id === 'unlink' ? 'Этот Telegram-чат отвязан от Monarch.' : 'Связь с Monarch сохранена.',
          reply_markup: { inline_keyboard: [] },
        });
      }
      return;
    }
    if (this.state.remotePaused) {
      await this.callApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Удалённые задачи остановлены локальным защитным режимом.',
      }).catch(() => undefined);
      if (callback.message?.message_id) {
        await this.callApi('editMessageText', {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: 'Удалённые задачи остановлены локальным защитным режимом. Повтори действие после локального возобновления доступа.',
        }).catch(() => undefined);
      }
      return;
    }
    if (action === 'artifact') {
      await this.handleArtifactEgressCallback(callback, id || '');
      return;
    }
    if (!id || !/^[A-Za-z0-9._-]{1,56}$/u.test(id) || !['arm', 'approve', 'deny'].includes(action)) {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Неизвестное действие.' }).catch(() => undefined);
      return;
    }
    if (!this.dispatcher) {
      await this.callApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Локальный Agent Runtime пока недоступен. Действие не отправлено.',
      }).catch(() => undefined);
      return;
    }
    const ownerSignal = this.pollingAbort?.signal;
    let callbackAcknowledged = false;
    let dispatchCompleted = false;
    try {
      await this.callApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Проверяю действие…',
      }, ownerSignal);
      callbackAcknowledged = true;
      const result = await this.dispatcher({
        text: '',
        approval: { action: action as 'arm' | 'approve' | 'deny', approvalId: id },
        context: this.telegramContext(chatId, callback.from.id),
      }, ownerSignal);
      ownerSignal?.throwIfAborted();
      dispatchCompleted = true;
      if (action === 'arm') {
        const presentation = readTelegramApprovalPresentation(result);
        if (!presentation) throw new Error('Карточка approval больше не актуальна.');
        await this.callApi('editMessageText', {
          chat_id: chatId,
          message_id: callback.message?.message_id,
          text: `${formatTelegramApprovalCard(result.execution?.summary || result.summary, presentation)}\n\nArm активен 8 секунд.`,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Разрешить сейчас', callback_data: this.sealActionButton(`approve:${id}`, callback.message!.message_id, 8_000) },
              { text: 'Отклонить', callback_data: this.sealActionButton(`deny:${id}`, callback.message!.message_id, 8_000) },
            ]],
          },
        }, ownerSignal);
        return;
      }
      if (callback.message?.message_id) {
        await this.completeTaskMessage(chatId, callback.message.message_id, formatIntentResult(result), undefined, ownerSignal);
      } else {
        await this.sendText(chatId, formatIntentResult(result), ownerSignal);
      }
    } catch (error) {
      if (ownerSignal?.aborted) throw new TelegramUpdateRetryError(error);
      if (!callbackAcknowledged) {
        await this.callApi('answerCallbackQuery', {
          callback_query_id: callback.id,
          text: 'Карточка устарела или не принадлежит этому чату.',
        }).catch(() => undefined);
      }
      const failure = await this.projectRemoteFailure(dispatchCompleted ? 'delivery' : 'approval', error);
      await this.sendText(chatId, dispatchCompleted
        ? `Действие обработано локальным runtime, но Telegram не подтвердил доставку результата: ${failure}`
        : `Не удалось подтвердить состояние действия: ${failure}`);
    }
  }

  private async dispatchReminderCreation(chatId: number, userId: number, args: string, messageId?: number): Promise<void> {
    const parsed = parseReminderCommand(args);
    if (!parsed) {
      await this.sendText(chatId, 'Формат: /remind 10m текст или /remind 2026-06-30T18:00:00+03:00 текст');
      return;
    }
    const reminderInput = parseReminderPayload(parsed.text, parsed.dueAt);
    if (!reminderInput.ok) {
      await this.sendText(chatId, reminderCommandErrorMessage(reminderInput.summary));
      return;
    }
    await this.dispatchTask(
      chatId,
      userId,
      serializeTelegramAgentCommand('telegram.reminder.create', {
        chatId, text: reminderInput.text, dueAt: reminderInput.dueAt,
      }, chatId),
      messageId,
    );
  }

  private async createReminder(chatId: number, text: string, dueAt: string, signal?: AbortSignal,
    binding?: { threadId: number; pairingEpoch: string }): Promise<TelegramReminder> {
    signal?.throwIfAborted();
    if (this.isZeroRetentionEnabled()) {
      throw new Error('Telegram reminder persistence is disabled by zero-retention DEV policy.');
    }
    const reminderInput = parseReminderPayload(text, dueAt);
    if (!reminderInput.ok) throw new Error(reminderInput.summary);
    const reminder: TelegramReminder = {
      ...binding,
      id: randomUUID().slice(0, 8),
      chatId,
      text: reminderInput.text,
      dueAt: reminderInput.dueAt,
      createdAt: new Date().toISOString(),
    };
    await this.mutateState((state) => {
      state.reminders.push(reminder);
    }, signal);
    this.scheduleReminderDelivery();
    return reminder;
  }

  private async dispatchReminderCancellation(chatId: number, userId: number, id: string, messageId?: number): Promise<void> {
    const normalizedId = id.trim();
    if (!normalizedId || normalizedId.length > 128) {
      await this.sendText(chatId, 'Формат: /cancel ID из списка /reminders.');
      return;
    }
    await this.dispatchTask(
      chatId,
      userId,
      serializeTelegramAgentCommand('telegram.reminder.cancel', { id: normalizedId, chatId }, chatId),
      messageId,
    );
  }

  private async deliverDueReminders(signal: AbortSignal): Promise<void> {
    if (!this.running) return;
    signal.throwIfAborted();
    if (this.isZeroRetentionEnabled()) {
      await this.mutateState((state) => {
        state.reminders = [];
      }, signal);
      this.reminderFailureStreak = 0;
      this.reminderRetryNotBefore = 0;
      return;
    }
    await this.refreshState();
    signal.throwIfAborted();
    const now = Date.now();
    const due = this.state.reminders.filter((item) => !item.deliveryState && Date.parse(item.dueAt) <= now);
    if (!due.length) return;
    let hadFailure = false;
    for (const reminder of due) {
      try {
        signal.throwIfAborted();
        await this.refreshState();
        signal.throwIfAborted();
        const stillAuthorized = this.state.pairings.some((entry) => entry.chatId === reminder.chatId)
          && this.state.reminders.some((entry) => isSameReminder(entry, reminder));
        if (!stillAuthorized) continue;
        if (reminder.pairingEpoch) {
          const s = this.v2.settings();
          if (!s.enabled || s.paused || s.pairingEpoch !== reminder.pairingEpoch || s.controlChatId !== reminder.chatId) continue;
          await this.mutateState(state => { const r = state.reminders.find(item => isSameReminder(item, reminder));
            if (!r || r.deliveryState) throw Error('Напоминание изменилось.'); r.deliveryState = 'attempting'; }, signal);
          try {
            await this.callApi('sendMessage', { chat_id: reminder.chatId, ...(reminder.threadId ? { message_thread_id: reminder.threadId } : {}), text: `⏰ ${reminder.text}` }, signal);
          } catch (error) {
            await this.mutateState(state => { const r = state.reminders.find(item => isSameReminder(item, reminder)); if (r) r.deliveryState = 'uncertain'; });
            throw error;
          }
        } else await this.sendText(reminder.chatId, `⏰ ${reminder.text}`, signal);
        await this.mutateState((state) => {
          state.reminders = state.reminders.filter((item) => !isSameReminder(item, reminder));
        });
        await this.context?.emit('telegram.reminder.sent', this.manifest.id, { id: reminder.id, chatId: reminder.chatId });
      } catch (error) {
        if (signal.aborted) throw error;
        hadFailure = true;
        this.reminderFailureStreak = Math.min(this.reminderFailureStreak + 1, 16);
        const exponentialDelay = Math.min(
          TELEGRAM_REMINDER_RETRY_MAX_MS,
          TELEGRAM_REMINDER_RETRY_BASE_MS * (2 ** (this.reminderFailureStreak - 1)),
        );
        const retryDelay = telegramRetryDelay(error, exponentialDelay);
        this.reminderRetryNotBefore = Math.max(this.reminderRetryNotBefore, Date.now() + retryDelay);
        this.lastError = safeError(error);
      }
    }
    if (!hadFailure) {
      this.reminderFailureStreak = 0;
      this.reminderRetryNotBefore = 0;
    }
  }

  private async handleArtifactEgressCallback(callback: TelegramCallbackQuery, offerId: string): Promise<void> {
    const chatId = callback.message?.chat.id;
    const messageId = callback.message?.message_id;
    if (!chatId || !messageId || !/^telegram_artifact_offer_[a-f0-9]{24}$/u.test(offerId)) {
      await this.callApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Некорректная карточка файла.',
      }).catch(() => undefined);
      return;
    }
    await this.refreshState();
    const offer = this.state.artifactEgressOffers.find((entry) => entry.id === offerId);
    const pairing = this.state.pairings.find((entry) => entry.chatId === chatId && entry.userId === callback.from.id);
    if (!offer || !pairing || offer.chatId !== chatId || offer.userId !== callback.from.id
      || offer.messageId !== messageId || offer.pairingEpoch !== pairing.pairedAt) {
      await this.callApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Карточка файла устарела или принадлежит другой привязке.',
      }).catch(() => undefined);
      return;
    }
    if (offer.status === 'delivered') {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Этот файл уже отправлен.' })
        .catch(() => undefined);
      return;
    }
    if (offer.status === 'attempting' || offer.status === 'uncertain') {
      await this.callApi('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Предыдущая попытка имеет неопределённый результат; автоматический повтор запрещён, чтобы не создать дубль.',
      }).catch(() => undefined);
      return;
    }
    if (Date.parse(offer.expiresAt) <= Date.now()) {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Срок карточки файла истёк.' })
        .catch(() => undefined);
      return;
    }
    if (!this.dispatcher?.prepareArtifact) {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Artifact egress runtime недоступен.' })
        .catch(() => undefined);
      return;
    }
    if (this.artifactEgressRuns.has(offer.id)) {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Файл уже отправляется.' })
        .catch(() => undefined);
      return;
    }
    this.artifactEgressRuns.add(offer.id);
    const ownerSignal = this.pollingAbort?.signal;
    const egressAbort = new AbortController();
    const egressSignal = ownerSignal ? AbortSignal.any([ownerSignal, egressAbort.signal]) : egressAbort.signal;
    this.artifactEgressAborts.add(egressAbort);
    let payload: TelegramArtifactEgressPayload;
    try {
      await this.callApi('answerCallbackQuery', { callback_query_id: callback.id, text: 'Проверяю и отправляю файл один раз…' }, egressSignal);
      payload = await this.dispatcher.prepareArtifact({
        turnId: offer.turnId,
        taskId: offer.taskId,
        artifactId: offer.artifactId,
        name: offer.name,
        checksum: offer.checksum,
      }, this.telegramContext(chatId, callback.from.id, messageId), egressSignal);
      const bytes = decodeTelegramArtifactPayload(payload, offer);
      await this.mutateState((state) => {
        const entry = state.artifactEgressOffers.find((candidate) => candidate.id === offer.id);
        if (!entry || entry.status !== 'offered' || entry.checksum !== payload.checksum
          || entry.pairingEpoch !== offer.pairingEpoch) {
          throw new Error('Telegram artifact offer changed before dispatch.');
        }
        entry.status = 'attempting';
        entry.permitDigest = payload.permitDigest;
        entry.sizeBytes = payload.sizeBytes;
        entry.mimeType = payload.mimeType;
        entry.expiresAt = payload.expiresAt;
      }, egressSignal);
      const sent = await this.sendTelegramDocument(chatId, payload.name, payload.mimeType, bytes, egressSignal);
      await this.mutateState((state) => {
        const entry = state.artifactEgressOffers.find((candidate) => candidate.id === offer.id);
        if (!entry || entry.status !== 'attempting' || entry.permitDigest !== payload.permitDigest) {
          throw new Error('Telegram artifact outbox lost its exact permit binding.');
        }
        entry.status = 'delivered';
        entry.telegramMessageId = sent.message_id;
      });
      await this.editTaskMessage({
        chat_id: chatId,
        message_id: messageId,
        text: `${String(callback.message?.text || 'Готово.')}\n\nФайл отправлен: ${payload.name}`.slice(0, MAX_MESSAGE_CHARS),
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
    } catch (error) {
      await this.mutateState((state) => {
        const entry = state.artifactEgressOffers.find((candidate) => candidate.id === offer.id);
        if (entry?.status === 'attempting') entry.status = 'uncertain';
      }).catch(() => undefined);
      const current = this.state.artifactEgressOffers.find((entry) => entry.id === offer.id);
      const uncertain = current?.status === 'uncertain';
      const failure = error instanceof TelegramIntentRejectedError
        ? error.userMessage
        : await this.projectRemoteFailure('delivery', error);
      await this.editTaskMessage({
        chat_id: chatId,
        message_id: messageId,
        text: uncertain
          ? `${String(callback.message?.text || 'Готово.')}\n\nСтатус отправки файла неизвестен; автоматического повтора не будет.`.slice(0, MAX_MESSAGE_CHARS)
          : `${String(callback.message?.text || 'Готово.')}\n\nФайл не отправлен: ${failure}`.slice(0, MAX_MESSAGE_CHARS),
        reply_markup: { inline_keyboard: [] },
      }).catch(() => undefined);
    } finally {
      this.artifactEgressAborts.delete(egressAbort);
      this.artifactEgressRuns.delete(offer.id);
    }
  }

  private async startReminderScheduler(): Promise<void> {
    this.reminderDeliveryPaused = false;
    this.reminderWatcher?.close();
    this.reminderWatcher = null;
    this.reminderRefreshMs = REMINDER_WATCH_FALLBACK_MS;
    try {
      const stateDirectory = path.dirname(this.statePath);
      await mkdir(stateDirectory, { recursive: true });
      this.reminderWatcher = watch(stateDirectory, { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== path.basename(this.statePath)) return;
        this.scheduleReminderDelivery(REMINDER_WATCH_DEBOUNCE_MS);
      });
      this.reminderWatcher.on('error', () => {
        this.reminderWatcher?.close();
        this.reminderWatcher = null;
        this.reminderRefreshMs = REMINDER_POLL_FALLBACK_MS;
        this.scheduleReminderDelivery();
      });
    } catch {
      this.reminderRefreshMs = REMINDER_POLL_FALLBACK_MS;
    }
    this.scheduleReminderDelivery(0);
  }

  private scheduleReminderDelivery(overrideDelayMs?: number): void {
    if (!this.running || this.reminderDeliveryPaused) return;
    if (this.reminderDeliveryActive) {
      return;
    }
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    const now = Date.now();
    const nextDueAt = this.state.reminders.reduce((earliest, reminder) => {
      if (reminder.deliveryState || reminder.pairingEpoch && (!this.v2.settings().enabled || this.v2.settings().paused
        || reminder.pairingEpoch !== this.v2.settings().pairingEpoch)) return earliest;
      const dueAt = Date.parse(reminder.dueAt);
      return Number.isFinite(dueAt) && dueAt < earliest ? dueAt : earliest;
    }, Number.POSITIVE_INFINITY);
    const requestedDelay = overrideDelayMs ?? Math.min(
      this.reminderRefreshMs,
      Number.isFinite(nextDueAt) ? Math.max(0, nextDueAt - now) : this.reminderRefreshMs,
    );
    const delay = Math.max(requestedDelay, Math.max(0, this.reminderRetryNotBefore - now));
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = null;
      if (!this.running || this.reminderDeliveryPaused) return;
      const ownerSignal = this.pollingAbort?.signal;
      if (!ownerSignal || ownerSignal.aborted) return;
      const deliveryAbort = new AbortController();
      const deliverySignal = AbortSignal.any([ownerSignal, deliveryAbort.signal]);
      this.reminderDeliveryAbort = deliveryAbort;
      this.reminderDeliveryActive = true;
      const deliveryTask = this.deliverDueReminders(deliverySignal)
        .catch((error) => {
          if (!deliverySignal.aborted) this.lastError = safeError(error);
        })
        .finally(() => {
          if (this.reminderDeliveryAbort === deliveryAbort) {
            this.reminderDeliveryAbort = null;
          }
          this.reminderDeliveryActive = false;
          if (this.reminderDeliveryTask === deliveryTask) {
            this.reminderDeliveryTask = null;
          }
          this.scheduleReminderDelivery();
        });
      this.reminderDeliveryTask = deliveryTask;
    }, delay);
  }

  private async withReminderDeliveryPaused<T>(reason: Error, operation: () => Promise<T>): Promise<T> {
    const ownsPause = !this.reminderDeliveryPaused;
    if (ownsPause) {
      this.reminderDeliveryPaused = true;
      if (this.reminderTimer) clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
      this.reminderDeliveryAbort?.abort(reason);
      await this.reminderDeliveryTask?.catch(() => undefined);
      this.reminderDeliveryTask = null;
      this.reminderDeliveryAbort = null;
    }
    try {
      return await operation();
    } finally {
      if (ownsPause) {
        this.reminderDeliveryPaused = false;
        this.scheduleReminderDelivery();
      }
    }
  }

  private async dispatchPollFromCommand(chatId: number, userId: number, args: string, messageId?: number): Promise<void> {
    const parsed = parsePollCommand(args);
    if (!parsed.ok) {
      await this.sendText(chatId, parsed.message);
      return;
    }
    await this.dispatchTask(
      chatId,
      userId,
      serializeTelegramAgentCommand('telegram.poll.send', {
        chatId,
        question: parsed.question,
        options: parsed.options.map((option) => option.text),
        multiple: false,
      }, chatId),
      messageId,
    );
  }

  private async dispatchTableFromCommand(chatId: number, userId: number, args: string, messageId?: number): Promise<void> {
    const parsed = parseTableCommand(args);
    if (!parsed.ok) {
      await this.sendText(chatId, parsed.message);
      return;
    }
    await this.dispatchTask(
      chatId,
      userId,
      serializeTelegramAgentCommand('telegram.api.call', {
        method: 'sendRichMessage',
        parameters: { chat_id: chatId, rich_message: { markdown: parsed.markdown } },
      }, chatId),
      messageId,
    );
  }

  private async callApiFromCommand(chatId: number, userId: number, args: string, messageId?: number): Promise<void> {
    const match = args.match(/^(\w+)(?:\s+([\s\S]+))?$/);
    if (!match) {
      await this.sendText(chatId, 'Формат: /api METHOD {"parameter":"value"}');
      return;
    }
    const method = match[1]!;
    let parameters: Record<string, unknown>;
    try {
      assertTelegramBotApiMethodAllowed(method);
      if (!telegramApiMethodSupportsPairedChatScope(method)) {
        throw new Error('метод не имеет проверяемой привязки к текущему paired chat.');
      }
      parameters = parseTelegramApiCommandParameters(match[2]);
    } catch (error) {
      await this.sendText(chatId, telegramApiInputHelp(safeError(error)));
      return;
    }
    const targetViolation = findTelegramApiChatReferenceViolation(parameters, (targetChatId) => targetChatId === chatId);
    if (targetViolation?.key === 'chat_id') {
      await this.sendText(chatId, telegramApiInputHelp(
        'Из Telegram-чата можно вызывать Bot API только для текущего chat_id.',
      ));
      return;
    }
    if (targetViolation?.key === 'from_chat_id') {
      await this.sendText(chatId, telegramApiInputHelp(
        'Из Telegram-чата нельзя читать или копировать данные другого chat_id.',
      ));
      return;
    }
    if (telegramApiMethodDefaultsToChatId(method) && !('chat_id' in parameters)) {
      parameters.chat_id = chatId;
    }
    await this.dispatchTask(
      chatId,
      userId,
      serializeTelegramAgentCommand('telegram.api.call', { method, parameters }, chatId),
      messageId,
    );
  }

  private async prepareImageAttachment(
    message: TelegramMessage,
    signal?: AbortSignal,
  ): Promise<TelegramIntentAttachment> {
    signal?.throwIfAborted();
    const candidates = (message.photo || []).filter(isValidTelegramPhotoSize);
    const selected = candidates
      .filter((entry) => entry.file_size === undefined || entry.file_size <= TELEGRAM_ATTACHMENT_MAX_BYTES)
      .sort((left, right) => telegramPhotoArea(left) - telegramPhotoArea(right))
      .at(-1);
    if (selected) {
      const data = await this.downloadTelegramAttachment(selected.file_id, signal);
      return {
        idempotencyKey: telegramAttachmentIdempotencyKey(message, selected.file_unique_id),
        name: `telegram-photo-${message.message_id}.jpg`,
        mimeType: 'image/jpeg',
        dataBase64: data.toString('base64'),
      };
    }
    const document = message.document;
    if (!isValidTelegramImageDocument(document)
      || document.file_size !== undefined && document.file_size > TELEGRAM_ATTACHMENT_MAX_BYTES) {
      throw new Error(`Telegram image exceeds the ${TELEGRAM_ATTACHMENT_MAX_BYTES / 1024 / 1024} MiB limit or has invalid metadata.`);
    }
    const mimeType = document.mime_type as TelegramImageMimeType;
    const data = await this.downloadTelegramAttachment(document.file_id, signal);
    return {
      idempotencyKey: telegramAttachmentIdempotencyKey(message, document.file_unique_id),
      name: `telegram-image-${message.message_id}.${telegramImageExtension(mimeType)}`,
      mimeType,
      dataBase64: data.toString('base64'),
    };
  }

  private async prepareTextDocumentAttachment(
    message: TelegramMessage,
    signal?: AbortSignal,
  ): Promise<TelegramIntentAttachment> {
    signal?.throwIfAborted();
    const document = message.document;
    if (!isValidTelegramTextDocument(document)) {
      throw new Error(`Telegram text document exceeds ${TELEGRAM_TEXT_ATTACHMENT_MAX_BYTES / 1024} KiB or has invalid MIME/name metadata.`);
    }
    const mimeType = document.mime_type as TelegramTextMimeType;
    const data = await this.downloadTelegramAttachment(document.file_id, signal, TELEGRAM_TEXT_ATTACHMENT_MAX_BYTES);
    assertTelegramTextDocumentBytes(data, mimeType);
    return {
      idempotencyKey: telegramAttachmentIdempotencyKey(message, document.file_unique_id),
      name: `telegram-document-${message.message_id}.${telegramTextExtension(mimeType)}`,
      mimeType,
      dataBase64: data.toString('base64'),
    };
  }

  private async prepareVoiceNote(
    message: TelegramMessage,
    signal?: AbortSignal,
  ): Promise<TelegramIntentVoiceNote> {
    signal?.throwIfAborted();
    const voice = message.voice;
    if (!isValidTelegramVoice(voice)
      || voice.file_size !== undefined && voice.file_size > TELEGRAM_ATTACHMENT_MAX_BYTES) {
      throw new Error(`Telegram voice note exceeds ${TELEGRAM_VOICE_MAX_DURATION_SECONDS} seconds or ${TELEGRAM_ATTACHMENT_MAX_BYTES / 1024 / 1024} MiB, or has invalid metadata.`);
    }
    const data = await this.downloadTelegramAttachment(voice.file_id, signal);
    if (data.byteLength < 4 || data.subarray(0, 4).toString('ascii') !== 'OggS') {
      throw new Error('Telegram voice note is not a valid Ogg container.');
    }
    return {
      idempotencyKey: telegramAttachmentIdempotencyKey(message, voice.file_unique_id),
      mimeType: 'audio/ogg',
      durationMs: voice.duration * 1000,
      dataBase64: data.toString('base64'),
    };
  }

  private async downloadTelegramAttachment(
    fileId: string,
    signal?: AbortSignal,
    maximumBytes = TELEGRAM_ATTACHMENT_MAX_BYTES,
  ): Promise<Buffer> {
    if (this.secretTransport.available) {
      const result = await this.secretTransport.request<{ dataBase64: string }>({ kind: 'download', fileId, maxBytes: maximumBytes }, signal);
      const bytes = Buffer.from(result.dataBase64, 'base64');
      if (!bytes.length || bytes.length > maximumBytes) throw Error('telegram:attachment-budget');
      return bytes;
    }
    const file = await this.callApi<Record<string, unknown>>('getFile', { file_id: fileId }, signal);
    const filePath = normalizeTelegramFilePath(file.file_path);
    const reportedSize = file.file_size;
    if (reportedSize !== undefined
      && (!Number.isSafeInteger(reportedSize) || Number(reportedSize) < 1
        || Number(reportedSize) > maximumBytes)) {
      throw new Error(`Telegram attachment exceeds the ${maximumBytes}-byte limit or has invalid metadata.`);
    }
    return this.downloadTelegramFile(filePath, signal, maximumBytes);
  }

  private scheduleStandbyTakeover(context: MonarchKernelContext, generation: number): void {
    if (!this.standby || this.standbyTimer || this.standbyTakeoverTask
      || this.lifecycleGeneration !== generation) return;
    this.standbyTimer = setTimeout(() => {
      this.standbyTimer = null;
      const task = this.tryStandbyTakeover(context, generation)
        .catch((error) => {
          if (this.standby && this.lifecycleGeneration === generation) this.lastError = safeError(error);
        })
        .finally(() => {
          if (this.standbyTakeoverTask === task) this.standbyTakeoverTask = null;
          this.scheduleStandbyTakeover(context, generation);
        });
      this.standbyTakeoverTask = task;
    }, TELEGRAM_STANDBY_RETRY_MS);
    this.standbyTimer.unref?.();
  }

  private async tryStandbyTakeover(context: MonarchKernelContext, generation: number): Promise<void> {
    if (!this.standby || this.lifecycleGeneration !== generation) return;
    const ownsPolling = await this.acquirePollingLock();
    if (!ownsPolling) return;
    if (!this.standby || this.lifecycleGeneration !== generation) {
      await this.releasePollingLock();
      return;
    }
    await this.refreshState();
    if (this.lastStateReadError) {
      await this.releasePollingLock();
      return;
    }
    try {
      const cloudConfiguration = await this.cloud.configuration();
      if (this.v2.settings().enabled) {
        const webhook = await this.callApi<{ url: string }>('getWebhookInfo', {});
        if (webhook.url !== (cloudConfiguration.enabled ? `${cloudConfiguration.endpoint}/telegram` : '')) {
          throw Error('Получатель Telegram не совпадает с выбранным режимом. Заверши переключение webhook по инструкции.');
        }
      }
      this.cloudMode = cloudConfiguration.enabled;
    } catch (error) {
      await this.releasePollingLock();
      throw error;
    }
    await this.callApi('setMyCommands', { commands: telegramBotCommands() }).catch(async (error) => {
      await context.audit('telegram', 'Telegram command menu registration failed during standby takeover.', {
        error: safeError(error),
      }, 'warn');
    });
    if (!this.standby || this.lifecycleGeneration !== generation) {
      await this.releasePollingLock();
      return;
    }
    this.running = true;
    this.standby = false;
    this.lastError = '';
    this.taskDeliveryGeneration += 1;
    this.pollingAbort = new AbortController();
    this.pollingTask = this.cloudMode ? this.cloud.run(this.pollingAbort.signal) : this.pollLoop(this.pollingAbort.signal);
    try {
      this.resumePendingTaskDeliveries();
      await this.startReminderScheduler();
      await context.emit('telegram.polling.owner.acquired', this.manifest.id, this.statusPayload(false));
    } catch (error) {
      this.running = false;
      this.standby = this.lifecycleGeneration === generation;
      this.taskDeliveryGeneration += 1;
      this.reminderDeliveryPaused = true;
      this.reminderDeliveryAbort?.abort(error);
      this.pollingAbort.abort(error);
      this.pollingAbort = null;
      if (this.reminderTimer) clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
      this.reminderWatcher?.close();
      this.reminderWatcher = null;
      await this.reminderDeliveryTask?.catch(() => undefined);
      this.reminderDeliveryTask = null;
      this.reminderDeliveryAbort = null;
      await this.pollingTask?.catch(() => undefined);
      this.pollingTask = null;
      await this.settleTaskDeliveryRuns();
      await this.releasePollingLock();
      throw error;
    }
  }

  private async downloadTelegramFile(
    filePath: string,
    signal?: AbortSignal,
    maximumBytes = TELEGRAM_ATTACHMENT_MAX_BYTES,
  ): Promise<Buffer> {
    if (!this.token) throw new Error('Telegram bot token is not configured.');
    const normalizedPath = normalizeTelegramFilePath(filePath);
    const requestController = new AbortController();
    const timeout = setTimeout(
      () => requestController.abort(new Error('Telegram file download timed out.')),
      TELEGRAM_API_CALL_TIMEOUT_MS,
    );
    timeout.unref?.();
    const forwardAbort = (): void => requestController.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const base = new URL(this.apiBase);
      base.pathname = `${base.pathname.replace(/\/$/u, '')}/file/bot${this.token}/${normalizedPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`;
      const response = await fetch(base, {
        method: 'GET',
        redirect: 'error',
        signal: requestController.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Telegram file download failed (${response.status}).`);
      }
      return await readBoundedTelegramFileResponse(response, maximumBytes);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async sendCapability(input: unknown, signal?: AbortSignal): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const text = readString(input, 'text');
    const chatId = this.resolvePairedChat(readNumber(input, 'chatId'));
    if (!text || chatId === null) return { ok: false, summary: 'A paired chat and message text are required.', error: 'telegram-send-input-invalid' };
    if (text.length > MAX_OUTBOUND_MESSAGE_CHARS) {
      return {
        ok: false,
        summary: `Telegram message is too long; maximum ${MAX_OUTBOUND_MESSAGE_CHARS} characters.`,
        error: 'telegram-send-input-invalid',
      };
    }
    const parts = splitMessage(text);
    const messageIds: number[] = [];
    for (const part of parts) {
      signal?.throwIfAborted();
      const result = await this.callApi('sendMessage', {
        chat_id: chatId,
        text: part,
        link_preview_options: { is_disabled: true },
      }, signal);
      const messageId = readNumber(result, 'message_id');
      if (messageId !== undefined) messageIds.push(messageId);
    }
    return {
      ok: true,
      summary: 'Telegram message accepted by the Bot API.',
      output: {
        chatId,
        chars: text.length,
        parts: parts.length,
        messageIds,
        textSha256: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      },
    };
  }

  private async pollCapability(input: unknown, signal?: AbortSignal): Promise<MonarchExecutionResult> {
    const chatId = this.resolvePairedChat(readNumber(input, 'chatId'));
    const question = readString(input, 'question');
    const options = readStringArray(input, 'options');
    const parsed = parsePollPayload(question, options);
    if (chatId === null) {
      return { ok: false, summary: 'A paired chat is required.', error: 'telegram-poll-input-invalid' };
    }
    if (!parsed.ok) {
      return { ok: false, summary: parsed.summary, error: 'telegram-poll-input-invalid' };
    }
    const result = await this.callApi('sendPoll', {
      chat_id: chatId,
      question: parsed.question,
      options: parsed.options,
      allows_multiple_answers: readBoolean(input, 'multiple'),
    }, signal);
    return {
      ok: true,
      summary: 'Telegram poll sent.',
      output: {
        chatId,
        question: parsed.question,
        optionCount: parsed.options.length,
        telegram: sanitizeTelegramResult(result),
      },
    };
  }

  private async createReminderCapability(input: unknown, signal?: AbortSignal): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    if (this.isZeroRetentionEnabled()) {
      return {
        ok: false,
        summary: 'Telegram reminder persistence is disabled by Owner DEV zero-retention policy.',
        error: 'telegram-reminder-disabled-by-zero-retention',
      };
    }
    const chatId = this.resolvePairedChat(readNumber(input, 'chatId'));
    const text = readString(input, 'text');
    const dueAt = readString(input, 'dueAt');
    const reminderInput = parseReminderPayload(text, dueAt);
    if (chatId === null) {
      return { ok: false, summary: 'A paired chat is required.', error: 'telegram-reminder-input-invalid' };
    }
    if (!reminderInput.ok) {
      return { ok: false, summary: reminderInput.summary, error: 'telegram-reminder-input-invalid' };
    }
    const reminder = await this.createReminder(chatId, reminderInput.text, reminderInput.dueAt, signal);
    return { ok: true, summary: `Telegram reminder ${reminder.id} created.`, output: reminder };
  }

  private listRemindersCapability(input: unknown): MonarchExecutionResult {
    const requested = readNumber(input, 'chatId');
    const reminders = this.state.reminders.filter((item) => requested === undefined || item.chatId === requested);
    return { ok: true, summary: `Listed ${reminders.length} Telegram reminders.`, output: { reminders } };
  }

  private async cancelReminderCapability(input: unknown, signal?: AbortSignal): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const id = readString(input, 'id');
    const chatId = readNumber(input, 'chatId');
    const result = await this.cancelReminder(id, chatId, signal);
    if (result.status === 'invalid') {
      return { ok: false, summary: 'A reminder id is required.', error: 'telegram-reminder-input-invalid' };
    }
    if (result.status === 'ambiguous') {
      return {
        ok: false,
        summary: `Telegram reminder ${id} matches multiple pending reminders; provide chatId to cancel exactly one.`,
        error: 'telegram-reminder-ambiguous',
      };
    }
    return {
      ok: result.status === 'cancelled',
      summary: result.status === 'cancelled'
        ? `Telegram reminder ${id} cancelled.`
        : `Telegram reminder ${id} not found.`,
      ...(result.status === 'cancelled' ? { output: { id, chatId: result.chatId } } : { error: 'telegram-reminder-not-found' }),
    };
  }

  private async cancelReminder(id: string, chatId?: number, signal?: AbortSignal): Promise<{ status: 'invalid' | 'not-found' | 'ambiguous' | 'cancelled'; chatId?: number }> {
    signal?.throwIfAborted();
    if (!id) return { status: 'invalid' };
    const result = await this.withReminderDeliveryPaused(
      new Error('Telegram reminder was cancelled during delivery.'),
      async () => this.mutateState<{ status: 'not-found' | 'ambiguous' | 'cancelled'; chatId?: number }>((state) => {
        const matches = state.reminders.filter((item) => item.id === id && (chatId === undefined || item.chatId === chatId));
        if (!matches.length) return { status: 'not-found' };
        if (matches.length > 1) return { status: 'ambiguous' };
        const target = matches[0]!;
        state.reminders = state.reminders.filter((item) => !isSameReminder(item, target));
        return { status: 'cancelled', chatId: target.chatId };
      }, signal),
    );
    return result;
  }

  private async genericApiCapability(input: unknown, signal?: AbortSignal): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const apiInput = readTelegramApiCapabilityInput(input);
    if (!apiInput.ok) return { ok: false, summary: apiInput.summary, error: apiInput.error };
    const { method } = apiInput;
    if (!telegramApiMethodSupportsPairedChatScope(method)) {
      return {
        ok: false,
        summary: `Telegram Bot API method ${method} is not bound to a paired chat and is unavailable through the compatibility capability.`,
        error: 'telegram-api-method-unscoped',
      };
    }
    const parameters = { ...apiInput.parameters };
    const targetViolation = findTelegramApiChatReferenceViolation(parameters, (chatId) => this.state.pairings.some((entry) => entry.chatId === chatId));
    if (targetViolation) {
      return {
        ok: false,
        summary: `Telegram Bot API ${targetViolation.path} must reference a paired chat.`,
        error: 'telegram-api-unpaired-chat',
      };
    }
    if (!('chat_id' in parameters) && telegramApiMethodDefaultsToChatId(method)) {
      const chatId = this.resolvePairedChat();
      if (chatId === null) {
        return {
          ok: false,
          summary: 'Telegram Bot API chat_id must reference one paired chat.',
          error: 'telegram-api-chat-required',
        };
      }
      parameters.chat_id = chatId;
    }
    const result = await this.callApi(method, parameters, signal);
    const boundChatId = readNumber(parameters, 'chat_id');
    return {
      ok: true,
      summary: `Telegram Bot API method ${method} completed.`,
      output: {
        method,
        ...(boundChatId !== undefined ? { chatId: boundChatId } : {}),
        telegram: sanitizeTelegramResult(result),
      },
    };
  }

  private describeCapabilitiesCapability(input: unknown): MonarchExecutionResult {
    const topic = readString(input, 'topic');
    const pending = this.state.pendingTaskDeliveries.length;
    const status = this.statusPayload(false);
    const reply = topic === 'plugins'
      ? telegramPluginHelp(this.context)
      : topic === 'security'
        ? telegramSecurityHelp(status, pending)
        : telegramCapabilityHelp(status, pending, this.context);
    return {
      ok: true,
      summary: 'Telegram bot capabilities described.',
      output: {
        topic: topic || 'capabilities',
        reply,
        status,
      },
    };
  }

  private async projectRemoteFailure(
    kind: TelegramRemoteFailureKind,
    error: unknown,
    preferredMessage?: string,
  ): Promise<string> {
    const projection = telegramRemoteFailure(kind, error, preferredMessage);
    await this.context?.audit('telegram', 'Telegram remote failure projected without local details.', {
      kind,
      diagnosticId: projection.diagnosticId,
      error: projection.diagnostic,
    }, kind === 'attachment' ? 'warn' : 'error').catch(() => undefined);
    return projection.message;
  }

  private async sendText(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
    for (const part of splitMessage(text || 'Готово.')) {
      await this.callApi('sendMessage', {
        chat_id: chatId,
        text: part,
        link_preview_options: { is_disabled: true },
      }, signal);
    }
  }

  private async sealArtifactEgressOffers(
    pending: TelegramPendingTaskDelivery,
    descriptors: TelegramArtifactOfferDescriptor[],
  ): Promise<Record<string, unknown>> {
    const pairing = this.state.pairings.find((entry) => entry.chatId === pending.chatId && entry.userId === pending.userId);
    if (!pairing) throw new Error('Telegram artifact offer lost its pairing binding.');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TELEGRAM_ARTIFACT_OFFER_TTL_MS).toISOString();
    const unique = new Map(descriptors.map((descriptor) => [descriptor.artifactId, descriptor]));
    const offers = [...unique.values()].slice(0, 3).map((descriptor): TelegramArtifactEgressOffer => {
      if (descriptor.turnId !== pending.turnId
        || !/^agent_task_[A-Za-z0-9_-]{8,128}$/u.test(descriptor.taskId)
        || !/^agent_artifact_[A-Za-z0-9_-]{8,128}$/u.test(descriptor.artifactId)
        || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.checksum)) {
        throw new Error('Telegram artifact descriptor does not match its durable Turn.');
      }
      const name = normalizeTelegramArtifactOfferName(descriptor.name);
      const id = `telegram_artifact_offer_${createHash('sha256').update([
        pending.turnId, descriptor.taskId, descriptor.artifactId,
        String(pending.chatId), String(pending.userId), pairing.pairedAt,
      ].join('\0')).digest('hex').slice(0, 24)}`;
      return {
        id,
        turnId: pending.turnId,
        taskId: descriptor.taskId,
        artifactId: descriptor.artifactId,
        chatId: pending.chatId,
        userId: pending.userId,
        pairingEpoch: pairing.pairedAt,
        messageId: pending.progressMessageId,
        name,
        checksum: descriptor.checksum,
        status: 'offered',
        createdAt,
        expiresAt,
      };
    });
    const activeOfferIds = await this.mutateState((state) => {
      state.artifactEgressOffers = state.artifactEgressOffers.filter((entry) => (
        Date.parse(entry.expiresAt) > Date.now() || entry.status === 'attempting'
      ));
      for (const offer of offers) {
        const existing = state.artifactEgressOffers.find((entry) => entry.id === offer.id);
        if (existing) {
          const same = existing.turnId === offer.turnId && existing.taskId === offer.taskId
            && existing.artifactId === offer.artifactId && existing.chatId === offer.chatId
            && existing.userId === offer.userId && existing.pairingEpoch === offer.pairingEpoch
            && existing.messageId === offer.messageId && existing.name === offer.name
            && existing.checksum === offer.checksum;
          if (!same) throw new Error('Telegram artifact offer id was rebound to different authority.');
          continue;
        }
        if (state.artifactEgressOffers.length >= MAX_ARTIFACT_EGRESS_OFFERS) {
          const evict = state.artifactEgressOffers.findIndex((entry) => entry.status === 'delivered');
          const fallback = evict >= 0
            ? evict
            : state.artifactEgressOffers.findIndex((entry) => entry.status === 'offered');
          if (fallback < 0) throw new Error('Telegram artifact egress queue is full of unresolved attempts.');
          state.artifactEgressOffers.splice(fallback, 1);
        }
        state.artifactEgressOffers.push(offer);
      }
      return offers
        .filter((offer) => state.artifactEgressOffers.find((entry) => entry.id === offer.id)?.status === 'offered')
        .map((offer) => offer.id);
    });
    return {
      inline_keyboard: offers.filter((offer) => activeOfferIds.includes(offer.id)).map((offer) => [{
        text: `Отправить ${offer.name}`.slice(0, 64),
        callback_data: `artifact:${offer.id}`,
      }]),
    };
  }

  private async completeTaskMessage(
    chatId: number,
    messageId: number,
    text: string,
    pending?: TelegramPendingTaskDelivery,
    signal?: AbortSignal,
    replyMarkup?: Record<string, unknown>,
  ): Promise<void> {
    const parts = splitMessage(text || 'Готово.');
    if (parts.length === 1) {
      try {
        await this.editTaskMessage({
          chat_id: chatId,
          message_id: messageId,
          text: parts[0],
          link_preview_options: { is_disabled: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }, signal);
      } catch (error) {
        // A durable result keeps its binding and retries the same edit. Falling
        // back to sendMessage after an uncertain transport failure can duplicate
        // a result that Telegram already committed before the response was lost.
        if (pending) throw error;
        await this.sendText(chatId, parts[0]!, signal);
      }
      return;
    }
    await this.editTaskMessage({
      chat_id: chatId,
      message_id: messageId,
      text: 'Готово. Ответ ниже.',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, signal).catch(() => undefined);
    if (pending) {
      if (pending.chatId !== chatId || pending.progressMessageId !== messageId) {
        throw new Error('Telegram multipart delivery does not match its progress message binding.');
      }
      await this.deliverPendingTailParts(pending, parts, signal);
    } else await this.sendText(chatId, text, signal);
  }

  /** A Bot API send has no idempotency key, so the post-send/pre-fsync window
   * cannot be eliminated. Persisting a content-free cursor bounds replay to at
   * most the uncertain part instead of retransmitting every long-result tail. */
  private async deliverPendingTailParts(
    pending: TelegramPendingTaskDelivery,
    parts: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
    const authoritative = await this.mutateState((state) => {
      const entry = state.pendingTaskDeliveries.find((item) => item.clientRequestId === pending.clientRequestId);
      if (!entry || entry.turnId !== pending.turnId || entry.chatId !== pending.chatId) {
        throw new Error('Telegram multipart delivery lost its durable Turn binding.');
      }
      if (entry.deliveryDigest && entry.deliveryDigest !== digest) {
        throw new Error('Telegram multipart delivery result changed after its durable plan was sealed.');
      }
      const delivered = entry.deliveredPartCount ?? 0;
      if (!Number.isSafeInteger(delivered) || delivered < 0 || delivered > parts.length) {
        throw new Error('Telegram multipart delivery cursor is invalid.');
      }
      entry.deliveryDigest = digest;
      entry.deliveredPartCount = delivered;
      return { digest, delivered };
    });
    pending.deliveryDigest = authoritative.digest;
    pending.deliveredPartCount = authoritative.delivered;
    for (let index = authoritative.delivered; index < parts.length; index += 1) {
      await this.callApi('sendMessage', {
        chat_id: pending.chatId,
        text: parts[index],
        link_preview_options: { is_disabled: true },
      }, signal);
      const delivered = index + 1;
      await this.mutateState((state) => {
        const entry = state.pendingTaskDeliveries.find((item) => item.clientRequestId === pending.clientRequestId);
        if (!entry || entry.turnId !== pending.turnId || entry.deliveryDigest !== digest
          || entry.deliveredPartCount !== index) {
          throw new Error('Telegram multipart delivery cursor changed concurrently.');
        }
        entry.deliveredPartCount = delivered;
      });
      pending.deliveredPartCount = delivered;
    }
  }

  private async editTaskMessage(parameters: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    try {
      await this.callApi('editMessageText', parameters, signal);
    } catch (error) {
      // A crash can happen after Telegram committed the edit but before Monarch
      // removed its durable delivery binding. Replaying the exact same edit is a
      // successful delivery, not a reason to send a duplicate message forever.
      if (/message is not modified/i.test(safeError(error))) return;
      throw error;
    }
  }

  private async settleTaskDeliveryRuns(): Promise<void> {
    const runs = [...this.taskDeliveryRuns.values()];
    if (runs.length > 0) await Promise.allSettled(runs);
  }

  private async sendTelegramDocument(
    chatId: number,
    name: string,
    mimeType: string,
    bytes: Buffer,
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    if (this.secretTransport.available) return this.secretTransport.request({ kind: 'document', chatId,
      threadId: this.topicContext.getStore()?.threadId ?? 0, name, mimeType, dataBase64: bytes.toString('base64') }, signal);
    if (!this.token) throw new Error('Telegram bot token is not configured.');
    const lifecycleSignal = signal ?? this.pollingAbort?.signal;
    const requestController = new AbortController();
    const timeout = setTimeout(
      () => requestController.abort(new Error('Telegram Bot API sendDocument timed out.')),
      TELEGRAM_API_CALL_TIMEOUT_MS,
    );
    timeout.unref?.();
    const forwardAbort = (): void => requestController.abort(lifecycleSignal?.reason);
    if (lifecycleSignal) {
      if (lifecycleSignal.aborted) forwardAbort();
      else lifecycleSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const body = new FormData();
      body.append('chat_id', String(chatId));
      const threadId = this.topicContext.getStore()?.threadId;
      if (threadId) body.append('message_thread_id', String(threadId));
      body.append('document', new Blob([new Uint8Array(bytes)], { type: mimeType }), name);
      const response = await fetch(`${this.apiBase}/bot${this.token}/sendDocument`, {
        method: 'POST', body, redirect: 'error', signal: requestController.signal,
      });
      const responseText = await readBoundedTelegramApiResponse(response, TELEGRAM_API_RESPONSE_MAX_BYTES);
      let payload: TelegramApiResponse<TelegramMessage>;
      try { payload = JSON.parse(responseText) as TelegramApiResponse<TelegramMessage>; } catch {
        throw new Error('Telegram Bot API sendDocument returned invalid JSON.');
      }
      if (!response.ok || !payload?.ok || !payload.result || !Number.isSafeInteger(payload.result.message_id)) {
        throw new TelegramBotApiError(
          `Telegram Bot API sendDocument failed (${payload?.error_code || response.status}): ${payload?.description || 'invalid receipt'}`,
          readTelegramRetryAfterMs(payload?.parameters?.retry_after),
        );
      }
      return payload.result;
    } finally {
      clearTimeout(timeout);
      lifecycleSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async callApi<T = unknown>(method: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const pending = this.pendingDeliveryContext.getStore();
    if (pending && !this.pendingDeliveryAllowed(pending)) throw Error('telegram-v2:delivery-revoked');
    const topic = this.topicContext.getStore();
    if (topic?.epoch && /^(send|editMessage)/u.test(method)) {
      const settings = this.v2.settings(); const binding = this.v2.binding(topic.threadId);
      if (!settings.enabled || settings.paused && !topic.cancellationOnly || settings.pairingEpoch !== topic.epoch
        || settings.ownerUserId !== topic.ownerId || settings.controlChatId !== topic.chatId
        || topic.conversationBound && (binding?.localOnly || binding?.archived)) throw Error('telegram-v2:delivery-revoked');
    }
    if (!this.token) throw new Error('Telegram bot token is not configured.');
    assertTelegramBotApiMethodName(method);
    const threadId = this.topicContext.getStore()?.threadId;
    if (threadId && parameters.chat_id === this.v2.settings().controlChatId
      && /^(sendMessage|sendMessageDraft|sendChatAction|sendPhoto|sendDocument|sendVoice|sendPoll|sendRichMessage)$/u.test(method)
      && parameters.message_thread_id === undefined) parameters = { ...parameters, message_thread_id: threadId };
    if (this.secretTransport.available) return this.secretTransport.request<T>({ kind: 'api', method, parameters }, signal ?? this.pollingAbort?.signal);
    const lifecycleSignal = signal ?? this.pollingAbort?.signal;
    // Undici keeps an abort listener on a reused signal after a successful
    // fetch. Long polling can therefore leak listeners indefinitely. Give each
    // request its own signal and detach the forwarding listener in all cases.
    const requestController = new AbortController();
    const timeoutMs = method === 'getUpdates' ? TELEGRAM_LONG_POLL_TIMEOUT_MS : TELEGRAM_API_CALL_TIMEOUT_MS;
    const timeout = setTimeout(() => requestController.abort(new Error(`Telegram Bot API ${method} timed out.`)), timeoutMs);
    timeout.unref?.();
    const forwardAbort = (): void => requestController.abort(lifecycleSignal?.reason);
    if (lifecycleSignal) {
      if (lifecycleSignal.aborted) forwardAbort();
      else lifecycleSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
        signal: requestController.signal,
      });
      const responseText = await readBoundedTelegramApiResponse(response, TELEGRAM_API_RESPONSE_MAX_BYTES);
      let payload: TelegramApiResponse<T>;
      try {
        payload = JSON.parse(responseText) as TelegramApiResponse<T>;
      } catch {
        throw new Error(`Telegram Bot API ${method} returned invalid JSON.`);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`Telegram Bot API ${method} returned an invalid response envelope.`);
      }
      if (!response.ok || !payload.ok) {
        throw new TelegramBotApiError(
          `Telegram Bot API ${method} failed (${payload.error_code || response.status}): ${payload.description || 'unknown error'}`,
          readTelegramRetryAfterMs(payload.parameters?.retry_after),
        );
      }
      return payload.result as T;
    } finally {
      clearTimeout(timeout);
      lifecycleSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  private isPaired(chatId: number, userId: number): boolean {
    return this.state.pairings.some((entry) => entry.chatId === chatId && entry.userId === userId);
  }

  private telegramContext(chatId: number, userId: number, messageId?: number, allowContinuation = false, text?: string): Record<string, unknown> {
    const pairing = this.state.pairings.find((entry) => entry.chatId === chatId && entry.userId === userId);
    const base = telegramIntentContext(chatId, userId, messageId, allowContinuation, pairing?.pairedAt,
      this.state.remotePaused, this.isZeroRetentionEnabled());
    return this.v2.settings().enabled
      ? this.v2.context(chatId, userId, this.topicContext.getStore()?.threadId ?? 0, messageId, base, text)
      : base;
  }

  private resolvePairedChat(requested?: number): number | null {
    if (requested !== undefined && this.state.pairings.some((entry) => entry.chatId === requested)) return requested;
    return this.state.pairings.length === 1 ? this.state.pairings[0]!.chatId : null;
  }

  private consumeRateLimit(userId: number): boolean {
    const now = Date.now();
    this.pruneRateLimitState(now);
    const window = (this.rateWindows.get(userId) || []).filter((time) => now - time < this.inboundRateLimit.windowMs);
    if (window.length >= this.inboundRateLimit.limit) return false;
    window.push(now);
    this.rateWindows.delete(userId);
    this.rateWindows.set(userId, window);
    trimOldestMapEntries(this.rateWindows, MAX_TRACKED_RATE_LIMIT_USERS);
    return true;
  }

  private shouldSendRateLimitNotice(userId: number): boolean {
    const now = Date.now();
    const previous = this.rateLimitNotices.get(userId) || 0;
    if (now - previous < RATE_WINDOW_MS) return false;
    this.rateLimitNotices.delete(userId);
    this.rateLimitNotices.set(userId, now);
    trimOldestMapEntries(this.rateLimitNotices, MAX_TRACKED_RATE_LIMIT_USERS);
    return true;
  }

  private shouldSendMediaGroupNotice(chatId: number, mediaGroupId: string): boolean {
    const now = Date.now();
    for (const [key, timestamp] of this.mediaGroupNotices) {
      if (now - timestamp >= MEDIA_GROUP_NOTICE_TTL_MS) this.mediaGroupNotices.delete(key);
    }
    const key = createHash('sha256')
      .update(`${chatId}:${mediaGroupId.trim().slice(0, 512)}`)
      .digest('hex');
    const previous = this.mediaGroupNotices.get(key) || 0;
    if (now - previous < MEDIA_GROUP_NOTICE_TTL_MS) return false;
    this.mediaGroupNotices.delete(key);
    this.mediaGroupNotices.set(key, now);
    trimOldestMapEntries(this.mediaGroupNotices, MAX_TRACKED_RATE_LIMIT_USERS);
    return true;
  }

  private pruneRateLimitState(now: number): void {
    if (this.rateWindows.size < MAX_TRACKED_RATE_LIMIT_USERS && this.rateLimitNotices.size < MAX_TRACKED_RATE_LIMIT_USERS) return;
    for (const [userId, timestamps] of this.rateWindows) {
      const active = timestamps.filter((timestamp) => now - timestamp < this.inboundRateLimit.windowMs);
      if (!active.length) this.rateWindows.delete(userId);
      else if (active.length !== timestamps.length) this.rateWindows.set(userId, active);
    }
    for (const [userId, timestamp] of this.rateLimitNotices) {
      if (now - timestamp >= RATE_WINDOW_MS) this.rateLimitNotices.delete(userId);
    }
  }


  private async canAttemptPairing(chatId: number, userId: number): Promise<boolean> {
    const key = pairingAttemptKey(chatId, userId);
    let allowed = true;
    await this.mutateState((state) => {
      const current = state.pairingAttempts[key];
      if (!current) return;
      const now = Date.now();
      if (current.blockedUntil > now) {
        allowed = false;
        return;
      }
      const attempts = current.attempts.filter((attempt) => now - attempt < PAIRING_ATTEMPT_WINDOW_MS);
      if (attempts.length) state.pairingAttempts[key] = { attempts, blockedUntil: 0 };
      else delete state.pairingAttempts[key];
    });
    return allowed;
  }

  private async recordPairingFailure(chatId: number, userId: number): Promise<void> {
    const key = pairingAttemptKey(chatId, userId);
    const now = Date.now();
    let blocked = false;
    await this.mutateState((state) => {
      const current = state.pairingAttempts[key] || { attempts: [], blockedUntil: 0 };
      current.attempts = current.attempts.filter((attempt) => now - attempt < PAIRING_ATTEMPT_WINDOW_MS);
      current.attempts.push(now);
      if (current.attempts.length >= PAIRING_ATTEMPT_LIMIT) {
        current.blockedUntil = now + PAIRING_COOLDOWN_MS;
        current.attempts = [];
        blocked = true;
      }
      state.pairingAttempts[key] = current;
    });
    if (blocked) {
      await this.context?.audit('telegram', 'Telegram pairing temporarily blocked after repeated failures.', {
        chatId,
        userId,
      }, 'warn');
    }
  }

  private async clearPairingFailures(chatId: number, userId: number): Promise<void> {
    await this.mutateState((state) => {
      delete state.pairingAttempts[pairingAttemptKey(chatId, userId)];
    });
  }

  private async rotatePairingCode(): Promise<void> {
    await this.syncPairingCode(true);
  }

  private async ensureFreshPairingCode(): Promise<void> {
    await this.syncPairingCode(false);
  }

  private statusPayload(includePairingCode: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      configured: Boolean(this.token),
      running: this.running || this.standby,
      pollingMode: this.running ? 'owner' : this.standby ? 'standby' : 'stopped',
      transportMode: this.cloudMode ? 'personal-cloud' : 'polling',
      pollingOwnedByThisProcess: this.running,
      apiBase: redactApiBase(this.apiBase),
      bot: this.botIdentity,
      pairedChats: this.state.pairings.map(({ chatId, userId, username, pairedAt }) => ({ chatId, userId, username, pairedAt })),
      reminders: this.state.reminders.length,
      pendingTaskDeliveries: this.state.pendingTaskDeliveries.length,
      pendingMultipartDeliveries: this.state.pendingTaskDeliveries
        .filter((entry) => Boolean(entry.deliveryDigest)).length,
      pendingArtifactEgressOffers: this.state.artifactEgressOffers
        .filter((entry) => entry.status === 'offered').length,
      uncertainArtifactEgressOffers: this.state.artifactEgressOffers
        .filter((entry) => entry.status === 'attempting' || entry.status === 'uncertain').length,
      remotePaused: this.state.remotePaused,
      pendingConfirmations: 0,
      dispatcherReady: Boolean(this.dispatcher),
      remoteMode: this.state.remotePaused ? 'lockdown' : this.running || this.standby ? 'agent' : 'stopped',
      securityMode: 'paired-chat + confirmation-gated',
      v2: { enabled: this.v2.settings().enabled, paused: this.v2.settings().paused,
        historyEnabled: this.v2.settings().historyEnabled },
      lastError: this.lastError || null,
      botApiCompatibility: '10.1+ generic method adapter',
      deliverySemantics: 'durable-turn + bounded-at-least-once-message-delivery',
      apiTransport: {
        ordinaryTimeoutMs: TELEGRAM_API_CALL_TIMEOUT_MS,
        longPollTimeoutMs: TELEGRAM_LONG_POLL_TIMEOUT_MS,
        responseMaxBytes: TELEGRAM_API_RESPONSE_MAX_BYTES,
      },
      standbyRetryMs: TELEGRAM_STANDBY_RETRY_MS,
      attachmentTransport: {
        acceptedKinds: ['telegram-photo', 'telegram-image-document', 'telegram-text-document', 'telegram-voice-note'],
        acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/markdown', 'application/json', 'audio/ogg'],
        maxAttachmentsPerUpdate: 1,
        maxBytesPerAttachment: TELEGRAM_ATTACHMENT_MAX_BYTES,
        maxTextDocumentBytes: TELEGRAM_TEXT_ATTACHMENT_MAX_BYTES,
        voiceMaxDurationSeconds: TELEGRAM_VOICE_MAX_DURATION_SECONDS,
        downloadTimeoutMs: TELEGRAM_API_CALL_TIMEOUT_MS,
        storage: this.isZeroRetentionEnabled() ? 'volatile' : 'oscar-immutable',
        voiceStorage: 'temporary-only',
        mediaGroups: 'rejected-explicitly',
      },
      artifactEgress: {
        enabled: Boolean(this.dispatcher?.listArtifacts && this.dispatcher?.prepareArtifact),
        maxOffersPerTask: 3,
        maxBytesPerArtifact: TELEGRAM_ATTACHMENT_MAX_BYTES,
        approval: 'exact-inline-button-one-shot',
        deliverySemantics: 'durable-offered-attempting-delivered-or-uncertain-no-auto-retry',
        rawPathsExposed: false,
      },
    };
    if (includePairingCode) {
      payload.pairingCode = this.state.remotePaused ? '' : this.pairingCode;
      payload.pairingExpiresAt = this.state.remotePaused ? null : new Date(this.pairingExpiresAt).toISOString();
      payload.tokenPath = this.tokenPath;
    }
    return payload;
  }

  private async loadState(): Promise<void> {
    await this.refreshState();
  }

  private async refreshState(): Promise<void> {
    this.state = await this.readStateFile();
  }

  private async readStateFile(): Promise<TelegramState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<TelegramState>;
      if (this.lastStateReadError && this.lastError.startsWith('Telegram state unavailable')) {
        this.lastError = '';
      }
      this.lastStateReadError = '';
      const pairings = Array.isArray(parsed.pairings) ? parsed.pairings.filter(validPairing) : [];
      const pairedChatIds = new Set(pairings.map((pairing) => pairing.chatId));
      const pairedActors = new Set(pairings.map((pairing) => `${pairing.chatId}:${pairing.userId}`));
      return {
        offset: Number.isSafeInteger(parsed.offset) ? Number(parsed.offset) : 0,
        pairings,
        reminders: Array.isArray(parsed.reminders)
          ? parsed.reminders
            .filter(validReminder)
            .filter((reminder) => pairedChatIds.has(reminder.chatId))
          : [],
        pendingTaskDeliveries: Array.isArray(parsed.pendingTaskDeliveries)
          ? parsed.pendingTaskDeliveries
            .filter(validPendingTaskDelivery)
            .filter((entry) => pairedActors.has(`${entry.chatId}:${entry.userId}`))
            .slice(-MAX_PENDING_TASK_DELIVERIES)
          : [],
        artifactEgressOffers: Array.isArray(parsed.artifactEgressOffers)
          ? parsed.artifactEgressOffers
            .filter(validArtifactEgressOffer)
            .filter((entry) => pairedActors.has(`${entry.chatId}:${entry.userId}`))
            .slice(-MAX_ARTIFACT_EGRESS_OFFERS)
          : [],
        remotePaused: parsed.remotePaused === true,
        pairingAttempts: readPairingAttempts(parsed.pairingAttempts),
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        this.lastStateReadError = '';
        return defaultTelegramState(false);
      }
      const message = safeError(error);
      if (message !== this.lastStateReadError) {
        this.lastStateReadError = message;
        this.lastError = `Telegram state unavailable; remote access paused: ${message}`;
        void this.context?.audit('telegram', 'Telegram state could not be read; remote access failed closed.', {
          error: message,
        }, 'warn');
      }
      return defaultTelegramState(true);
    }
  }

  private async mutateState<T>(
    mutator: (state: TelegramState) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const token = await acquireFileLock(this.stateLockPath, TRANSIENT_LOCK_TIMEOUT_MS, TRANSIENT_LOCK_STALE_MS);
    if (!token) throw new Error('Telegram state is busy in another local Monarch runtime.');
    try {
      const state = await this.readStateFile();
      if (this.lastStateReadError) {
        throw new Error('Telegram state is unavailable; refusing to overwrite its existing bytes.');
      }
      signal?.throwIfAborted();
      const result = await mutator(state);
      signal?.throwIfAborted();
      await this.writeStateFile(state);
      this.state = state;
      return result;
    } finally {
      await releaseFileLock(this.stateLockPath, token);
    }
  }

  private async advanceOffset(offset: number): Promise<void> {
    await this.mutateState((state) => {
      state.offset = Math.max(state.offset, offset);
    });
  }

  private async writeStateFile(state: TelegramState): Promise<void> {
    await writeAtomicJson(this.statePath, state);
  }

  private async syncPairingCode(force: boolean): Promise<void> {
    const token = await acquireFileLock(this.pairingLockPath, TRANSIENT_LOCK_TIMEOUT_MS, TRANSIENT_LOCK_STALE_MS);
    if (!token) throw new Error('Telegram pairing code is busy in another local Monarch runtime.');
    try {
      let snapshot = await readPairingSnapshot(this.pairingPath);
      const expiresAt = snapshot ? Date.parse(snapshot.expiresAt) : 0;
      if (force || !snapshot || !/^\d{6}$/.test(snapshot.code) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        let nextCode = '';
        do {
          nextCode = String(randomInt(100_000, 1_000_000));
        } while (nextCode === snapshot?.code);
        snapshot = { code: nextCode, expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() };
        await writeAtomicJson(this.pairingPath, snapshot);
      }
      this.pairingCode = snapshot.code;
      this.pairingExpiresAt = Date.parse(snapshot.expiresAt);
    } finally {
      await releaseFileLock(this.pairingLockPath, token);
    }
  }

  private async acquirePollingLock(): Promise<boolean> {
    const token = await acquireFileLock(this.pollingLockPath, 0, Number.POSITIVE_INFINITY);
    if (!token) return false;
    this.pollingLockToken = token;
    return true;
  }

  private async releasePollingLock(): Promise<void> {
    if (!this.pollingLockToken) return;
    const token = this.pollingLockToken;
    this.pollingLockToken = '';
    await releaseFileLock(this.pollingLockPath, token);
  }
}

function normalizeApiBase(value: string): string {
  const url = new URL(value);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  const isOfficialTelegram = url.protocol === 'https:' && url.hostname === OFFICIAL_TELEGRAM_API_HOST;
  const remoteOverrideAllowed = process.env.MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE === '1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Telegram API base must use HTTPS or a loopback HTTP local Bot API server.');
  }
  if (!isLoopback && !isOfficialTelegram && !remoteOverrideAllowed) {
    throw new Error('Telegram API base must be the official Telegram endpoint or a loopback local Bot API server. Set MONARCH_TELEGRAM_ALLOW_REMOTE_API_BASE=1 only for a trusted custom endpoint.');
  }
  return url.toString().replace(/\/$/, '');
}

type ReminderPayloadResult = { ok: true; text: string; dueAt: string } | { ok: false; summary: string };

function parseReminderPayload(text: string, dueAt: string): ReminderPayloadResult {
  const normalizedText = text.trim();
  const timestamp = Date.parse(dueAt);
  if (!normalizedText || !Number.isFinite(timestamp)) {
    return { ok: false, summary: 'A reminder text and valid dueAt are required.' };
  }
  if (normalizedText.length > MAX_REMINDER_TEXT_CHARS) {
    return { ok: false, summary: `Reminder text is too long; maximum ${MAX_REMINDER_TEXT_CHARS} characters.` };
  }
  return { ok: true, text: normalizedText, dueAt: new Date(timestamp).toISOString() };
}

function reminderCommandErrorMessage(summary: string): string {
  if (summary.includes(`maximum ${MAX_REMINDER_TEXT_CHARS}`)) {
    return `Напоминание слишком длинное: максимум ${MAX_REMINDER_TEXT_CHARS} символов.`;
  }
  return 'Формат: /remind 10m текст или /remind 2026-06-30T18:00:00+03:00 текст';
}

function parseReminderCommand(value: string): { dueAt: string; text: string } | null {
  const match = value.match(/^(\d+)\s*(s|m|h|d|сек(?:унд[ыа]?)?|мин(?:ут[ыа]?)?|ч(?:ас(?:а|ов)?)?|дн(?:я|ей)?)\s+([\s\S]+)$/i);
  if (match) {
    const unit = match[2]!.toLowerCase();
    const multiplier = unit.startsWith('s') || unit.startsWith('сек') ? 1_000
      : unit.startsWith('m') || unit.startsWith('мин') ? 60_000
        : unit.startsWith('h') || unit.startsWith('ч') ? 3_600_000
          : 86_400_000;
    const dueAt = isoFromTimestamp(Date.now() + Number(match[1]) * multiplier);
    return dueAt ? { dueAt, text: match[3]!.trim() } : null;
  }
  const absolute = value.match(/^(\S+)\s+([\s\S]+)$/);
  if (absolute && Number.isFinite(Date.parse(absolute[1]!))) {
    return { dueAt: new Date(absolute[1]!).toISOString(), text: absolute[2]!.trim() };
  }
  return null;
}

function parseNaturalReminder(value: string): { dueAt: string; text: string } | null {
  const match = value.match(/^напомни(?:\s+мне)?\s+через\s+(\d+)\s*(секунд[уы]?|минут[уы]?|час(?:а|ов)?|дн(?:я|ей)?)\s+(.+)$/i);
  if (!match) return null;
  const unit = match[2]!.toLowerCase();
  const multiplier = unit.startsWith('сек') ? 1_000
    : unit.startsWith('мин') ? 60_000
      : unit.startsWith('час') ? 3_600_000
        : 86_400_000;
  const dueAt = isoFromTimestamp(Date.now() + Number(match[1]) * multiplier);
  return dueAt ? { dueAt, text: match[3]!.trim() } : null;
}

function isoFromTimestamp(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface TelegramApprovalPresentation {
  turnId: string;
  taskId: string;
  approvalId: string;
  capabilityId: string;
  canonicalProposalHash: string;
  target: string;
  risk: string;
  expiresAt: string;
  requiresArm: boolean;
}

function readTelegramApprovalPresentation(result: MonarchIntentResult): TelegramApprovalPresentation | null {
  const value = result.execution?.metadata?.approvalPresentation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const required = ['turnId', 'taskId', 'approvalId', 'capabilityId', 'canonicalProposalHash', 'expiresAt'] as const;
  if (required.some((key) => typeof record[key] !== 'string' || !String(record[key]).trim())) return null;
  return {
    turnId: String(record.turnId),
    taskId: String(record.taskId),
    approvalId: String(record.approvalId),
    capabilityId: String(record.capabilityId),
    canonicalProposalHash: String(record.canonicalProposalHash),
    target: String(record.target || 'точная цель указана в proposal'),
    risk: String(record.risk || 'action'),
    expiresAt: String(record.expiresAt),
    requiresArm: record.requiresArm === true,
  };
}

function formatTelegramApprovalCard(summary: string, presentation: TelegramApprovalPresentation): string {
  return [
    summary,
    '',
    `Capability: ${presentation.capabilityId}`,
    `Target: ${presentation.target}`,
    `Risk: ${presentation.risk}`,
    `Expires: ${presentation.expiresAt}`,
    `Hash: ${presentation.canonicalProposalHash}`,
  ].join('\n');
}

function formatIntentResult(result: MonarchIntentResult): string {
  const execution = result.execution;
  if (!execution) return result.summary || 'Monarch не нашёл исполняемый маршрут.';
  if (!execution.ok && execution.error === 'turn-cancelled') return 'Задача отменена.';
  if (!execution.ok) {
    return `Не получилось: ${telegramRemoteFailure(
      'task',
      new Error(execution.summary || result.summary || 'Telegram task failed.'),
      readExecutionUserFacingMessage(execution),
    ).message}`;
  }
  const output = execution.output as Record<string, unknown> | undefined;
  const response = output?.response as Record<string, unknown> | undefined;
  const direct = [
    output?.reply,
    output?.content,
    output?.message,
    output?.result,
    response?.answer,
    response?.content,
    response?.reply,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  if (direct) return direct;
  const capabilities = Array.isArray(output?.capabilities) ? output.capabilities as Array<Record<string, unknown>> : [];
  if (capabilities.length) return formatTelegramCapabilities(capabilities);
  const modules = Array.isArray(output?.modules) ? output.modules as Array<Record<string, unknown>> : [];
  if (modules.length) return formatTelegramModules(modules);
  const entries = Array.isArray(output?.entries) ? output.entries as Array<Record<string, unknown>> : [];
  if (entries.length) {
    return `${result.summary}\n\n${entries.slice(0, 50).map((entry) => `- ${String(entry.name || entry.path || 'item')}${entry.type === 'directory' ? '/' : ''}`).join('\n')}`;
  }
  return execution.summary || result.summary || 'Готово.';
}

function telegramHelp(): string {
  return [
    'Здесь можно общаться с Monarch почти так же, как в приложении.',
    '',
    'Просто напиши:',
    '• «проверь свободное место на диске»',
    '• «напомни через 20 минут выключить духовку»',
    '• «создай файл notes.md»',
    '• отправь фото или PNG/JPEG/WebP-файл и подпиши, что нужно проверить (до 8 МиБ)',
    '• отправь строгий UTF-8 TXT/Markdown/JSON до 32 КиБ: содержимое считается данными, а не командами или разрешением',
    '• после проверенного создания файла нажми точную кнопку «Отправить»: путь останется локальным, uncertain-доставка не повторяется автоматически',
    '• отправь голосовое сообщение до 5 минут: при доступном Voice/STT Monarch локально превратит его в текст задачи',
    '',
    'Команды: /status, /security, /capabilities, /reminders, /poll, /table.',
    'Astra (если локально включён pilot): /astra_read ALIAS запрос.',
    'Интеграции: /plugins.',
    'Контроль: /pending, /stop_task, /whoami, /unlink, /lockdown.',
    'Для опасных действий бот отдельно попросит подтверждение.',
  ].join('\n');
}

function telegramStatusMessage(status: Record<string, unknown>, pending: number): string {
  const mode = String(status.remoteMode || status.pollingMode || 'stopped');
  if (status.remotePaused) {
    return `Monarch на связи, но Telegram-задачи приостановлены локальным защитным режимом. Режим: ${mode}. В очереди доставки: ${pending}.`;
  }
  if (status.running) {
    return `Monarch на связи. Telegram runtime активен. Режим: ${mode}. В очереди доставки: ${pending}.`;
  }
  return 'Telegram-бот настроен, но polling сейчас не активен в этом runtime.';
}

function telegramCapabilityHelp(
  status: Record<string, unknown>,
  pending: number,
  context: MonarchKernelContext | null,
): string {
  const modules = context?.listModules() || [];
  const capabilities = context?.listCapabilities() || [];
  return [
    'Через Telegram я могу:',
    '• отвечать через локальный Oscar, когда backend и модель доступны;',
    '• принимать одно изображение до 8 МиБ: Telegram-фото или PNG/JPEG/WebP-файл как immutable-вложение Oscar (без подписи — описать изображение);',
    '• принимать строгий UTF-8 TXT/Markdown/JSON до 32 КиБ как недоверенные immutable-данные; PDF/DOCX пока требуют отдельного extractor;',
    '• предложить one-shot отправку проверенного task artifact; только exact button, workspace realpath и digest-bound multipart receipt;',
    '• локально распознавать Telegram voice note до 5 минут; сырое аудио не становится Oscar-вложением;',
    '• запускать реальные Monarch capabilities: файлы workspace, память, поиск, модели, диагностика и безопасность;',
    '• ставить напоминания, создавать опросы, отправлять таблицы и вызывать совместимые Bot API методы;',
    '• показывать через /plugins фактические модули и capabilities именно этого Monarch runtime;',
    '',
    `Фактический Kernel-каталог: ${modules.length} модулей, ${capabilities.length} capabilities. Подробности: /plugins.`,
    'Регистрация capability не означает автоматический выбор агентом или удалённое разрешение на её запуск.',
    `Режим сейчас: ${status.remotePaused ? 'защитный lockdown' : status.running ? 'agent' : 'stopped'}. Durable-задач в очереди доставки: ${pending}.`,
    'Опасные действия не выполняются молча: write/network/execute/delete проходят через одноразовое подтверждение.',
  ].join('\n');
}

function telegramSecurityHelp(status: Record<string, unknown>, pending: number): string {
  return [
    'Безопасность Telegram-бота:',
    `• режим: ${status.remotePaused ? 'lockdown, новые задачи остановлены' : 'agent, задачи разрешены после привязки'};`,
    '• доступ только для привязанных chat_id/user_id;',
    '• новые привязки по короткому локальному коду;',
    '• опасные действия требуют inline-подтверждения;',
    '• /lockdown сразу останавливает новые задачи и старые pending-кнопки;',
    `• durable-задач в очереди доставки: ${pending}.`,
  ].join('\n');
}

function telegramPluginHelp(context: MonarchKernelContext | null): string {
  const modules = context?.listModules() || [];
  const rows = modules.slice(0, 24).map((record) => {
    const count = context?.listCapabilities(record.manifest.id).length || 0;
    return `• ${record.manifest.id} · ${record.status} · ${count} capabilities`;
  });
  const capabilityCount = modules.reduce(
    (total, record) => total + (context?.listCapabilities(record.manifest.id).length || 0),
    0,
  );
  return [
    'Фактические extension surfaces этого Monarch runtime:',
    ...(rows.length ? rows : ['• Каталог runtime сейчас недоступен.']),
    ...(modules.length > rows.length ? [`…и ещё ${modules.length - rows.length} модулей.`] : []),
    '',
    `Итого: ${modules.length} модулей, ${capabilityCount} capabilities.`,
    'Telegram может использовать только capabilities, реально зарегистрированные в этом локальном Kernel.',
    'Коннекторы и плагины среды Codex/ChatGPT автоматически в Monarch не наследуются.',
  ].join('\n');
}

function formatTelegramCapabilities(capabilities: Array<Record<string, unknown>>): string {
  const rows = capabilities.slice(0, 18).map((capability) => {
    const id = String(capability.id || capability.title || 'capability');
    const risk = String(capability.risk || 'read');
    return `• ${id} · ${formatRisk(risk)}`;
  });
  const tail = capabilities.length > rows.length ? `\n…и ещё ${capabilities.length - rows.length}.` : '';
  return `Доступные capabilities Monarch:\n${rows.join('\n')}${tail}`;
}

function formatTelegramModules(modules: Array<Record<string, unknown>>): string {
  const rows = modules.slice(0, 14).map((module) => {
    const capabilities = Array.isArray(module.capabilities) ? module.capabilities.length : Number(module.capabilities || 0);
    return `• ${String(module.id || module.moduleId || module.name || 'module')} · ${capabilities} capabilities · ${String(module.status || 'unknown')}`;
  });
  const tail = modules.length > rows.length ? `\n…и ещё ${modules.length - rows.length}.` : '';
  return `Активные extension surfaces:\n${rows.join('\n')}${tail}`;
}

function formatRisk(value: string): string {
  return value === 'read' ? 'чтение'
    : value === 'write' ? 'запись'
      : value === 'network' ? 'сеть'
        : value === 'execute' ? 'execute'
          : value === 'delete' ? 'delete'
            : value;
}

function isTelegramStatusQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(статус|состояни|работа|связь|status|health).*(бот|telegram|телеграм|тг|monarch|runtime|рантайм)/i.test(text)
    || /^(статус|status)$/i.test(text.trim());
}

function isTelegramCapabilityQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(что|чем|какие|какой|как).{0,80}(умеешь|можешь|возможност|команд|инструмент|capabilit|tool|action)/i.test(text)
    || /(умеешь|можешь).{0,80}(через|внутри|из).{0,40}(telegram|телеграм|тг|бот)/i.test(text)
    || /(available actions|what can you do|commands|capabilities)/i.test(text);
}

function isTelegramPluginQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(плагин|плагины|plugin|plugins|интеграц).{0,120}(telegram|телеграм|тг|бот|github|hugging|creative|security|codex)/i.test(text)
    || /(codex-security|creative production|github|hugging face|huggingface).{0,120}(telegram|телеграм|тг|бот|интеграц|плагин)/i.test(text);
}

function isTelegramSecurityQuestion(value: string): boolean {
  const text = value.toLowerCase();
  return /(безопас|security|защит|lockdown|подтвержден).{0,120}(telegram|телеграм|тг|бот|режим)/i.test(text)
    || /(режим|mode).{0,80}(telegram|телеграм|тг|бот)/i.test(text);
}

function telegramPairingHelp(): string {
  return [
    'Этот чат пока не связан с Monarch.',
    '',
    '1. Открой Monarch Control → Telegram.',
    '2. Нажми «Создать новый код».',
    '3. Пришли сюда шесть цифр одним сообщением.',
    '',
    'Команду /pair вводить больше не обязательно.',
  ].join('\n');
}

function telegramBotCommands(): Array<{ command: string; description: string }> {
  return [
    { command: 'start', description: 'Открыть Monarch Telegram' },
    { command: 'help', description: 'Показать возможности и форматы команд' },
    { command: 'status', description: 'Проверить связь с локальным Monarch' },
    { command: 'security', description: 'Показать краткий статус защиты' },
    { command: 'capabilities', description: 'Показать возможности текущего Kernel' },
    { command: 'skills', description: 'Алиас списка возможностей Monarch' },
    { command: 'plugins', description: 'Показать plugin-направления' },
    { command: 'pending', description: 'Показать текущую Agent-задачу' },
    { command: 'stop_task', description: 'Отменить текущую задачу этого чата' },
    { command: 'astra_read', description: 'Прочитать локально разрешённый Astra target' },
    { command: 'whoami', description: 'Показать текущую привязку' },
    { command: 'task', description: 'Поставить обычную задачу Monarch' },
    { command: 'remind', description: 'Создать локальное напоминание' },
    { command: 'reminders', description: 'Показать активные напоминания' },
    { command: 'cancel', description: 'Отменить напоминание по ID' },
    { command: 'poll', description: 'Создать нативный опрос' },
    { command: 'table', description: 'Отправить таблицу' },
    { command: 'api', description: 'Вызвать совместимый Bot API метод' },
    { command: 'unlink', description: 'Удалить привязку этого чата' },
    { command: 'lockdown', description: 'Остановить удалённые задачи' },
    { command: 'pair', description: 'Привязать этот чат по временному коду' },
  ];
}

function telegramApiMethodDefaultsToChatId(method: string): boolean {
  return TELEGRAM_PAIRED_CHAT_API_METHODS.has(method.trim().toLowerCase());
}

function telegramApiMethodSupportsPairedChatScope(method: string): boolean {
  return /^getMe$/iu.test(method.trim()) || telegramApiMethodDefaultsToChatId(method);
}

function telegramIntentContext(
  chatId: number,
  userId: number,
  messageId?: number,
  allowContinuation = false,
  pairingEpoch?: string,
  remotePaused = false,
  zeroRetention = false,
): Record<string, unknown> {
  return {
    telegramChatId: chatId,
    telegramUserId: userId,
    clientConversationId: `telegram:${chatId}:${userId}`,
    clientSessionId: `telegram:${chatId}:${userId}`,
    ...(pairingEpoch ? { telegramPairingEpoch: pairingEpoch, telegramPaired: true } : {}),
    telegramRemotePaused: remotePaused,
    telegramZeroRetention: zeroRetention,
    ...(allowContinuation ? { telegramContinuationAllowed: true } : {}),
    ...(messageId !== undefined ? {
      telegramMessageId: messageId,
      clientRequestId: `telegram:${chatId}:${messageId}`,
      clientMessageId: `telegram:${chatId}:${messageId}`,
    } : {}),
  };
}

function formatTelegramActivity(activity: TelegramIntentActivity | null | undefined, pendingDeliveries: number): string {
  const delivery = pendingDeliveries > 0 ? ` В очереди доставки: ${pendingDeliveries}.` : '';
  if (!activity) return `Сейчас у этого чата нет активной Agent-задачи.${delivery}`;
  const label = activity.status === 'waiting-for-approval'
    ? 'ждёт точного подтверждения в карточке'
    : activity.status === 'waiting-for-user'
      ? 'ждёт твоего уточнения'
      : 'выполняется';
  return `Текущая Agent-задача ${label}. Статус: ${activity.status}.${delivery}`;
}

type TelegramDurableProgressStatus = NonNullable<TelegramPendingTaskDelivery['projectedTurnStatus']>;

function readTelegramDurableProgressStatus(result: MonarchIntentResult): TelegramDurableProgressStatus | null {
  const output = result.execution?.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const status = String((output as Record<string, unknown>).status || '');
  return ['accepted', 'routing', 'answering', 'running'].includes(status)
    ? status as TelegramDurableProgressStatus
    : null;
}

function formatTelegramDurableProgress(status: TelegramDurableProgressStatus): string {
  switch (status) {
  case 'routing': return 'Задача сохранена. Выбираю безопасный маршрут…';
  case 'answering': return 'Маршрут выбран. Готовлю проверяемый ответ…';
  case 'running': return 'Astra выполняет задачу через разрешённые возможности Monarch…';
  default: return 'Принял. Задача сохранена…';
  }
}

type PollOptionPayload = { text: string };
type PollPayloadResult = { ok: true; question: string; options: PollOptionPayload[] } | { ok: false; summary: string };

function parsePollCommand(value: string): { ok: true; question: string; options: PollOptionPayload[] } | { ok: false; message: string } {
  const parts = value.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 1 + MIN_POLL_OPTIONS) {
    return { ok: false, message: 'Формат: /poll Вопрос | Вариант 1' };
  }
  const parsed = parsePollPayload(parts[0] || '', parts.slice(1));
  if (!parsed.ok) {
    return { ok: false, message: pollCommandErrorMessage(parsed.summary) };
  }
  return parsed;
}

function parsePollPayload(question: string, options: string[]): PollPayloadResult {
  const normalizedQuestion = question.trim();
  const normalizedOptions = options.map((option) => option.trim()).filter(Boolean);
  if (!normalizedQuestion || normalizedOptions.length < MIN_POLL_OPTIONS) {
    return { ok: false, summary: 'A poll question and at least one option are required.' };
  }
  if (normalizedQuestion.length > MAX_POLL_QUESTION_CHARS) {
    return { ok: false, summary: `Poll question is too long; maximum ${MAX_POLL_QUESTION_CHARS} characters.` };
  }
  if (normalizedOptions.length > MAX_POLL_OPTIONS) {
    return { ok: false, summary: `Poll has too many options; maximum ${MAX_POLL_OPTIONS}.` };
  }
  if (normalizedOptions.some((option) => option.length > MAX_POLL_OPTION_CHARS)) {
    return { ok: false, summary: `Poll option is too long; maximum ${MAX_POLL_OPTION_CHARS} characters.` };
  }
  return { ok: true, question: normalizedQuestion, options: normalizedOptions.map((text) => ({ text })) };
}

function pollCommandErrorMessage(summary: string): string {
  if (summary.includes(`maximum ${MAX_POLL_QUESTION_CHARS}`)) {
    return `Вопрос опроса слишком длинный: максимум ${MAX_POLL_QUESTION_CHARS} символов.`;
  }
  if (summary.includes(`maximum ${MAX_POLL_OPTIONS}`)) {
    return `Опрос слишком большой: максимум ${MAX_POLL_OPTIONS} вариантов.`;
  }
  if (summary.includes(`maximum ${MAX_POLL_OPTION_CHARS}`)) {
    return `Вариант опроса слишком длинный: максимум ${MAX_POLL_OPTION_CHARS} символов.`;
  }
  return 'Формат: /poll Вопрос | Вариант 1';
}

function parseTableCommand(value: string): { ok: true; markdown: string } | { ok: false; message: string } {
  const parts = value.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return { ok: false, message: 'Формат: /table Заголовок | Колонка 1, Колонка 2 | Значение 1, Значение 2' };
  }
  const rowInputs = parts.slice(1);
  if (rowInputs.length > MAX_TABLE_ROWS) {
    return { ok: false, message: `Таблица слишком длинная: максимум ${MAX_TABLE_ROWS - 1} строк данных.` };
  }
  const rows = rowInputs.map((row) => row.split(',').map((cell) => escapeMarkdownCell(cell.trim().slice(0, MAX_TABLE_CELL_CHARS))));
  const width = Math.max(...rows.map((row) => row.length));
  if (width > MAX_TABLE_COLUMNS) {
    return { ok: false, message: `Таблица слишком широкая: максимум ${MAX_TABLE_COLUMNS} колонок.` };
  }
  const header = rows[0]!;
  const markdown = [
    `## ${escapeMarkdownCell(parts[0]!.slice(0, MAX_TABLE_TITLE_CHARS))}`,
    `| ${padRow(header, width).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${padRow(row, width).join(' | ')} |`),
  ].join('\n');
  if (markdown.length > MAX_TABLE_MARKDOWN_CHARS) {
    return { ok: false, message: `Таблица слишком большая: максимум ${MAX_TABLE_MARKDOWN_CHARS} символов.` };
  }
  return { ok: true, markdown };
}

function isSameReminder(left: TelegramReminder, right: TelegramReminder): boolean {
  return left.id === right.id
    && left.chatId === right.chatId
    && left.dueAt === right.dueAt
    && left.createdAt === right.createdAt;
}

function splitMessage(value: string): string[] {
  const parts: string[] = [];
  let rest = value.trim();
  while (rest.length > MAX_MESSAGE_CHARS) {
    let at = rest.lastIndexOf('\n', MAX_MESSAGE_CHARS);
    if (at < MAX_MESSAGE_CHARS / 2) at = rest.lastIndexOf(' ', MAX_MESSAGE_CHARS);
    if (at < MAX_MESSAGE_CHARS / 2) at = MAX_MESSAGE_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : ['Готово.'];
}

async function readBoundedTelegramApiResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Telegram Bot API response exceeds ${maxBytes} bytes.`);
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Telegram Bot API response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function readBoundedTelegramFileResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Telegram file exceeds ${maxBytes} bytes or has an invalid length.`);
    }
  }
  if (!response.body) throw new Error('Telegram file response is empty.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Telegram file exceeds ${maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) throw new Error('Telegram file response is empty.');
  return Buffer.concat(chunks, total);
}

function isValidTelegramPhotoSize(value: unknown): value is TelegramPhotoSize {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<TelegramPhotoSize>;
  return typeof entry.file_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_id)
    && typeof entry.file_unique_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_unique_id)
    && Number.isSafeInteger(entry.width)
    && Number(entry.width) > 0
    && Number(entry.width) <= 100_000
    && Number.isSafeInteger(entry.height)
    && Number(entry.height) > 0
    && Number(entry.height) <= 100_000
    && (entry.file_size === undefined
      || (Number.isSafeInteger(entry.file_size) && Number(entry.file_size) > 0));
}

const TELEGRAM_IMAGE_MIME_TYPES = new Set<TelegramImageMimeType>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const TELEGRAM_TEXT_MIME_TYPES = new Set<TelegramTextMimeType>([
  'text/plain',
  'text/markdown',
  'application/json',
]);

const TELEGRAM_TEXT_EXTENSIONS = new Map<TelegramTextMimeType, ReadonlySet<string>>([
  ['text/plain', new Set(['txt'])],
  ['text/markdown', new Set(['md', 'markdown'])],
  ['application/json', new Set(['json'])],
]);

const strictTelegramUtf8 = new TextDecoder('utf-8', { fatal: true });

function isValidTelegramImageDocument(value: unknown): value is TelegramDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<TelegramDocument>;
  return typeof entry.file_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_id)
    && typeof entry.file_unique_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_unique_id)
    && typeof entry.mime_type === 'string'
    && TELEGRAM_IMAGE_MIME_TYPES.has(entry.mime_type as TelegramImageMimeType)
    && (entry.file_size === undefined
      || (Number.isSafeInteger(entry.file_size) && Number(entry.file_size) > 0));
}

function isValidTelegramTextDocument(value: unknown): value is TelegramDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<TelegramDocument>;
  const mimeType = entry.mime_type as TelegramTextMimeType;
  const fileName = String(entry.file_name || '').normalize('NFC').trim();
  const extension = /\.([A-Za-z0-9]{1,16})$/u.exec(fileName)?.[1]?.toLowerCase() || '';
  return typeof entry.file_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_id)
    && typeof entry.file_unique_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_unique_id)
    && TELEGRAM_TEXT_MIME_TYPES.has(mimeType)
    && fileName.length > 0
    && fileName.length <= 120
    && !/[\\/\u0000-\u001F\u007F]/u.test(fileName)
    && Boolean(TELEGRAM_TEXT_EXTENSIONS.get(mimeType)?.has(extension))
    && (entry.file_size === undefined
      || (Number.isSafeInteger(entry.file_size)
        && Number(entry.file_size) > 0
        && Number(entry.file_size) <= TELEGRAM_TEXT_ATTACHMENT_MAX_BYTES));
}

function isValidTelegramOfficeDocument(value: unknown): value is TelegramDocument {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<TelegramDocument>;
  return typeof d.file_id === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(d.file_id)
    && typeof d.file_unique_id === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(d.file_unique_id)
    && typeof d.file_name === 'string' && (d.mime_type === 'application/pdf' && /\.pdf$/iu.test(d.file_name)
      || d.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && /\.docx$/iu.test(d.file_name))
    && (d.file_size === undefined || Number.isSafeInteger(d.file_size) && Number(d.file_size) > 0 && Number(d.file_size) <= TELEGRAM_ATTACHMENT_MAX_BYTES);
}

function assertTelegramTextDocumentBytes(data: Buffer, mimeType: TelegramTextMimeType): void {
  if (data.byteLength < 1 || data.byteLength > TELEGRAM_TEXT_ATTACHMENT_MAX_BYTES) {
    throw new Error(`Telegram text document must contain 1-${TELEGRAM_TEXT_ATTACHMENT_MAX_BYTES} bytes.`);
  }
  let content: string;
  try {
    content = strictTelegramUtf8.decode(data);
  } catch {
    throw new Error('Telegram text document must contain strict UTF-8.');
  }
  if (content.includes('\0')) throw new Error('Telegram text document contains a NUL byte.');
  if (mimeType === 'application/json') {
    try {
      JSON.parse(content.replace(/^\uFEFF/u, ''));
    } catch {
      throw new Error('Telegram JSON document is not valid JSON.');
    }
  }
}

function isValidTelegramVoice(value: unknown): value is TelegramVoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<TelegramVoice>;
  return typeof entry.file_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_id)
    && typeof entry.file_unique_id === 'string'
    && /^[A-Za-z0-9_-]{1,256}$/u.test(entry.file_unique_id)
    && Number.isSafeInteger(entry.duration)
    && Number(entry.duration) > 0
    && Number(entry.duration) <= TELEGRAM_VOICE_MAX_DURATION_SECONDS
    && (entry.mime_type === undefined || entry.mime_type === 'audio/ogg')
    && (entry.file_size === undefined
      || (Number.isSafeInteger(entry.file_size) && Number(entry.file_size) > 0));
}

function telegramAttachmentIdempotencyKey(message: TelegramMessage, fileUniqueId: string): string {
  return `telegram:${message.chat.id}:${message.message_id}:${createHash('sha256')
    .update(fileUniqueId)
    .digest('hex')}`;
}

function telegramImageExtension(mimeType: TelegramImageMimeType): 'jpg' | 'png' | 'webp' {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

function telegramTextExtension(mimeType: TelegramTextMimeType): 'txt' | 'md' | 'json' {
  if (mimeType === 'text/markdown') return 'md';
  if (mimeType === 'application/json') return 'json';
  return 'txt';
}

function normalizeTelegramArtifactOfferName(value: string): string {
  const name = String(value || '').normalize('NFC').trim();
  if (!name || name.length > 120 || /[\\/\u0000-\u001F\u007F]/u.test(name) || name === '.' || name === '..') {
    throw new Error('Telegram artifact offer has an invalid name.');
  }
  return name;
}

function decodeTelegramArtifactPayload(
  payload: TelegramArtifactEgressPayload,
  offer: TelegramArtifactEgressOffer,
): Buffer {
  if (payload.turnId !== offer.turnId || payload.taskId !== offer.taskId
    || payload.artifactId !== offer.artifactId || payload.name !== offer.name
    || payload.checksum !== offer.checksum
    || !/^sha256:[a-f0-9]{64}$/u.test(payload.permitDigest)
    || !Number.isSafeInteger(payload.sizeBytes) || payload.sizeBytes < 1
    || payload.sizeBytes > TELEGRAM_ATTACHMENT_MAX_BYTES
    || !new Set([
      'text/plain', 'text/markdown', 'application/json',
      'image/png', 'image/jpeg', 'image/webp', 'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]).has(payload.mimeType)) {
    throw new Error('Telegram artifact payload does not match its sealed offer.');
  }
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 10 * 60 * 1000) {
    throw new Error('Telegram artifact permit expiry is invalid.');
  }
  const encoded = String(payload.dataBase64 || '').trim();
  const bytes = Buffer.from(encoded, 'base64');
  if (!encoded || bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
    || bytes.byteLength !== payload.sizeBytes
    || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== payload.checksum) {
    throw new Error('Telegram artifact bytes do not match their verified digest.');
  }
  return bytes;
}

function telegramPhotoArea(value: TelegramPhotoSize): number {
  return value.width * value.height;
}

function normalizeTelegramFilePath(value: unknown): string {
  const normalized = String(value || '').trim().replace(/\\/gu, '/');
  if (!normalized || normalized.length > 512 || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error('Telegram returned an invalid file path.');
  }
  const segments = normalized.split('/');
  if (segments.length > 16 || segments.some((segment) => !/^[A-Za-z0-9._-]{1,128}$/u.test(segment)
    || segment === '.' || segment === '..')) {
    throw new Error('Telegram returned an invalid file path.');
  }
  return segments.join('/');
}

function padRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => row[index] || '');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function readString(input: unknown, key: string): string {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(input: unknown, key: string): number | undefined {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function readBoolean(input: unknown, key: string): boolean {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return value === true;
}

function readStringArray(input: unknown, key: string): string[] {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function sanitizeTelegramResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function redactApiBase(value: string): string {
  return value.replace(/\/bot[^/]+/i, '/bot***');
}

function readTelegramRetryAfterMs(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return null;
  return Math.min(60 * 60 * 1_000, Math.max(1_000, Number(value) * 1_000));
}

function telegramRetryDelay(error: unknown, fallbackMs: number): number {
  return error instanceof TelegramBotApiError && error.retryAfterMs !== null
    ? error.retryAfterMs
    : fallbackMs;
}

type TelegramRemoteFailureKind = 'attachment' | 'command' | 'admission' | 'task' | 'approval' | 'delivery';

interface TelegramRemoteFailureProjection {
  diagnosticId: string;
  diagnostic: string;
  message: string;
}

function telegramRemoteFailure(
  kind: TelegramRemoteFailureKind,
  error: unknown,
  preferredMessage?: string,
): TelegramRemoteFailureProjection {
  const diagnostic = safeError(error);
  const diagnosticId = `TG-${createHash('sha256').update(`${kind}:${diagnostic}`).digest('hex').slice(0, 12).toUpperCase()}`;
  const preferred = preferredMessage ? redactSensitiveDiagnostic(preferredMessage).slice(0, 400).trim() : '';
  const transportFailure = /(?:Telegram Bot API|fetch failed|timed out|network|ECONN|socket|aborted)/iu.test(diagnostic);
  let message = preferred;
  if (!message && kind === 'attachment') {
    message = /(?:exceeds|too.large|invalid length|empty)/iu.test(diagnostic)
      ? 'файл превышает лимит 8 МиБ или содержит неверный размер.'
      : transportFailure
        ? 'Telegram не завершил загрузку. Повтори отправку.'
        : 'формат или содержимое файла не прошло локальную проверку.';
  }
  if (!message && transportFailure) message = 'Telegram API временно не ответил. Повтор безопасен.';
  if (!message) {
    message = kind === 'admission'
      ? 'Monarch не смог надёжно зафиксировать задачу.'
      : kind === 'approval'
        ? 'карточка не прошла проверку привязки или уже устарела.'
        : kind === 'delivery'
          ? 'Telegram не подтвердил доставку результата.'
        : kind === 'command'
          ? 'локальный runtime не смог завершить команду.'
          : 'локальный runtime завершил задачу с ошибкой.';
  }
  return {
    diagnosticId,
    diagnostic,
    message: `${message} Код диагностики: ${diagnosticId}.`,
  };
}

function readExecutionUserFacingMessage(execution: MonarchExecutionResult): string {
  const value = execution.userFacing?.message;
  return typeof value === 'string' ? value.trim() : '';
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSensitiveDiagnostic(raw).slice(0, 1_000) || 'Unknown local error.';
}

function redactSensitiveDiagnostic(value: string): string {
  return String(value || '')
    .replace(/bot\d+:[A-Za-z0-9_-]+/giu, 'bot***')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer ***')
    .replace(/\b(?:sk|hf|ghp|github_pat|xoxb|xoxp|xoxa|xoxr)[-_][A-Za-z0-9_-]{8,}\b/giu, '[secret]')
    .replace(/\b(?:access[_-]?token|api[_-]?key|apikey|secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '[secret]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu, '[secret]')
    .replace(/([?&](?:access_token|api_key|apikey|key|secret|token)=)[^&\s]+/giu, '$1***')
    .replace(/https?:\/\/[^\s?#]+(?:[?#][^\s]*)?/giu, '[remote-url]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"']{1,400}/gu, '[local-path]')
    .replace(/\\\\[^\r\n"']{1,400}/gu, '[local-path]')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim();
}

async function readSecret(filePath: string): Promise<string> {
  try {
    return (await readFile(filePath, 'utf8')).trim().replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimOldestMapEntries<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export function createTelegramModule(options: TelegramModuleOptions = {}): MonarchModule {
  return new TelegramModule(options);
}

export const telegramModulePackage: MonarchModulePackage = {
  id: telegramManifest.id,
  moduleId: telegramManifest.id,
  version: telegramManifest.version,
  description: telegramManifest.description,
  core: { minVersion: '0.1.0' },
  factory: (context) => createTelegramModule(
    context?.workspaceRoot ? { projectRoot: context.workspaceRoot } : {},
  ),
};
