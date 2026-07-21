import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  EMERGENCY_DEFAULT_WORDS,
  EmergencyPhraseError,
  emergencyPhraseEntropyBits,
  generateEmergencyPhrase,
  normalizeEmergencyPhrase,
} from './emergency-phrase.mjs';
import {
  SAFE_SECURITY_POLICY_DEFAULTS,
  assessSafeSecurityPolicy,
  normalizeSafeSecurityPolicy,
} from './security-policy.mjs';

const scrypt = promisify(scryptCallback);
const CONFIG_VERSION = 2;
const MANIFEST_VERSION = 3;
const BLOB_MAGIC = Buffer.from('MSAFEB03', 'ascii');
const ARCHIVE_MAGIC = Buffer.from('MSAR01', 'ascii');
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_DESCRIPTOR_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_MANIFEST_ENVELOPE_BYTES = 16 * 1024 * 1024;
const MAX_CHAT_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 20_000;
const CHAT_RECORD_MIME = 'application/x-monarch-safe-chat+json';
const DEFAULT_AUTO_LOCK_MS = 5 * 60 * 1000;
const DEFAULT_PIN_KDF = Object.freeze({ N: 2 ** 18, r: 8, p: 1, maxmem: 320 * 1024 * 1024 });
const DEFAULT_RECOVERY_KDF = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 48 * 1024 * 1024 });
const TEST_PIN_KDF = Object.freeze({ N: 2 ** 10, r: 8, p: 1, maxmem: 4 * 1024 * 1024 });
const TEST_RECOVERY_KDF = Object.freeze({ N: 2 ** 9, r: 8, p: 1, maxmem: 4 * 1024 * 1024 });
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AUTO_LOCK_OPERATION = Symbol('monarchSafeAutoLockOperation');

export class SafeVaultError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SafeVaultError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class SafeVault {
  constructor(rootPath, options = {}) {
    if (!path.isAbsolute(rootPath)) {
      throw new SafeVaultError('invalid-root', 'Safe vault root must be an absolute path.');
    }
    this.rootPath = path.resolve(rootPath);
    this.blobRoot = path.join(this.rootPath, 'blobs');
    this.configPath = path.join(this.rootPath, 'config.safe.json');
    this.manifestPath = path.join(this.rootPath, 'manifest.safe');
    this.autoLockOverrideMs = Number.isSafeInteger(options.autoLockMs)
      ? clampInteger(options.autoLockMs, options.testKdf ? 10 : 30_000, 60 * 60 * 1000, DEFAULT_AUTO_LOCK_MS)
      : null;
    this.autoLockMs = this.autoLockOverrideMs ?? DEFAULT_AUTO_LOCK_MS;
    this.pinKdf = normalizeKdf(options.testKdf ? TEST_PIN_KDF : options.pinKdf || DEFAULT_PIN_KDF);
    this.recoveryKdf = normalizeKdf(options.testKdf ? TEST_RECOVERY_KDF : options.recoveryKdf || DEFAULT_RECOVERY_KDF);
    this.emergencyKdf = normalizeKdf(options.testKdf ? TEST_PIN_KDF : options.emergencyKdf || DEFAULT_PIN_KDF);
    this.deviceKey = normalizeDeviceKey(options.deviceKey);
    this.runtimeSessionId = typeof options.runtimeSessionId === 'string' && options.runtimeSessionId
      ? options.runtimeSessionId
      : randomUUID();
    this.onAutoLock = typeof options.onAutoLock === 'function' ? options.onAutoLock : null;
    this.config = null;
    this.configError = null;
    this.configSealStatus = 'none';
    this.manifest = null;
    this.masterKey = null;
    this.recoveryAttemptUsed = false;
    this.autoLockTimer = null;
    this.activeOperations = 0;
    this.beforeAtomicReplace = options.testKdf && typeof options.beforeAtomicReplace === 'function'
      ? options.beforeAtomicReplace
      : null;
  }

  async initialize() {
    await mkdir(this.blobRoot, { recursive: true, mode: 0o700 });
    try {
      this.config = await this.#loadConfig();
      this.configError = null;
    } catch (error) {
      if (!(error instanceof SafeVaultError) || !error.code.startsWith('vault-config-')) throw error;
      this.config = null;
      this.configError = error;
      this.configSealStatus = 'none';
    }
    this.autoLockMs = this.autoLockOverrideMs
      ?? normalizeSafeSecurityPolicy(this.config?.securityPolicy).autoLockMs;
    return this.status();
  }

  status() {
    const configured = this.config?.status === 'active';
    const provisioning = this.config?.status === 'pending';
    const wiped = this.config?.status === 'destroyed';
    const unlocked = Boolean(this.masterKey && this.manifest);
    const failures = configured ? clampInteger(this.config.attempts?.pinFailures, 0, 3, 0) : 0;
    const emergency = configured ? this.config.emergency : null;
    const emergencyConfigured = Boolean(emergency?.envelope);
    const emergencyRecoveryOffered = Boolean(
      emergencyConfigured
      && this.configSealStatus === 'valid'
      && failures === 2
      && emergency.windowEligible === true
      && emergency.attemptUsed !== true
    );
    const securityAssessment = assessSafeSecurityPolicy(this.config?.securityPolicy);
    return {
      configured,
      provisioning,
      wiped,
      setupAvailable: !this.configError && !configured && !provisioning,
      blocked: Boolean(this.configError),
      blockReason: this.configError?.code || null,
      pinIntegrity: configured ? this.configSealStatus : null,
      pinUnlockAvailable: configured && ['valid', 'legacy'].includes(this.configSealStatus),
      unlocked,
      pinLength: configured ? this.config.pinLength : null,
      attemptsRemaining: configured ? Math.max(0, 3 - failures) : 0,
      recoveryAttemptAvailable: configured && !this.recoveryAttemptUsed,
      recoveryKeysRemaining: configured
        ? this.config.recovery.filter((entry) => entry.used !== true).length
        : 0,
      emergencyConfigured,
      emergencyWordCount: emergencyConfigured ? emergency.wordCount : null,
      emergencyCleanSessions: emergencyConfigured ? clampInteger(emergency.cleanPinSessions, 0, 2, 0) : 0,
      emergencyArmed: emergencyConfigured && emergency.armed === true,
      emergencyRecoveryOffered,
      emergencyAttemptAvailable: emergencyRecoveryOffered,
      autoLockMs: this.autoLockMs,
      securityPolicy: securityAssessment.policy,
      securityLevel: securityAssessment.level,
      securityWarnings: securityAssessment.warnings,
      isolation: {
        externalPrograms: false,
        network: false,
        plaintextAtRest: false,
        processBoundary: true,
        deviceBoundPin: configured ? this.config.pin?.deviceBound === true : Boolean(this.deviceKey),
      },
    };
  }

  touch() {
    this.#requireUnlocked();
    return this.status();
  }

  async updateSecurityPolicy({ pin, policy, lowSecurityAcknowledged = false }) {
    this.#requireActiveConfig();
    if (this.configSealStatus === 'failed') {
      throw new SafeVaultError('vault-config-integrity-failed', 'Safe security settings cannot change because configuration integrity failed.');
    }
    validatePin(pin, this.config.pinLength);
    let key = null;
    try {
      key = await unwrapKey(this.config.pin, pin, `${this.config.vaultId}:pin`, this.deviceKey);
    } catch (error) {
      if (!(error instanceof SafeVaultError) || error.code !== 'invalid-credential') throw error;
      throw new SafeVaultError('invalid-pin', 'Текущий PIN отклонён. Настройки Safe не изменены.');
    } finally {
      key?.fill(0);
    }
    const assessment = assessSafeSecurityPolicy(policy);
    if (assessment.level === 'low' && lowSecurityAcknowledged !== true) {
      throw new SafeVaultError(
        'low-security-acknowledgement-required',
        'Нужно отдельно подтвердить ослабление защиты Monarch Safe.',
        { warnings: assessment.warnings },
      );
    }
    this.config.securityPolicy = assessment.policy;
    this.config.sequence += 1;
    this.config.updatedAt = new Date().toISOString();
    if (this.configSealStatus === 'legacy' && this.deviceKey) this.configSealStatus = 'valid';
    await this.#persistConfig();
    this.autoLockMs = this.autoLockOverrideMs ?? assessment.policy.autoLockMs;
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
    this.#armAutoLock();
    return this.status();
  }

