import { cloudProvider, validCloudModel, type MaxCloudProviderId } from './max-cloud-catalog';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
  ASTRA_MAX_PROVIDER_ID,
  validAstraMaxConsent,
  type AstraMaxDeployment,
  type AstraMaxProviderConsentV1,
} from './max-provider-contract';
import { renameWithWindowsRetry } from '../core/durable-json-file';

const RECORD_VERSION = 'monarch.astra-max.settings.v1' as const;
const RECORD_FILE = 'groq-max.safe';
const MAX_PROTECTED_BYTES = 64 * 1024;

export interface AstraMaxProtectedStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export type AstraMaxSettingsStatus = Readonly<{
  state: 'ready' | 'not-configured' | 'unavailable' | 'corrupt';
  providerId: MaxCloudProviderId;
  agreementVersion: typeof ASTRA_MAX_PROVIDER_AGREEMENT_VERSION;
  acceptedAt: string | null;
  modelId?: string;
}>;

export class AstraMaxSettingsError extends Error {
  constructor(readonly code: string) {
    super('astra-max-settings:' + code);
    this.name = 'AstraMaxSettingsError';
  }
}

/** Host-only encrypted settings boundary. It has no renderer serialization API. */
export class AstraMaxSettingsStore {
  private readonly root: string;
  private readonly file: string;
  private readonly now: () => number;

  constructor(private readonly options: {
    deployment: AstraMaxDeployment;
    rootPath: string;
    providerId?: MaxCloudProviderId;
    protectedStorage: AstraMaxProtectedStorage;
    restrictAccess: (rootPath: string) => Promise<boolean>;
    now?: () => number;
    randomId?: () => string;
  }) {
    check(['isolated-validation', 'source-preview', 'native-desktop'].includes(options.deployment), 'deployment');
    check(path.isAbsolute(options.rootPath) && options.rootPath.length <= 1024, 'root');
    check(typeof options.restrictAccess === 'function', 'access-policy');
    this.root = path.resolve(options.rootPath);
    check(cloudProvider(options.providerId ?? 'groq'), 'provider');
    this.file = path.join(this.root, options.providerId && options.providerId !== 'groq' ? options.providerId + '-max.safe' : RECORD_FILE);
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<AstraMaxSettingsStatus> {
    if (!this.encryptionAvailable()) return this.publicStatus('unavailable');
    try {
      await this.prepareRoot(false);
      const record = await this.readRecord();
      return { ...this.publicStatus('ready', record.consent.acceptedAt), ...(record.modelId ? { modelId: record.modelId } : {}) };
    } catch (error) {
      if (error instanceof AstraMaxSettingsError && error.code === 'not-configured') return this.publicStatus('not-configured');
      return this.publicStatus(error instanceof AstraMaxSettingsError
        && ['encryption-unavailable', 'access-denied', 'root-unavailable'].includes(error.code)
        ? 'unavailable' : 'corrupt');
    }
  }

  async saveSetup(input: { apiKey: string; consent: AstraMaxProviderConsentV1; modelId?: string }): Promise<AstraMaxSettingsStatus> {
    check(this.encryptionAvailable(), 'encryption-unavailable');
    check(validKey(input.apiKey), 'credential-invalid');
    check(validAstraMaxConsent(input.consent, this.currentTime(), this.options.providerId ?? 'groq'), 'consent-required');
    check(input.modelId === undefined || validCloudModel(input.modelId), 'model');
    await this.prepareRoot(true);
    const recordId = this.recordId();
    const record = JSON.stringify({
      schemaVersion: RECORD_VERSION,
      recordId,
      providerId: this.options.providerId ?? ASTRA_MAX_PROVIDER_ID,
      consent: structuredClone(input.consent),
      apiKey: input.apiKey,
      ...(input.modelId ? { modelId: input.modelId } : {}),
    });
    let protectedBytes: Buffer;
    try {
      protectedBytes = Buffer.from(this.options.protectedStorage.encryptString(record));
      check(protectedBytes.byteLength > 0 && protectedBytes.byteLength <= MAX_PROTECTED_BYTES, 'protected-record');
      check(this.options.protectedStorage.decryptString(protectedBytes) === record, 'protected-record');
    } catch (error) {
      if (error instanceof AstraMaxSettingsError) throw error;
      throw new AstraMaxSettingsError('protected-record');
    }
    const temporary = path.join(this.root, `.${RECORD_FILE}.${this.recordId()}.tmp`);
    try {
      await writeFile(temporary, protectedBytes, { flag: 'wx', mode: 0o600 });
      await this.rejectLink(this.file, true);
      await renameWithWindowsRetry(temporary, this.file);
      check(await this.options.restrictAccess(this.root), 'access-denied');
      const reopened = await this.readRecord();
      check(reopened.recordId === recordId, 'write-verification');
      return this.publicStatus('ready', reopened.consent.acceptedAt);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof AstraMaxSettingsError) throw error;
      throw new AstraMaxSettingsError('write-failed');
    }
  }

