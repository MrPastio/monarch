import { createHash } from 'node:crypto';

export const ASTRA_TELEGRAM_REMOTE_MODE = 'paired-workspace-read-v1' as const;
export const ASTRA_TELEGRAM_CONSENT_VERSION = 'monarch.astra-telegram-workspace-read.v1' as const;

export interface AstraTelegramRemoteAdmissionInput {
  version: 1;
  chatId: number;
  userId: number;
  messageId: number;
  pairingEpoch: string;
  paired: boolean;
  remotePaused: boolean;
  zeroRetention: boolean;
  consentVersion: typeof ASTRA_TELEGRAM_CONSENT_VERSION;
  operation: 'workspace-read';
  targetAlias: string;
  text: string;
}

export type AstraTelegramRemotePrincipalInput = Pick<AstraTelegramRemoteAdmissionInput,
  'chatId' | 'userId' | 'pairingEpoch' | 'paired' | 'remotePaused' | 'zeroRetention' | 'consentVersion'>;
export type AstraTelegramRemoteIdentityInput = Pick<AstraTelegramRemoteAdmissionInput,
  'chatId' | 'userId' | 'pairingEpoch' | 'paired'>;

export interface AstraTelegramRemotePrincipal {
  actor: { id: `sha256:${string}`; source: 'telegram' };
  conversationId: string;
}

export interface AstraTelegramRemoteAdmission {
  version: 1;
  source: 'telegram';
  actor: { id: `sha256:${string}`; source: 'telegram' };
  clientRequestId: string;
  conversationId: string;
  inputMessageId: string;
  privacyMode: 'persistent';
  operation: 'workspace-read';
  targetAlias: string;
  text: string;
  authority: 'read-only';
  authorizesCreate: false;
  authorizesComputer: false;
}

/** Pure default-off gate. It creates no runtime, state, selection or authority.
 * A trusted local host must separately resolve the opaque alias for this actor. */
export function createAstraTelegramRemoteAdmissionPolicy(
  mode?: string,
): AstraTelegramRemoteAdmissionPolicy | null {
  return mode === ASTRA_TELEGRAM_REMOTE_MODE ? new AstraTelegramRemoteAdmissionPolicy() : null;
}

export class AstraTelegramRemoteAdmissionPolicy {
  /** Exact paired identity for status/cancellation only. It deliberately ignores
   * pause, retention and consent so a kill switch can still cancel prior work;
   * it cannot admit, resume or deliver a remote result. */
  identity(value: unknown): AstraTelegramRemotePrincipal {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw admissionError('invalid-binding');
    const input = value as Partial<AstraTelegramRemoteIdentityInput>;
    const allowed = ['chatId', 'userId', 'pairingEpoch', 'paired'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw admissionError('unknown-field');
    this.validateIdentity(input);
    return this.derivePrincipal(input as AstraTelegramRemoteIdentityInput);
  }

  principal(value: unknown): AstraTelegramRemotePrincipal {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw admissionError('invalid-binding');
    const input = value as Partial<AstraTelegramRemotePrincipalInput>;
    const allowed = ['chatId', 'userId', 'pairingEpoch', 'paired', 'remotePaused', 'zeroRetention', 'consentVersion'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw admissionError('unknown-field');
    this.validatePrincipal(input);
    return this.derivePrincipal(input as AstraTelegramRemotePrincipalInput);
  }

  admit(value: unknown): AstraTelegramRemoteAdmission {
    const input = this.validate(value);
    const principal = this.derivePrincipal(input);
    const actorDigest = principal.actor.id.slice('sha256:'.length);
    const messageDigest = digest([
      'monarch.astra-v3.telegram-message.v1',
      actorDigest,
      String(input.messageId),
    ]);
    return {
      version: 1,
      source: 'telegram',
      actor: principal.actor,
      clientRequestId: `telegram_request_${messageDigest.slice(0, 48)}`,
      conversationId: principal.conversationId,
      inputMessageId: `telegram_message_${messageDigest.slice(0, 48)}`,
      privacyMode: 'persistent',
      operation: 'workspace-read',
      targetAlias: input.targetAlias,
      text: input.text.trim(),
      authority: 'read-only',
      authorizesCreate: false,
      authorizesComputer: false,
    };
  }

  private validate(value: unknown): AstraTelegramRemoteAdmissionInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw admissionError('invalid-request');
    const input = value as Partial<AstraTelegramRemoteAdmissionInput>;
    const allowed = [
      'version', 'chatId', 'userId', 'messageId', 'pairingEpoch', 'paired', 'remotePaused',
      'zeroRetention', 'consentVersion', 'operation', 'targetAlias', 'text',
    ];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw admissionError('unknown-field');
    if (input.version !== 1 || !Number.isSafeInteger(input.messageId) || Number(input.messageId) <= 0) {
      throw admissionError('invalid-binding');
    }
    this.validatePrincipal(input);
    if (input.operation !== 'workspace-read') throw admissionError('operation-denied');
    if (typeof input.targetAlias !== 'string'
      || !/^astra_remote_alias_[A-Za-z0-9_-]{16,64}$/u.test(input.targetAlias)) {
      throw admissionError('host-alias-required');
    }
    if (typeof input.text !== 'string' || !input.text.trim()
      || Buffer.byteLength(input.text.trim(), 'utf8') > 8_192) {
      throw admissionError('invalid-text');
    }
    return input as AstraTelegramRemoteAdmissionInput;
  }

  private validatePrincipal(input: Partial<AstraTelegramRemotePrincipalInput>): void {
    this.validateIdentity(input);
    if (input.remotePaused !== false) throw admissionError('remote-paused');
    if (input.zeroRetention !== false) throw admissionError('persistent-mode-required');
    if (input.consentVersion !== ASTRA_TELEGRAM_CONSENT_VERSION) throw admissionError('consent-required');
  }

  private validateIdentity(input: Partial<AstraTelegramRemoteIdentityInput>): void {
    if (!Number.isSafeInteger(input.chatId) || input.chatId === 0
      || !Number.isSafeInteger(input.userId) || Number(input.userId) <= 0
      || typeof input.pairingEpoch !== 'string' || !Number.isFinite(Date.parse(input.pairingEpoch))) {
      throw admissionError('invalid-binding');
    }
    if (input.paired !== true) throw admissionError('pairing-required');
  }

  private derivePrincipal(input: AstraTelegramRemoteIdentityInput): AstraTelegramRemotePrincipal {
    const actorDigest = digest(['monarch.astra-v3.telegram-actor.v1', String(input.chatId), String(input.userId), input.pairingEpoch]);
    return { actor: { id: `sha256:${actorDigest}`, source: 'telegram' },
      conversationId: `telegram_remote_${actorDigest.slice(0, 48)}` };
  }
}

function digest(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(Buffer.byteLength(part, 'utf8'))).update(':').update(part).update('|');
  return hash.digest('hex');
}

function admissionError(code: string): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(`astra-telegram:${code}`), { code: `astra-telegram-${code}`, statusCode: 403 });
}