  async setup({ pin, pinLength, emergencyWordCount = EMERGENCY_DEFAULT_WORDS, destructionConfirmed }) {
    if (this.configError) throw this.configError;
    if (this.config?.status === 'active' || this.config?.status === 'pending') {
      throw new SafeVaultError('already-configured', 'Monarch Safe is already configured.');
    }
    if (destructionConfirmed !== true) {
      throw new SafeVaultError('destruction-warning-required', 'Destructive lockout warning must be acknowledged.');
    }
    validatePin(pin, pinLength);
    if (!this.deviceKey) {
      throw new SafeVaultError('device-binding-unavailable', 'Protected device binding is required before Monarch Safe can be created.');
    }
    if (emergencyPhraseEntropyBits(emergencyWordCount) <= 0) {
      throw new SafeVaultError('invalid-emergency-phrase-word-count', 'Emergency phrase must contain 9 to 24 words.');
    }

    const nextSecuritySequence = clampInteger(this.config?.sequence, 0, Number.MAX_SAFE_INTEGER - 2, 0) + 1;
    await this.#removeVaultPayloads();
    const vaultId = randomUUID();
    const masterKey = randomBytes(32);
    const recoveryKeys = Array.from({ length: 3 }, () => generateRecoveryKey());
    const pinWrap = await wrapKey(masterKey, pin, this.pinKdf, `${vaultId}:pin`, this.deviceKey);
    const emergencyPhrase = generateEmergencyPhrase({ vaultId, wordCount: emergencyWordCount });
    const emergencyEnvelope = await wrapKey(
      masterKey,
      emergencyPhrase,
      this.emergencyKdf,
      `${vaultId}:emergency:v1`,
      this.deviceKey,
      'emergency:v1',
    );
    const recovery = [];
    for (let index = 0; index < recoveryKeys.length; index += 1) {
      const id = randomUUID();
      recovery.push({
        id,
        used: false,
        ...(await wrapKey(masterKey, recoveryKeys[index], this.recoveryKdf, `${vaultId}:recovery:${id}`)),
      });
    }

    const now = new Date().toISOString();
    this.config = {
      version: CONFIG_VERSION,
      sequence: nextSecuritySequence,
      vaultId,
      status: 'pending',
      pinLength,
      pin: pinWrap,
      recovery,
      emergency: {
        version: 1,
        wordCount: emergencyWordCount,
        entropyBits: emergencyPhraseEntropyBits(emergencyWordCount),
        envelope: emergencyEnvelope,
        cleanPinSessions: 0,
        lastCleanSessionId: null,
        armed: false,
        windowEligible: false,
        attemptUsed: false,
      },
      attempts: { pinFailures: 0 },
      securityPolicy: { ...SAFE_SECURITY_POLICY_DEFAULTS },
      createdAt: now,
      updatedAt: now,
    };
    this.configSealStatus = 'valid';
    this.masterKey = Buffer.from(masterKey);
    masterKey.fill(0);
    this.manifest = createEmptyManifest(now);
    await this.#persistManifest();
    await this.#persistConfig();
    this.recoveryAttemptUsed = false;
    this.#armAutoLock();
    return { ...this.status(), recoveryKeys, emergencyPhrase };
  }

  async completeSetup({ recoveryAcknowledged } = {}) {
    if (this.configError) throw this.configError;
    if (this.config?.status !== 'pending' || !this.masterKey || !this.manifest) {
      throw new SafeVaultError('setup-not-pending', 'Monarch Safe setup is not awaiting recovery-key acknowledgement.');
    }
    if (recoveryAcknowledged !== true) {
      throw new SafeVaultError('recovery-acknowledgement-required', 'Recovery keys must be saved before Monarch Safe can be activated.');
    }
    this.config.status = 'active';
    this.config.sequence += 1;
    this.config.updatedAt = new Date().toISOString();
    await this.#persistConfig();
    this.#armAutoLock();
    return this.status();
  }

  async resetProvisioning() {
    if (this.config?.status !== 'pending') {
      throw new SafeVaultError('setup-not-pending', 'There is no interrupted Safe setup to reset.');
    }
    this.lock();
    await this.#removeVaultPayloads();
    await secureRemove(this.configPath);
    await secureRemove(`${this.configPath}.previous`);
    await secureRemove(`${this.configPath}.next`);
    this.config = null;
    this.configError = null;
    this.configSealStatus = 'none';
    return this.status();
  }

  async unlockWithPin(pin) {
    this.#requireActiveConfig();
    if (this.configSealStatus === 'failed') {
      throw new SafeVaultError('vault-config-integrity-failed', 'PIN configuration integrity failed. Use a recovery key; PIN attempts were not changed.');
    }
    if (this.status().attemptsRemaining <= 0) throw new SafeVaultError('vault-wiped', 'Safe data has been erased. Create a new Safe.');
    validatePin(pin, this.config.pinLength);
    const failuresBefore = clampInteger(this.config.attempts?.pinFailures, 0, 3, 0);
    let key = null;
    try {
      key = await unwrapKey(this.config.pin, pin, `${this.config.vaultId}:pin`, this.deviceKey);
      await this.#unlockWithMasterKey(key);
    } catch (error) {
      if (key) key.fill(0);
      if (!(error instanceof SafeVaultError) || error.code !== 'invalid-credential') throw error;
      if (this.configSealStatus !== 'valid') {
        throw new SafeVaultError('vault-config-upgrade-required', 'Legacy PIN configuration could not be authenticated. Attempts were not changed; use the exact PIN or a recovery key.');
      }
      const failures = clampInteger(this.config.attempts?.pinFailures, 0, 3, 0) + 1;
      if (this.config.emergency && failures === 1) {
        this.config.emergency.windowEligible = this.config.emergency.armed === true
          && this.config.emergency.lastCleanSessionId !== this.runtimeSessionId;
        this.config.emergency.cleanPinSessions = 0;
        this.config.emergency.lastCleanSessionId = null;
        this.config.emergency.armed = false;
        this.config.emergency.attemptUsed = false;
      }
      this.config.attempts = { pinFailures: failures };
      this.config.sequence += 1;
      this.config.updatedAt = new Date().toISOString();
      if (failures >= 3) {
        await this.destroy('pin-attempt-limit');
        throw new SafeVaultError('vault-wiped', 'Three incorrect PIN attempts erased all data inside Safe. Create a new Safe with new credentials.');
      }
      await this.#persistConfig();
      throw new SafeVaultError('invalid-pin', 'Incorrect PIN.', { attemptsRemaining: 3 - failures });
    }
    key.fill(0);
    if (this.configSealStatus === 'legacy') this.configSealStatus = 'valid';
    if (this.config.emergency) {
      if (failuresBefore === 0) {
        if (this.config.emergency.lastCleanSessionId !== this.runtimeSessionId) {
          this.config.emergency.cleanPinSessions = Math.min(
            2,
            clampInteger(this.config.emergency.cleanPinSessions, 0, 2, 0) + 1,
          );
          this.config.emergency.lastCleanSessionId = this.runtimeSessionId;
        }
        this.config.emergency.armed = this.config.emergency.cleanPinSessions >= 2;
      } else {
        resetEmergencyTrust(this.config.emergency);
      }
      this.config.emergency.windowEligible = false;
      this.config.emergency.attemptUsed = false;
    }
    this.config.attempts = { pinFailures: 0 };
    this.config.sequence += 1;
    this.config.updatedAt = new Date().toISOString();
    await this.#persistConfig();
    return this.status();
  }

  async unlockWithRecoveryKey(value) {
    this.#requireActiveConfig();
    if (this.recoveryAttemptUsed) {
      throw new SafeVaultError('recovery-attempt-used', 'Recovery-key input is limited to one attempt per Safe runtime session.');
    }
    this.recoveryAttemptUsed = true;
    const recoveryKey = normalizeRecoveryKey(value);
    let matched = null;
    let masterKey = null;
    for (const entry of this.config.recovery) {
      if (entry.used === true) continue;
      try {
        masterKey = await unwrapKey(entry, recoveryKey, `${this.config.vaultId}:recovery:${entry.id}`);
        matched = entry;
        break;
      } catch (error) {
        if (!(error instanceof SafeVaultError) || error.code !== 'invalid-credential') throw error;
      }
    }
    if (!matched || !masterKey) {
      throw new SafeVaultError('invalid-recovery-key', 'Recovery key was rejected. Restart Safe to receive one new attempt.');
    }
    try {
      await this.#unlockWithMasterKey(masterKey);
    } finally {
      masterKey.fill(0);
    }
    matched.used = true;
    matched.ciphertext = '';
    matched.tag = '';
    matched.nonce = '';
    matched.salt = '';
    if (this.configSealStatus !== 'valid') this.configSealStatus = 'legacy';
    if (this.config.emergency) resetEmergencyTrust(this.config.emergency);
    this.config.attempts = { pinFailures: 0 };
    this.config.sequence += 1;
    this.config.updatedAt = new Date().toISOString();
    await this.#persistConfig();
    return this.status();
  }