  async resolveApiKey(): Promise<string> {
    return (await this.resolveConnection()).apiKey;
  }

  async resolveConnection(): Promise<Readonly<{ apiKey: string; consent: AstraMaxProviderConsentV1; modelId?: string }>> {
    check(this.encryptionAvailable(), 'encryption-unavailable');
    await this.prepareRoot(false);
    const record = await this.readRecord();
    return Object.freeze({ apiKey: record.apiKey, consent: structuredClone(record.consent), ...(record.modelId ? { modelId: record.modelId } : {}) });
  }

  private async prepareRoot(create: boolean): Promise<void> {
    try {
      if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') throw new AstraMaxSettingsError('not-configured');
        throw error;
      });
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'root-identity');
      const canonical = await realpath(this.root);
      check(samePath(canonical, this.root), 'root-identity');
      check(await this.options.restrictAccess(this.root), 'access-denied');
    } catch (error) {
      if (error instanceof AstraMaxSettingsError) throw error;
      throw new AstraMaxSettingsError('root-unavailable');
    }
  }

  private async readRecord(): Promise<{ schemaVersion: typeof RECORD_VERSION; recordId: string;
    providerId: MaxCloudProviderId; consent: AstraMaxProviderConsentV1; apiKey: string; modelId?: string }> {
    await this.rejectLink(this.file, false);
    const protectedBytes = await readFile(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new AstraMaxSettingsError('not-configured');
      throw new AstraMaxSettingsError('record-unavailable');
    });
    check(protectedBytes.byteLength > 0 && protectedBytes.byteLength <= MAX_PROTECTED_BYTES, 'record-corrupt');
    let value: unknown;
    try { value = JSON.parse(this.options.protectedStorage.decryptString(protectedBytes)); }
    catch { throw new AstraMaxSettingsError('record-corrupt'); }
    check(record(value)
      && value.schemaVersion === RECORD_VERSION
      && id(value.recordId)
      && value.providerId === (this.options.providerId ?? ASTRA_MAX_PROVIDER_ID)
      && validAstraMaxConsent(value.consent, this.currentTime(), this.options.providerId ?? 'groq')
      && (value.modelId === undefined || validCloudModel(value.modelId))
      && validKey(value.apiKey), 'record-corrupt');
    return structuredClone(value) as { schemaVersion: typeof RECORD_VERSION; recordId: string;
      providerId: MaxCloudProviderId; consent: AstraMaxProviderConsentV1; apiKey: string; modelId?: string };
  }

  private async rejectLink(filePath: string, missingAllowed: boolean): Promise<void> {
    const stat = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (missingAllowed && error.code === 'ENOENT') return null;
      if (!missingAllowed && error.code === 'ENOENT') throw new AstraMaxSettingsError('not-configured');
      throw new AstraMaxSettingsError('record-unavailable');
    });
    if (stat) check(stat.isFile() && !stat.isSymbolicLink(), 'record-identity');
  }

  private encryptionAvailable(): boolean {
    try { return this.options.protectedStorage?.isEncryptionAvailable?.() === true; }
    catch { return false; }
  }

  private currentTime(): number {
    const value = this.now();
    check(Number.isSafeInteger(value) && value >= 0, 'clock');
    return value;
  }

  private recordId(): string {
    const value = (this.options.randomId ?? randomUUID)();
    check(id(value), 'record-id');
    return value;
  }

  private publicStatus(state: AstraMaxSettingsStatus['state'], acceptedAt: string | null = null): AstraMaxSettingsStatus {
    return Object.freeze({ state, providerId: this.options.providerId ?? ASTRA_MAX_PROVIDER_ID,
      agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, acceptedAt });
  }
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{20,512}$/u.test(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new AstraMaxSettingsError(code);
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}

export const ASTRA_MAX_SETTINGS_RECORD = Object.freeze({ fileName: RECORD_FILE, schemaVersion: RECORD_VERSION });