  async unlockWithEmergencyPhrase(value) {
    this.#requireActiveConfig();
    const emergency = this.config.emergency;
    if (!emergency?.envelope) {
      throw new SafeVaultError('emergency-recovery-unavailable', 'This Safe has no emergency phrase configured.');
    }
    if (this.configSealStatus !== 'valid') {
      throw new SafeVaultError('vault-config-integrity-failed', 'Emergency recovery requires an intact device-sealed configuration.');
    }
    if (emergency.attemptUsed === true) {
      throw new SafeVaultError('emergency-attempt-used', 'The single emergency-phrase attempt for this lockout window has already been used.');
    }
    if (!this.status().emergencyRecoveryOffered) {
      throw new SafeVaultError('emergency-recovery-not-eligible', 'Emergency recovery is available only after two prior clean PIN sessions and two current PIN errors.');
    }

    emergency.attemptUsed = true;
    this.config.sequence += 1;
    this.config.updatedAt = new Date().toISOString();
    await this.#persistConfig();

    let normalized = '';
    let masterKey = null;
    try {
      normalized = normalizeEmergencyPhrase(value, {
        vaultId: this.config.vaultId,
        wordCount: emergency.wordCount,
      });
      masterKey = await unwrapKey(
        emergency.envelope,
        normalized,
        `${this.config.vaultId}:emergency:v1`,
        this.deviceKey,
        'emergency:v1',
      );
      await this.#unlockWithMasterKey(masterKey);
    } catch (error) {
      if (this.masterKey) this.lock();
      if (error instanceof EmergencyPhraseError || (error instanceof SafeVaultError && error.code === 'invalid-credential')) {
        throw new SafeVaultError('invalid-emergency-phrase', 'Emergency phrase was rejected. The final PIN attempt remains available.');
      }
      throw error;
    } finally {
      normalized = '';
      masterKey?.fill(0);
    }

    resetEmergencyTrust(emergency);
    this.config.attempts = { pinFailures: 0 };
    this.config.sequence += 1;
    this.config.updatedAt = new Date().toISOString();
    try {
      await this.#persistConfig();
    } catch (error) {
      this.lock();
      throw error;
    }
    return this.status();
  }

  lock() {
    if (this.masterKey) this.masterKey.fill(0);
    this.masterKey = null;
    this.manifest = null;
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
    return this.status();
  }

  async destroy(reason = 'explicit-destruction') {
    if (this.masterKey) this.masterKey.fill(0);
    this.masterKey = null;
    this.manifest = null;
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;

    const previous = this.config;
    const now = new Date().toISOString();
    this.config = {
      version: CONFIG_VERSION,
      sequence: (previous?.sequence || 0) + 1,
      vaultId: previous?.vaultId || randomUUID(),
      status: 'destroyed',
      pinLength: previous?.pinLength || null,
      pin: null,
      recovery: [],
      emergency: null,
      attempts: { pinFailures: 3 },
      destructionReason: reason,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    await this.#persistConfig();
    await this.#removeVaultPayloads();
    await secureRemove(`${this.configPath}.previous`);
    await secureRemove(`${this.configPath}.next`);
    return this.status();
  }

  list() {
    this.#requireUnlocked();
    this.#armAutoLock();
    return publicManifest(this.manifest);
  }

  listChats() {
    this.#requireUnlocked();
    this.#armAutoLock();
    return this.manifest.files
      .filter((file) => isChatRecordFile(file))
      .map((file) => publicChatRecord(file))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readChat({ id, kind = 'oscar' }) {
    this.#requireUnlocked();
    const file = this.#requireChatRecord(id, kind);
    const bytes = await this.#readEncryptedBlob(file);
    try {
      const record = normalizeSafeChatRecord(JSON.parse(bytes.toString('utf8')));
      if (record.id !== file.chatId || record.kind !== file.chatKind) {
        throw new SafeVaultError('chat-integrity-failed', 'Encrypted chat identity does not match authenticated metadata.');
      }
      this.#armAutoLock();
      return { chat: publicChatRecord(file), record };
    } catch (error) {
      if (error instanceof SafeVaultError) throw error;
      throw new SafeVaultError('chat-integrity-failed', 'Encrypted chat payload failed validation.');
    } finally {
      bytes.fill(0);
    }
  }

  async upsertChat({ record }) {
    this.#requireUnlocked();
    const normalized = normalizeSafeChatRecord(record);
    const content = Buffer.from(JSON.stringify(normalized), 'utf8');
    if (content.byteLength > MAX_CHAT_RECORD_BYTES) {
      content.fill(0);
      throw new SafeVaultError('chat-too-large', `Encrypted chats are limited to ${MAX_CHAT_RECORD_BYTES} bytes.`);
    }
    const existingIndex = this.manifest.files.findIndex(
      (file) => isChatRecordFile(file) && file.chatId === normalized.id && file.chatKind === normalized.kind,
    );
    const existing = existingIndex >= 0 ? this.manifest.files[existingIndex] : null;
    const now = new Date().toISOString();
    const fileKey = randomBytes(32);
    const fileId = existing?.id || randomUUID();
    const nextFile = {
      id: fileId,
      blobId: randomUUID(),
      sectionId: existing?.sectionId || this.manifest.sections[0]?.id,
      folderId: null,
      name: `Monarch chat ${normalized.id}.mchat`,
      mime: CHAT_RECORD_MIME,
      size: content.byteLength,
      source: 'created',
      hidden: true,
      application: 'monarch-chat',
      chatId: normalized.id,
      chatKind: normalized.kind,
      chatTitle: normalized.title,
      chatPreview: chatRecordPreview(normalized),
      chatMessageCount: normalized.messages.length,
      keyEnvelope: this.#wrapFileKey(fileId, fileKey),
      createdAt: existing?.createdAt || normalized.createdAt || now,
      updatedAt: normalized.updatedAt || now,
    };
    if (!nextFile.sectionId) {
      content.fill(0);
      fileKey.fill(0);
      throw new SafeVaultError('invalid-manifest', 'Safe has no authenticated section for chat storage.');
    }
    const checksum = createHash('sha256').update(content).digest('hex');
    let verified = null;
    try {
      await this.#writeEncryptedBlob(nextFile, content, fileKey);
      verified = await this.#readEncryptedBlob(nextFile);
      const verifiedChecksum = createHash('sha256').update(verified).digest('hex');
      if (verifiedChecksum !== checksum) {
        throw new SafeVaultError('chat-integrity-failed', 'Encrypted chat verification checksum does not match.');
      }
      const verifiedRecord = normalizeSafeChatRecord(JSON.parse(verified.toString('utf8')));
      if (verifiedRecord.id !== normalized.id || verifiedRecord.kind !== normalized.kind) {
        throw new SafeVaultError('chat-integrity-failed', 'Encrypted chat verification returned another record.');
      }

      if (existingIndex >= 0) this.manifest.files[existingIndex] = nextFile;
      else this.manifest.files.push(nextFile);
      try {
        await this.#persistManifest();
      } catch (error) {
        if (existingIndex >= 0) this.manifest.files[existingIndex] = existing;
        else this.manifest.files = this.manifest.files.filter((file) => file.id !== nextFile.id);
        await secureRemove(this.#blobPath(nextFile));
        throw error;
      }
      if (existing) await secureRemove(this.#blobPath(existing));
      return { chat: publicChatRecord(nextFile), checksum, verified: true };
    } catch (error) {
      if (existingIndex < 0 || this.manifest.files[existingIndex]?.blobId !== nextFile.blobId) {
        await secureRemove(this.#blobPath(nextFile));
      }
      if (error instanceof SafeVaultError) throw error;
      throw new SafeVaultError('chat-integrity-failed', 'Encrypted chat could not be committed safely.');
    } finally {
      content.fill(0);
      fileKey.fill(0);
      verified?.fill(0);
    }
  }

  async deleteChat({ id, kind = 'oscar' }) {
    this.#requireUnlocked();
    const file = this.#requireChatRecord(id, kind);
    const index = this.manifest.files.findIndex((entry) => entry.id === file.id);
    this.manifest.files.splice(index, 1);
    try {
      await this.#persistManifest();
    } catch (error) {
      this.manifest.files.splice(index, 0, file);
      throw error;
    }
    await secureRemove(this.#blobPath(file));
    return { deleted: true, chat: publicChatRecord(file) };
  }

  async createSection({ name, color }) {
    this.#requireUnlocked();
    const now = new Date().toISOString();
    const section = { id: randomUUID(), name: normalizeName(name), color: normalizeColor(color), createdAt: now, updatedAt: now };
    this.manifest.sections.push(section);
    await this.#persistManifest();
    return structuredClone(section);
  }

  async updateSection({ id, name, color }) {
    this.#requireUnlocked();
    const section = this.manifest.sections.find((entry) => entry.id === id);
    if (!section) throw new SafeVaultError('section-not-found', 'Safe section was not found.');
    if (name !== undefined) section.name = normalizeName(name);
    if (color !== undefined) section.color = normalizeColor(color);
    section.updatedAt = new Date().toISOString();
    await this.#persistManifest();
    return structuredClone(section);
  }

  async deleteSection({ id }) {
    this.#requireUnlocked();
    const section = this.#requireSection(id);
    if (this.manifest.sections.length <= 1) {
      throw new SafeVaultError('last-section-required', 'Safe должен содержать хотя бы один раздел.');
    }
    if (this.manifest.folders.some((entry) => entry.sectionId === id)
      || this.manifest.files.some((entry) => entry.sectionId === id)) {
      throw new SafeVaultError('section-not-empty', 'Сначала перемести или удали файлы и папки из этого раздела.');
    }
    this.manifest.sections = this.manifest.sections.filter((entry) => entry.id !== id);
    await this.#persistManifest();
    return { deleted: true, section: structuredClone(section) };
  }

  async createFolder({ name, sectionId }) {
    this.#requireUnlocked();
    this.#requireSection(sectionId);
    const now = new Date().toISOString();
    const folder = { id: randomUUID(), sectionId, name: normalizeName(name), createdAt: now, updatedAt: now };
    this.manifest.folders.push(folder);
    await this.#persistManifest();
    return structuredClone(folder);
  }

  async updateFolder({ id, name }) {
    this.#requireUnlocked();
    const folder = this.manifest.folders.find((entry) => entry.id === id);
    if (!folder) throw new SafeVaultError('folder-not-found', 'Safe folder was not found.');
    folder.name = normalizeName(name);
    folder.updatedAt = new Date().toISOString();
    await this.#persistManifest();
    return structuredClone(folder);
  }

  async deleteFolder({ id }) {
    this.#requireUnlocked();
    const folder = this.manifest.folders.find((entry) => entry.id === id);
    if (!folder) throw new SafeVaultError('folder-not-found', 'Safe folder was not found.');
    if (this.manifest.files.some((entry) => entry.folderId === id)) {
      throw new SafeVaultError('folder-not-empty', 'Move or delete files before deleting this folder.');
    }
    this.manifest.folders = this.manifest.folders.filter((entry) => entry.id !== id);
    await this.#persistManifest();
    return { deleted: true, id };
  }

  async createFile({ name, mime = 'text/plain', text = '', sectionId, folderId = null }) {
    return this.importFile({
      name,
      mime,
      bytes: Buffer.from(String(text), 'utf8'),
      sectionId,
      folderId,
      source: 'created',
    });
  }

  async importFile({ name, mime = 'application/octet-stream', bytes, sectionId, folderId = null, source = 'imported' }) {
    this.#requireUnlocked();
    this.#requireSection(sectionId);
    this.#requireFolder(folderId, sectionId);
    const content = normalizeBytes(bytes);
    if (content.byteLength > MAX_FILE_BYTES) {
      throw new SafeVaultError('file-too-large', `Safe currently accepts files up to ${MAX_FILE_BYTES} bytes per isolated operation.`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const fileKey = randomBytes(32);
    const file = {
      id,
      blobId: randomUUID(),
      sectionId,
      folderId,
      name: normalizeName(name),
      mime: normalizeMime(mime),
      size: content.byteLength,
      source: source === 'created' ? 'created' : source === 'archive' ? 'archive' : 'imported',
      keyEnvelope: this.#wrapFileKey(id, fileKey),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#writeEncryptedBlob(file, content, fileKey);
      this.manifest.files.push(file);
      try {
        await this.#persistManifest();
      } catch (error) {
        this.manifest.files = this.manifest.files.filter((entry) => entry.id !== file.id);
        await secureRemove(this.#blobPath(file));
        throw error;
      }
      return publicFile(file);
    } finally {
      content.fill(0);
      fileKey.fill(0);
    }
  }

  async readFile({ id }) {
    this.#requireUnlocked();
    const file = this.#requireFile(id);
    const bytes = await this.#readEncryptedBlob(file);
    this.#armAutoLock();
    const transferable = new Uint8Array(bytes);
    bytes.fill(0);
    return { file: publicFile(file), bytes: transferable };
  }

  async writeFile({ id, bytes, text, mime }) {
    this.#requireUnlocked();
    const file = this.#requireFile(id);
    const fileIndex = this.manifest.files.findIndex((entry) => entry.id === id);
    const content = bytes === undefined ? Buffer.from(String(text ?? ''), 'utf8') : normalizeBytes(bytes);
    if (content.byteLength > MAX_FILE_BYTES) throw new SafeVaultError('file-too-large', 'Edited file exceeds the Safe operation limit.');
    const fileKey = randomBytes(32);
    const nextFile = {
      ...file,
      blobId: randomUUID(),
      mime: mime === undefined ? file.mime : normalizeMime(mime),
      size: content.byteLength,
      updatedAt: new Date().toISOString(),
    };
    nextFile.keyEnvelope = this.#wrapFileKey(nextFile.id, fileKey);
    try {
      await this.#writeEncryptedBlob(nextFile, content, fileKey);
      this.manifest.files[fileIndex] = nextFile;
      try {
        await this.#persistManifest();
      } catch (error) {
        this.manifest.files[fileIndex] = file;
        await secureRemove(this.#blobPath(nextFile));
        throw error;
      }
      await secureRemove(this.#blobPath(file));
      return publicFile(nextFile);
    } finally {
      content.fill(0);
      fileKey.fill(0);
    }
  }

  async deleteFile({ id }) {
    this.#requireUnlocked();
    const file = this.#requireFile(id);
    const fileIndex = this.manifest.files.findIndex((entry) => entry.id === id);
    this.manifest.files.splice(fileIndex, 1);
    try {
      await this.#persistManifest();
    } catch (error) {
      this.manifest.files.splice(fileIndex, 0, file);
      throw error;
    }
    await secureRemove(this.#blobPath(file));
    return { deleted: true, file: publicFile(file) };
  }

  async createArchive({ fileIds, name, sectionId, folderId = null }) {
    this.#requireUnlocked();
    this.#requireSection(sectionId);
    this.#requireFolder(folderId, sectionId);
    const ids = Array.isArray(fileIds) ? [...new Set(fileIds.filter((entry) => typeof entry === 'string'))] : [];
    if (!ids.length || ids.length > MAX_ARCHIVE_ENTRIES) {
      throw new SafeVaultError('invalid-archive-selection', 'Select between 1 and 10,000 files.');
    }
    const descriptors = [];
    const contents = [];
    let offset = 0;
    for (const id of ids) {
      const file = this.#requireFile(id);
      const content = await this.#readEncryptedBlob(file);
      if (offset + content.byteLength > MAX_ARCHIVE_OUTPUT_BYTES) {
        contents.forEach((entry) => entry.fill(0));
        content.fill(0);
        throw new SafeVaultError('archive-too-large', 'Archive plaintext exceeds the isolated archive limit.');
      }
      descriptors.push({ name: file.name, mime: file.mime, size: content.byteLength, offset });
      contents.push(content);
      offset += content.byteLength;
    }
    const descriptorBytes = Buffer.from(JSON.stringify(descriptors), 'utf8');
    if (descriptorBytes.byteLength > MAX_ARCHIVE_DESCRIPTOR_BYTES || ARCHIVE_MAGIC.length + 4 + descriptorBytes.byteLength + offset > MAX_ARCHIVE_OUTPUT_BYTES) {
      contents.forEach((entry) => entry.fill(0));
      descriptorBytes.fill(0);
      throw new SafeVaultError('archive-too-large', 'Archive descriptor or total plaintext exceeds the isolated archive limit.');
    }
    const header = Buffer.alloc(ARCHIVE_MAGIC.length + 4);
    ARCHIVE_MAGIC.copy(header, 0);
    header.writeUInt32BE(descriptorBytes.byteLength, ARCHIVE_MAGIC.length);
    const plainArchive = Buffer.concat([header, descriptorBytes, ...contents]);
    contents.forEach((entry) => entry.fill(0));
    const compressed = gzipSync(plainArchive, { level: 9 });
    plainArchive.fill(0);
    try {
      return await this.importFile({
        name: ensureArchiveExtension(name),
        mime: 'application/x-monarch-safe-archive',
        bytes: compressed,
        sectionId,
        folderId,
        source: 'archive',
      });
    } finally {
      compressed.fill(0);
    }
  }

  async extractArchive({ id, sectionId, folderId = null }) {
    this.#requireUnlocked();
    this.#requireSection(sectionId);
    this.#requireFolder(folderId, sectionId);
    const archiveFile = this.#requireFile(id);
    if (archiveFile.mime !== 'application/x-monarch-safe-archive') {
      throw new SafeVaultError('unsupported-archive', 'Only the authenticated Monarch Safe archive format can be extracted internally.');
    }
    const compressed = await this.#readEncryptedBlob(archiveFile);
    let plain = null;
    try {
      plain = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_OUTPUT_BYTES });
      const entries = parseArchive(plain);
      const created = [];
      for (const entry of entries) {
        const start = entry.offset;
        const end = start + entry.size;
        created.push(await this.importFile({
          name: entry.name,
          mime: entry.mime,
          bytes: plain.subarray(start, end),
          sectionId,
          folderId,
          source: 'archive',
        }));
      }
      return { created };
    } catch (error) {
      if (error instanceof SafeVaultError) throw error;
      throw new SafeVaultError('invalid-archive', 'Archive authentication or bounded extraction validation failed.');
    } finally {
      compressed.fill(0);
      if (plain) plain.fill(0);
    }
  }

  async #unlockWithMasterKey(key) {
    const manifest = await this.#readManifest(key);
    if (this.masterKey) this.masterKey.fill(0);
    this.masterKey = Buffer.from(key);
    this.manifest = manifest;
    await this.#cleanupOrphanedBlobs();
    this.#armAutoLock();
  }

  async #loadConfig() {
    const candidates = [];
    let sawConfigArtifact = false;
    for (const candidatePath of [this.configPath, `${this.configPath}.previous`, `${this.configPath}.next`]) {
      try {
        const raw = (await readBoundedFile(candidatePath, MAX_CONFIG_BYTES, 'vault-config-too-large')).toString('utf8');
        sawConfigArtifact = true;
        const value = JSON.parse(raw);
        validateConfig(value);
        candidates.push({ path: candidatePath, value, sealStatus: verifyConfigSeal(value, this.deviceKey) });
      } catch (error) {
        if (error?.code !== 'ENOENT') sawConfigArtifact = true;
        // A valid sibling candidate may still recover an interrupted atomic replace.
      }
    }
    if (!candidates.length) {
      if (sawConfigArtifact) {
        throw new SafeVaultError('vault-config-invalid', 'Safe configuration artifacts exist but none passed validation. Existing payloads were preserved.');
      }
      if (await this.#hasVaultPayloadArtifacts()) {
        throw new SafeVaultError('vault-config-missing', 'Encrypted Safe payloads exist without recoverable configuration. Existing payloads were preserved.');
      }
      return null;
    }
    candidates.sort((left, right) => compareSecuritySequence(right.value, left.value) || sealRank(right.sealStatus) - sealRank(left.sealStatus));
    const selected = candidates[0];
    this.configSealStatus = selected.sealStatus;
    if (selected.path !== this.configPath) {
      await this.#atomicReplace(this.configPath, Buffer.from(JSON.stringify(selected.value, null, 2), 'utf8'));
    }
    await secureRemove(`${this.configPath}.previous`);
    await secureRemove(`${this.configPath}.next`);
    return selected.value;
  }

  async #hasVaultPayloadArtifacts() {
    for (const candidatePath of [this.manifestPath, `${this.manifestPath}.previous`, `${this.manifestPath}.next`]) {
      try { await stat(candidatePath); return true; } catch (error) { if (error?.code !== 'ENOENT') return true; }
    }
    try {
      return (await readdir(this.blobRoot, { withFileTypes: true })).some((entry) => entry.isFile());
    } catch (error) {
      return error?.code !== 'ENOENT';
    }
  }

  async #persistConfig() {
    if (this.configSealStatus === 'valid' && this.deviceKey) {
      this.config.deviceSeal = computeConfigSeal(this.config, this.deviceKey);
    } else if (this.configSealStatus === 'legacy' || this.configSealStatus === 'unavailable') {
      delete this.config.deviceSeal;
    }
    validateConfig(this.config);
    const encoded = Buffer.from(JSON.stringify(this.config, null, 2), 'utf8');
    try {
      await this.#atomicReplace(this.configPath, encoded);
    } finally {
      encoded.fill(0);
    }
  }

  async #persistManifest() {
    if (!['active', 'pending'].includes(this.config?.status) || !this.masterKey || !this.manifest) {
      throw new SafeVaultError('vault-locked', 'Monarch Safe key material is unavailable.');
    }
    const persisted = structuredClone(this.manifest);
    persisted.sequence = clampInteger(this.manifest.sequence, 0, Number.MAX_SAFE_INTEGER - 1, 0) + 1;
    persisted.updatedAt = new Date().toISOString();
    validateManifest(persisted);
    let payload = null;
    let manifestKey = null;
    let envelope = null;
    let encoded = null;
    try {
      payload = Buffer.from(JSON.stringify(persisted), 'utf8');
      manifestKey = deriveSubkey(this.masterKey, this.config.vaultId, 'manifest-v1');
      envelope = encryptAead(manifestKey, payload, Buffer.from(`monarch-safe:manifest:v1:${this.config.vaultId}`, 'utf8'));
      encoded = Buffer.from(JSON.stringify(envelope), 'utf8');
      await this.#atomicReplace(this.manifestPath, encoded);
      this.manifest.sequence = persisted.sequence;
      this.manifest.updatedAt = persisted.updatedAt;
    } finally {
      payload?.fill(0);
      manifestKey?.fill(0);
      encoded?.fill(0);
      if (envelope) {
        envelope.ciphertext = '';
        envelope.nonce = '';
        envelope.tag = '';
      }
    }
    this.#armAutoLock();
  }

  async #readManifest(masterKey) {
    const candidates = [];
    const candidatePaths = [this.manifestPath, `${this.manifestPath}.previous`, `${this.manifestPath}.next`];
    for (const candidatePath of candidatePaths) {
      let raw = null;
      let payload = null;
      let manifestKey = null;
      try {
        raw = await readBoundedFile(candidatePath, MAX_MANIFEST_ENVELOPE_BYTES, 'vault-integrity-failed');
        const envelope = JSON.parse(raw.toString('utf8'));
        manifestKey = deriveSubkey(masterKey, this.config.vaultId, 'manifest-v1');
        payload = decryptAead(manifestKey, envelope, Buffer.from(`monarch-safe:manifest:v1:${this.config.vaultId}`, 'utf8'));
        const manifest = JSON.parse(payload.toString('utf8'));
        validateManifest(manifest);
        candidates.push({ path: candidatePath, raw, manifest });
        raw = null;
      } catch {
        // A valid authenticated sibling can recover an interrupted manifest commit.
      } finally {
        raw?.fill(0);
        payload?.fill(0);
        manifestKey?.fill(0);
      }
    }
    if (!candidates.length) {
      throw new SafeVaultError('vault-integrity-failed', 'Encrypted Safe manifest failed authentication.');
    }
    candidates.sort((left, right) => right.manifest.sequence - left.manifest.sequence || candidatePaths.indexOf(left.path) - candidatePaths.indexOf(right.path));
    const selected = candidates[0];
    try {
      if (selected.path !== this.manifestPath) await this.#atomicReplace(this.manifestPath, selected.raw);
      await secureRemove(`${this.manifestPath}.previous`);
      await secureRemove(`${this.manifestPath}.next`);
      return selected.manifest;
    } finally {
      candidates.forEach((candidate) => candidate.raw.fill(0));
    }
  }

  #wrapFileKey(fileId, fileKey) {
    const wrappingKey = deriveSubkey(this.masterKey, fileId, 'file-key-wrap-v1');
    try {
      return encryptAead(wrappingKey, fileKey, Buffer.from(`monarch-safe:file-key:v1:${this.config.vaultId}:${fileId}`, 'utf8'));
    } finally {
      wrappingKey.fill(0);
    }
  }

  #unwrapFileKey(file) {
    const wrappingKey = deriveSubkey(this.masterKey, file.id, 'file-key-wrap-v1');
    try {
      const key = decryptAead(
        wrappingKey,
        file.keyEnvelope,
        Buffer.from(`monarch-safe:file-key:v1:${this.config.vaultId}:${file.id}`, 'utf8'),
      );
      if (key.byteLength === 32) return key;
      key.fill(0);
      throw new Error('invalid file key length');
    } catch {
      throw new SafeVaultError('file-integrity-failed', 'Encrypted file key failed authentication.');
    } finally {
      wrappingKey.fill(0);
    }
  }

  async #writeEncryptedBlob(file, content, fileKey) {
    const aad = Buffer.from(`monarch-safe:file:v3:${this.config.vaultId}:${file.id}:${file.blobId}`, 'utf8');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', fileKey, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    let ciphertext = null;
    let payload = null;
    try {
      ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
      const tag = cipher.getAuthTag();
      payload = Buffer.concat([BLOB_MAGIC, nonce, tag, ciphertext]);
      await this.#atomicReplace(this.#blobPath(file), payload);
    } finally {
      if (ciphertext) ciphertext.fill(0);
      if (payload) payload.fill(0);
    }
  }

  async #readEncryptedBlob(file) {
    let payload = null;
    let key = null;
    try {
      const expectedBytes = BLOB_MAGIC.length + 12 + 16 + file.size;
      payload = await readBoundedFile(this.#blobPath(file), expectedBytes, 'file-integrity-failed');
      if (payload.byteLength !== expectedBytes || !payload.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
        throw new SafeVaultError('file-integrity-failed', 'Encrypted file header is invalid.');
      }
      const nonceOffset = BLOB_MAGIC.length;
      const tagOffset = nonceOffset + 12;
      const bodyOffset = tagOffset + 16;
      key = this.#unwrapFileKey(file);
      const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(nonceOffset, tagOffset), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`monarch-safe:file:v3:${this.config.vaultId}:${file.id}:${file.blobId}`, 'utf8'));
      decipher.setAuthTag(payload.subarray(tagOffset, bodyOffset));
      const plain = Buffer.concat([decipher.update(payload.subarray(bodyOffset)), decipher.final()]);
      if (plain.byteLength !== file.size) {
        plain.fill(0);
        throw new SafeVaultError('file-integrity-failed', 'Encrypted file length does not match authenticated metadata.');
      }
      return plain;
    } catch (error) {
      if (error instanceof SafeVaultError) throw error;
      throw new SafeVaultError('file-integrity-failed', 'Encrypted file failed authentication.');
    } finally {
      if (payload) payload.fill(0);
      if (key) key.fill(0);
    }
  }

  async #atomicReplace(targetPath, bytes) {
    await this.beforeAtomicReplace?.(targetPath);
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const nextPath = `${targetPath}.next`;
    const previousPath = `${targetPath}.previous`;
    await secureRemove(nextPath);
    const handle = await open(nextPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await secureRemove(previousPath);
    try {
      await rename(targetPath, previousPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await rename(nextPath, targetPath);
    } catch (error) {
      try { await rename(previousPath, targetPath); } catch { /* recovery remains best effort */ }
      throw error;
    }
    await secureRemove(previousPath);
  }

  async #removeVaultPayloads() {
    await secureRemove(this.manifestPath);
    await secureRemove(`${this.manifestPath}.previous`);
    await secureRemove(`${this.manifestPath}.next`);
    try {
      const entries = await readdir(this.blobRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) await secureRemove(path.join(this.blobRoot, entry.name));
      }
    } catch {
      // A missing blob directory is equivalent to an empty vault.
    }
  }

  #blobPath(file) {
    if (!/^[0-9a-f-]{36}$/i.test(file?.id) || !/^[0-9a-f-]{36}$/i.test(file?.blobId)) {
      throw new SafeVaultError('invalid-file-id', 'Invalid Safe file generation identifier.');
    }
    return path.join(this.blobRoot, `${file.id}.${file.blobId}.blob`);
  }

  async #cleanupOrphanedBlobs() {
    const active = new Set(this.manifest.files.map((file) => path.basename(this.#blobPath(file))));
    try {
      const entries = await readdir(this.blobRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || active.has(entry.name)) continue;
        if (/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.blob(?:\.(?:next|previous))?$/i.test(entry.name)) {
          await secureRemove(path.join(this.blobRoot, entry.name));
        }
      }
    } catch {
      // Orphan cleanup is best effort and must never prevent access to authenticated active generations.
    }
  }

  #requireActiveConfig() {
    if (this.configError) throw this.configError;
    if (this.config?.status === 'destroyed') {
      throw new SafeVaultError('not-configured', 'Safe data has been erased. Create a new Safe with new credentials.', { wiped: true });
    }
    if (this.config?.status !== 'active') throw new SafeVaultError('not-configured', 'Monarch Safe is not configured.');
  }

  #requireUnlocked() {
    this.#requireActiveConfig();
    if (!this.masterKey || !this.manifest) throw new SafeVaultError('vault-locked', 'Monarch Safe is locked.');
  }

  #requireSection(id) {
    if (!this.manifest.sections.some((entry) => entry.id === id)) {
      throw new SafeVaultError('section-not-found', 'Safe section was not found.');
    }
  }

  #requireFolder(id, sectionId) {
    if (id === null || id === undefined || id === '') return;
    const folder = this.manifest.folders.find((entry) => entry.id === id);
    if (!folder || folder.sectionId !== sectionId) throw new SafeVaultError('folder-not-found', 'Safe folder was not found in this section.');
  }

  #requireFile(id) {
    const file = this.manifest.files.find((entry) => entry.id === id);
    if (!file) throw new SafeVaultError('file-not-found', 'Safe file was not found.');
    return file;
  }

  #requireChatRecord(id, kind) {
    const chatId = normalizeChatId(id);
    const chatKind = normalizeChatKind(kind);
    const file = this.manifest.files.find(
      (entry) => isChatRecordFile(entry) && entry.chatId === chatId && entry.chatKind === chatKind,
    );
    if (!file) throw new SafeVaultError('chat-not-found', 'Encrypted chat was not found in Monarch Safe.');
    return file;
  }

  #armAutoLock() {
    if (!this.masterKey) return;
    if (this.activeOperations > 0) return;
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
    if (this.autoLockMs === 0) return;
    this.autoLockTimer = setTimeout(() => {
      this.autoLockTimer = null;
      if (this.activeOperations > 0) return;
      const status = this.lock();
      try { this.onAutoLock?.(status); } catch { /* lock state must not depend on observers */ }
    }, this.autoLockMs);
    this.autoLockTimer.unref?.();
  }

  async [AUTO_LOCK_OPERATION](operation) {
    this.activeOperations += 1;
    if (this.activeOperations === 1 && this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
    try {
      return await operation();
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
      if (this.activeOperations === 0 && this.masterKey) this.#armAutoLock();
    }
  }
}

for (const methodName of [
  'initialize', 'setup', 'completeSetup', 'resetProvisioning', 'unlockWithPin', 'unlockWithRecoveryKey',
  'unlockWithEmergencyPhrase',
  'destroy', 'updateSecurityPolicy', 'createSection', 'updateSection', 'deleteSection',
  'createFolder', 'updateFolder', 'deleteFolder', 'createFile', 'importFile',
  'readFile', 'writeFile', 'deleteFile', 'createArchive', 'extractArchive',
  'readChat', 'upsertChat', 'deleteChat', 'touch',
]) {
  const operation = SafeVault.prototype[methodName];
  Object.defineProperty(SafeVault.prototype, methodName, {
    configurable: true,
    writable: true,
    async value(...args) {
      return this[AUTO_LOCK_OPERATION](() => operation.apply(this, args));
    },
  });
}

async function wrapKey(masterKey, secret, kdf, context, deviceKey = null, deviceDomain = 'pin:v2') {
  const salt = randomBytes(16);
  const derived = await deriveCredentialKey(secret, salt, kdf, deviceKey, deviceDomain);
  try {
    return {
      kdf: { name: 'scrypt', ...kdf },
      deviceBound: Boolean(deviceKey),
      salt: salt.toString('base64'),
      ...encryptAead(derived, masterKey, Buffer.from(context, 'utf8')),
    };
  } finally {
    derived.fill(0);
  }
}

async function unwrapKey(envelope, secret, context, deviceKey = null, deviceDomain = 'pin:v2') {
  if (envelope?.deviceBound === true && !deviceKey) {
    throw new SafeVaultError('device-binding-unavailable', 'This PIN requires the protected device binding. Use a recovery key if the binding is unavailable.');
  }
  const salt = readBase64(envelope.salt, 16, 'invalid-key-envelope');
  const derived = await deriveCredentialKey(
    secret,
    salt,
    normalizeKdf(envelope.kdf),
    envelope?.deviceBound === true ? deviceKey : null,
    deviceDomain,
  );
  try {
    const plain = decryptAead(derived, envelope, Buffer.from(context, 'utf8'));
    if (plain.byteLength !== 32) {
      plain.fill(0);
      throw new SafeVaultError('invalid-credential', 'Credential authentication failed.');
    }
    return plain;
  } catch {
    throw new SafeVaultError('invalid-credential', 'Credential authentication failed.');
  } finally {
    derived.fill(0);
  }
}

async function deriveCredentialKey(secret, salt, kdf, deviceKey = null, deviceDomain = 'pin:v2') {
  const normalized = String(secret).normalize('NFKC');
  const secretBytes = Buffer.from(normalized, 'utf8');
  const material = deviceKey
    ? createHmac('sha256', deviceKey).update(`monarch-safe:${deviceDomain}\0`, 'utf8').update(secretBytes).digest()
    : Buffer.from(secretBytes);
  secretBytes.fill(0);
  try {
    const result = await scrypt(material, salt, 32, kdf);
    return Buffer.from(result);
  } finally {
    material.fill(0);
  }
}

function deriveSubkey(masterKey, saltText, info) {
  return Buffer.from(hkdfSync('sha256', masterKey, createHash('sha256').update(saltText).digest(), info, 32));
}

function encryptAead(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return { nonce: nonce.toString('base64'), tag: tag.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decryptAead(key, envelope, aad) {
  try {
    const nonce = readBase64(envelope.nonce, 12, 'invalid-key-envelope');
    const tag = readBase64(envelope.tag, 16, 'invalid-key-envelope');
    const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SafeVaultError('invalid-credential', 'Authenticated decryption failed.');
  } finally {
    key.fill(0);
  }
}

function createEmptyManifest(now) {
  return {
    version: MANIFEST_VERSION,
    sequence: 0,
    sections: [
      { id: randomUUID(), name: 'Личное', color: '#d97706', createdAt: now, updatedAt: now },
      { id: randomUUID(), name: 'Документы', color: '#f59e0b', createdAt: now, updatedAt: now },
      { id: randomUUID(), name: 'Медиа', color: '#facc15', createdAt: now, updatedAt: now },
    ],
    folders: [],
    files: [],
    updatedAt: now,
  };
}

function publicManifest(manifest) {
  return {
    version: manifest.version,
    sections: structuredClone(manifest.sections),
    folders: structuredClone(manifest.folders),
    files: manifest.files.filter((file) => file.hidden !== true).map((file) => publicFile(file)),
    updatedAt: manifest.updatedAt,
  };
}

function publicFile(file) {
  const { keyEnvelope: _keyEnvelope, blobId: _blobId, ...metadata } = file;
  return structuredClone(metadata);
}

function isChatRecordFile(file) {
  return Boolean(
    file
    && file.hidden === true
    && file.application === 'monarch-chat'
    && file.mime === CHAT_RECORD_MIME
    && typeof file.chatId === 'string'
    && (file.chatKind === 'oscar' || file.chatKind === 'coder'),
  );
}

function publicChatRecord(file) {
  return {
    id: file.chatId,
    kind: file.chatKind,
    title: file.chatTitle || 'Зашифрованный чат',
    preview: file.chatPreview || '',
    messageCount: clampInteger(file.chatMessageCount, 0, MAX_CHAT_MESSAGES, 0),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    encrypted: true,
    storage: 'monarch-safe',
  };
}

function normalizeSafeChatRecord(value) {
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(value));
  } catch {
    throw new SafeVaultError('invalid-chat-record', 'Chat record must be JSON serializable.');
  }
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new SafeVaultError('invalid-chat-record', 'Chat record must be an object.');
  }
  const id = normalizeChatId(cloned.id);
  const kind = normalizeChatKind(cloned.kind);
  const messages = Array.isArray(cloned.messages) ? cloned.messages : [];
  if (messages.length > MAX_CHAT_MESSAGES) {
    throw new SafeVaultError('chat-too-large', `Encrypted chats are limited to ${MAX_CHAT_MESSAGES} messages.`);
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new SafeVaultError('invalid-chat-record', 'Chat messages must be objects.');
    }
    if (!['user', 'assistant', 'system', 'tool'].includes(String(message.role || ''))) {
      throw new SafeVaultError('invalid-chat-record', 'Chat message role is invalid.');
    }
    if (typeof message.content !== 'string' || message.content.length > 2_000_000) {
      throw new SafeVaultError('invalid-chat-record', 'Chat message content exceeds its boundary.');
    }
  }
  return {
    ...cloned,
    version: 1,
    id,
    kind,
    title: normalizeChatTitle(cloned.title),
    createdAt: normalizeChatTimestamp(cloned.createdAt),
    updatedAt: normalizeChatTimestamp(cloned.updatedAt),
    messages,
  };
}

function normalizeChatId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(id)) {
    throw new SafeVaultError('invalid-chat-id', 'Chat id is invalid.');
  }
  return id;
}

function normalizeChatKind(value) {
  const kind = String(value || 'oscar');
  if (kind !== 'oscar' && kind !== 'coder') {
    throw new SafeVaultError('invalid-chat-kind', 'Chat kind is invalid.');
  }
  return kind;
}

function normalizeChatTitle(value) {
  const title = String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(title || 'Зашифрованный чат').slice(0, 160).join('');
}

function normalizeChatTimestamp(value) {
  const timestamp = String(value || '');
  return Number.isNaN(Date.parse(timestamp)) ? new Date().toISOString() : new Date(timestamp).toISOString();
}

function chatRecordPreview(record) {
  const content = [...record.messages].reverse().find((message) => message.content.trim())?.content || '';
  return Array.from(content.replace(/\s+/g, ' ').trim()).slice(0, 160).join('');
}

function validatePin(pin, pinLength) {
  if (![4, 6, 12].includes(pinLength) || !new RegExp(`^\\d{${pinLength}}$`).test(String(pin))) {
    throw new SafeVaultError('invalid-pin-format', 'PIN must contain exactly 4, 6, or 12 digits according to the selected policy.');
  }
}

function generateRecoveryKey() {
  const bytes = randomBytes(20);
  const symbols = Array.from(bytes, (value) => RECOVERY_ALPHABET[value % RECOVERY_ALPHABET.length]);
  bytes.fill(0);
  return Array.from({ length: 5 }, (_value, index) => symbols.slice(index * 4, index * 4 + 4).join('')).join('-');
}

function normalizeRecoveryKey(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 20 || [...compact].some((symbol) => !RECOVERY_ALPHABET.includes(symbol))) {
    throw new SafeVaultError('invalid-recovery-key', 'Recovery key must contain five groups of four supported characters.');
  }
  return compact.match(/.{4}/g).join('-');
}

function normalizeName(value) {
  const name = String(value || '').trim().normalize('NFC');
  if (!name || name === '.' || name === '..' || name.length > 160 || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw new SafeVaultError('invalid-name', 'Safe names must be 1-160 characters without path separators or control characters.');
  }
  return name;
}

function normalizeMime(value) {
  const mime = String(value || 'application/octet-stream').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

function normalizeColor(value) {
  const color = String(value || '').trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new SafeVaultError('invalid-color', 'Section color must be a six-digit hex color.');
  return color.toLowerCase();
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) return Buffer.from(value);
  throw new SafeVaultError('invalid-bytes', 'File content must be a byte array.');
}

function normalizeDeviceKey(value) {
  if (value === null || value === undefined) return null;
  const key = normalizeBytes(value);
  if (key.byteLength !== 32) {
    key.fill(0);
    throw new SafeVaultError('invalid-device-key', 'Safe device binding must be exactly 32 bytes.');
  }
  const copy = Buffer.from(key);
  key.fill(0);
  return copy;
}

function normalizeKdf(value) {
  const source = value || {};
  const normalized = {
    N: clampInteger(source.N, 2 ** 9, 2 ** 20, DEFAULT_PIN_KDF.N),
    r: clampInteger(source.r, 1, 32, 8),
    p: clampInteger(source.p, 1, 8, 1),
    maxmem: clampInteger(source.maxmem, 4 * 1024 * 1024, 1024 * 1024 * 1024, DEFAULT_PIN_KDF.maxmem),
  };
  if ((normalized.N & (normalized.N - 1)) !== 0) throw new SafeVaultError('invalid-kdf', 'scrypt N must be a power of two.');
  return normalized;
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || value.version !== CONFIG_VERSION || !Number.isSafeInteger(value.sequence)) {
    throw new SafeVaultError('invalid-config', 'Safe configuration is invalid.');
  }
  if (!['pending', 'active', 'destroyed'].includes(value.status) || typeof value.vaultId !== 'string') {
    throw new SafeVaultError('invalid-config', 'Safe configuration status is invalid.');
  }
  if (value.status === 'active' || value.status === 'pending') {
    if (![4, 6, 12].includes(value.pinLength) || !value.pin || !Array.isArray(value.recovery) || value.recovery.length !== 3) {
      throw new SafeVaultError('invalid-config', 'Active Safe key envelopes are incomplete.');
    }
    if (value.pin.deviceBound !== true) {
      throw new SafeVaultError('invalid-config', 'Active Safe PIN envelope is not device-bound.');
    }
    if (value.emergency !== undefined && value.emergency !== null) {
      const emergency = value.emergency;
      if (
        emergency.version !== 1
        || emergencyPhraseEntropyBits(emergency.wordCount) <= 0
        || emergency.entropyBits !== emergencyPhraseEntropyBits(emergency.wordCount)
        || !emergency.envelope
        || emergency.envelope.deviceBound !== true
        || !Number.isSafeInteger(emergency.cleanPinSessions)
        || emergency.cleanPinSessions < 0
        || emergency.cleanPinSessions > 2
        || (emergency.lastCleanSessionId !== null && (
          typeof emergency.lastCleanSessionId !== 'string'
          || emergency.lastCleanSessionId.length < 1
          || emergency.lastCleanSessionId.length > 128
        ))
        || typeof emergency.armed !== 'boolean'
        || typeof emergency.windowEligible !== 'boolean'
        || typeof emergency.attemptUsed !== 'boolean'
      ) {
        throw new SafeVaultError('invalid-config', 'Emergency recovery configuration is invalid.');
      }
      validateCredentialEnvelope(emergency.envelope);
    }
    if (value.securityPolicy !== undefined) {
      const normalizedPolicy = normalizeSafeSecurityPolicy(value.securityPolicy);
      if (!value.securityPolicy || typeof value.securityPolicy !== 'object'
        || Object.keys(normalizedPolicy).some((key) => normalizedPolicy[key] !== value.securityPolicy[key])
        || Object.keys(value.securityPolicy).some((key) => !(key in normalizedPolicy))) {
        throw new SafeVaultError('invalid-config', 'Safe security policy is invalid.');
      }
    }
  }
}

function validateCredentialEnvelope(value) {
  if (!value || typeof value !== 'object' || value.kdf?.name !== 'scrypt') {
    throw new SafeVaultError('invalid-config', 'Credential envelope is invalid.');
  }
  normalizeKdf(value.kdf);
  readBase64(value.salt, 16, 'invalid-config');
  readBase64(value.nonce, 12, 'invalid-config');
  readBase64(value.tag, 16, 'invalid-config');
  readBase64(value.ciphertext, 32, 'invalid-config');
}

function resetEmergencyTrust(emergency) {
  emergency.cleanPinSessions = 0;
  emergency.lastCleanSessionId = null;
  emergency.armed = false;
  emergency.windowEligible = false;
  emergency.attemptUsed = false;
}

function validateManifest(value) {
  if (!value || value.version !== MANIFEST_VERSION || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.sections) || !Array.isArray(value.folders) || !Array.isArray(value.files)) {
    throw new SafeVaultError('invalid-manifest', 'Safe manifest structure is invalid.');
  }
  const ids = new Set();
  for (const collection of [value.sections, value.folders, value.files]) {
    for (const entry of collection) {
      if (!entry || typeof entry.id !== 'string' || ids.has(entry.id)) throw new SafeVaultError('invalid-manifest', 'Safe manifest identifiers are invalid.');
      ids.add(entry.id);
    }
  }
  for (const file of value.files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES || typeof file.name !== 'string' || typeof file.mime !== 'string' || !/^[0-9a-f-]{36}$/i.test(file.blobId)) {
      throw new SafeVaultError('invalid-manifest', 'Safe file metadata is invalid.');
    }
    if (file.hidden === true || file.application === 'monarch-chat') {
      if (
        !isChatRecordFile(file)
        || normalizeChatId(file.chatId) !== file.chatId
        || normalizeChatKind(file.chatKind) !== file.chatKind
        || typeof file.chatTitle !== 'string'
        || typeof file.chatPreview !== 'string'
        || !Number.isSafeInteger(file.chatMessageCount)
        || file.chatMessageCount < 0
        || file.chatMessageCount > MAX_CHAT_MESSAGES
      ) {
        throw new SafeVaultError('invalid-manifest', 'Safe chat metadata is invalid.');
      }
    }
    validateFileKeyEnvelope(file.keyEnvelope);
  }
}

function validateFileKeyEnvelope(value) {
  if (!value || typeof value !== 'object') throw new SafeVaultError('invalid-manifest', 'Safe file key envelope is missing.');
  readBase64(value.nonce, 12, 'invalid-manifest');
  readBase64(value.tag, 16, 'invalid-manifest');
  readBase64(value.ciphertext, 32, 'invalid-manifest');
}

function parseArchive(plain) {
  if (plain.byteLength < ARCHIVE_MAGIC.length + 4 || !plain.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
    throw new SafeVaultError('invalid-archive', 'Archive magic is invalid.');
  }
  const descriptorLength = plain.readUInt32BE(ARCHIVE_MAGIC.length);
  const descriptorStart = ARCHIVE_MAGIC.length + 4;
  const dataStart = descriptorStart + descriptorLength;
  if (descriptorLength <= 0 || descriptorLength > MAX_ARCHIVE_DESCRIPTOR_BYTES || dataStart > plain.byteLength) throw new SafeVaultError('invalid-archive', 'Archive descriptor bounds are invalid.');
  let entries;
  try { entries = JSON.parse(plain.subarray(descriptorStart, dataStart).toString('utf8')); } catch { throw new SafeVaultError('invalid-archive', 'Archive descriptor is invalid JSON.'); }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) throw new SafeVaultError('invalid-archive', 'Archive entry count is invalid.');
  let expectedOffset = 0;
  const parsed = entries.map((entry) => {
    const name = normalizeName(entry?.name);
    const mime = normalizeMime(entry?.mime);
    const size = readBoundedInteger(entry?.size, 0, MAX_FILE_BYTES);
    const offset = readBoundedInteger(entry?.offset, 0, MAX_ARCHIVE_OUTPUT_BYTES);
    if (size < 0 || offset !== expectedOffset || dataStart + offset + size > plain.byteLength) throw new SafeVaultError('invalid-archive', 'Archive entry bounds are invalid.');
    expectedOffset += size;
    return { name, mime, size, offset: dataStart + offset };
  });
  if (dataStart + expectedOffset !== plain.byteLength) throw new SafeVaultError('invalid-archive', 'Archive contains unreferenced trailing data.');
  return parsed;
}

function ensureArchiveExtension(value) {
  const name = normalizeName(value || 'Архив.msa');
  return name.toLowerCase().endsWith('.msa') ? name : `${name}.msa`;
}

function readBase64(value, expectedLength, code) {
  const result = Buffer.from(String(value || ''), 'base64');
  if (result.byteLength !== expectedLength) throw new SafeVaultError(code, 'Encrypted envelope field has an invalid length.');
  return result;
}

function compareSecuritySequence(left, right) {
  const leftSequence = clampInteger(left.sequence, 0, Number.MAX_SAFE_INTEGER, 0);
  const rightSequence = clampInteger(right.sequence, 0, Number.MAX_SAFE_INTEGER, 0);
  if (leftSequence !== rightSequence) return leftSequence > rightSequence ? 1 : -1;
  return Number(left.status === 'destroyed') - Number(right.status === 'destroyed');
}

function sealRank(value) {
  return ({ valid: 3, legacy: 2, unavailable: 1, failed: 0 })[value] ?? 0;
}

function verifyConfigSeal(config, deviceKey) {
  if (!deviceKey) return 'unavailable';
  if (typeof config?.deviceSeal !== 'string' || !config.deviceSeal) return 'legacy';
  try {
    const actual = Buffer.from(config.deviceSeal, 'base64');
    const expected = Buffer.from(computeConfigSeal(config, deviceKey), 'base64');
    const valid = actual.byteLength === 32 && expected.byteLength === 32 && timingSafeEqual(actual, expected);
    actual.fill(0);
    expected.fill(0);
    return valid ? 'valid' : 'failed';
  } catch {
    return 'failed';
  }
}

function computeConfigSeal(config, deviceKey) {
  const { deviceSeal: _deviceSeal, ...unsealed } = config;
  const payload = Buffer.from(canonicalJson(unsealed), 'utf8');
  try {
    return createHmac('sha256', deviceKey)
      .update('monarch-safe:config-seal:v1\0', 'utf8')
      .update(payload)
      .digest('base64');
  } finally {
    payload.fill(0);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clampInteger(value, minimum, maximum, fallback) {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function readBoundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : -1;
}

async function readBoundedFile(filePath, maximumBytes, code) {
  const handle = await open(filePath, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 0 || metadata.size > maximumBytes) {
      throw new SafeVaultError(code, 'Safe file exceeds its authenticated size boundary.');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) {
      bytes.fill(0);
      throw new SafeVaultError(code, 'Safe file changed outside its authenticated size boundary.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function secureRemove(filePath) {
  // Deletion is cryptographic first: the authenticated key envelope is removed
  // before this unlink. Rewriting a path is both unreliable on SSDs and unsafe
  // when a hostile local process replaces it with a hardlink/symlink.
  await rm(filePath, { force: true }).catch(() => undefined);
}

export const SAFE_VAULT_LIMITS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxArchiveOutputBytes: MAX_ARCHIVE_OUTPUT_BYTES,
  maxArchiveDescriptorBytes: MAX_ARCHIVE_DESCRIPTOR_BYTES,
  maxConfigBytes: MAX_CONFIG_BYTES,
  maxManifestEnvelopeBytes: MAX_MANIFEST_ENVELOPE_BYTES,
  maxChatRecordBytes: MAX_CHAT_RECORD_BYTES,
  maxChatMessages: MAX_CHAT_MESSAGES,
});
