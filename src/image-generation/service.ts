import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AiHordeProvider,
  AiHordeProviderError,
  type AiHordeGenerationResult,
  type AiHordeProviderLike,
} from './ai-horde-provider';
import type {
  ImageContentRatingV1,
  ImageGenerationCapabilitySnapshotV1,
  ImageGenerationContextV1,
  ImageGenerationDraftV1,
  ImageGenerationIntentV1,
  ImageGenerationJobSnapshotV1,
  ImageGenerationPolicySnapshotV1,
  ImageGenerationPolicyV1,
  ImageGenerationPreparationV1,
  ImageGenerationResultV1,
  ImageLibraryRecordV1,
  ImageMatureModeV1,
  IncognitoImagePersistenceV1,
} from './contracts';
import { IMAGE_PROVIDER_AGREEMENT_VERSION } from './provider-agreement';

const POLICY_FILE = 'policy.v1.json';
const LIBRARY_FILE = 'library.v1.json';
const JOBS_FILE = 'jobs.v1.json';
const PERCHANCE_URL = 'https://perchance.org/ai-text-to-image-generator';
const MAX_PROMPT_LENGTH = 4_000;
const MAX_NEGATIVE_PROMPT_LENGTH = 2_000;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const CHALLENGE_TTL_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const MIN_PROVIDER_POLL_MS = 2_000;
const MAX_STORED_JOBS = 100;

export interface ImageGenerationServiceOptions {
  now?: () => number;
  provider?: AiHordeProviderLike;
}

interface StoredLibraryV1 {
  schemaVersion: 1;
  records: ImageLibraryRecordV1[];
}

interface StoredJobsV1 {
  schemaVersion: 1;
  jobs: StoredGenerationJobV1[];
}

interface StoredGenerationJobV1 {
  schemaVersion: 1;
  snapshot: ImageGenerationJobSnapshotV1;
  providerRequestId: string;
  draft: NormalizedDraft;
  lastProviderPollAt: string | null;
}

interface MatureChallenge {
  id: string;
  draftHash: string;
  expiresAtMs: number;
}

type NormalizedDraft = Required<Omit<ImageGenerationDraftV1, 'confirmationId'>> & { confirmationId?: string };

export class ImageGenerationService {
  private readonly policyPath: string;
  private readonly libraryPath: string;
  private readonly jobsPath: string;
  private readonly assetsRoot: string;
  private readonly now: () => number;
  private readonly provider: AiHordeProviderLike;
  private readonly matureChallenges = new Map<string, MatureChallenge>();
  private readonly incognitoJobs = new Map<string, StoredGenerationJobV1>();
  private readonly ephemeralResults = new Map<string, AiHordeGenerationResult[]>();
  private readonly activePolls = new Map<string, Promise<ImageGenerationJobSnapshotV1>>();
  private mutationQueue = Promise.resolve();
  private submissionQueue = Promise.resolve();

  constructor(readonly root: string, options: ImageGenerationServiceOptions = {}) {
    this.root = path.resolve(root);
    this.policyPath = path.join(this.root, POLICY_FILE);
    this.libraryPath = path.join(this.root, LIBRARY_FILE);
    this.jobsPath = path.join(this.root, JOBS_FILE);
    this.assetsRoot = path.join(this.root, 'library');
    this.now = options.now || Date.now;
    this.provider = options.provider || new AiHordeProvider();
  }

  readCapabilitySnapshot(): ImageGenerationCapabilitySnapshotV1 {
    return {
      schemaVersion: 1,
      available: true,
      surface: 'images',
      primaryProvider: {
        id: 'perchance-interactive',
        label: 'Perchance',
        mode: 'interactive',
        url: PERCHANCE_URL,
      },
      emergencyProvider: {
        id: 'aihorde-anonymous',
        label: 'AI Horde',
        mode: 'emergency',
        activation: 'provider-error-or-explicit-user-action',
      },
    };
  }

  async readContext(): Promise<ImageGenerationContextV1> {
    const [policy, library, storedJobs] = await Promise.all([this.readPolicy(), this.readLibrary(), this.readJobs()]);
    const jobs = [...storedJobs.jobs, ...this.incognitoJobs.values()]
      .map((entry) => entry.snapshot)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20);
    const capability = this.readCapabilitySnapshot();
    return {
      schemaVersion: 1,
      policy: this.snapshotPolicy(policy),
      library: [...library.records].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      jobs,
      primaryProvider: capability.primaryProvider,
      emergencyProvider: capability.emergencyProvider,
      manualFallback: capability.primaryProvider,
    };
  }

  async readPolicySnapshot(): Promise<ImageGenerationPolicySnapshotV1> {
    return this.snapshotPolicy(await this.readPolicy());
  }

  async updatePolicy(input: {
    action: 'provider-consent' | 'perchance-access' | 'perchance-intro' | 'mature-mode' | 'incognito-persistence';
    enabled?: boolean;
    agreementVersion?: string;
    cloudProcessingAccepted?: boolean;
    thirdPartyTermsAccepted?: boolean;
    mode?: Exclude<ImageMatureModeV1, 'off'> | 'off';
    adultAttested?: boolean;
    value?: IncognitoImagePersistenceV1;
  }): Promise<ImageGenerationPolicySnapshotV1> {
    return this.withMutation(async () => {
      const current = await this.readPolicy();
      const now = new Date(this.now()).toISOString();
      let next: ImageGenerationPolicyV1;
      if (input.action === 'provider-consent') {
        if (input.enabled === true && (
          input.agreementVersion !== IMAGE_PROVIDER_AGREEMENT_VERSION
          || input.cloudProcessingAccepted !== true
          || input.thirdPartyTermsAccepted !== true
        )) {
          throw imageError(403, 'provider-agreement-required', 'The current provider agreement and both required acknowledgements must be accepted together.');
        }
        const granted = input.enabled === true;
        next = {
          ...current,
          revision: current.revision + 1,
          providerId: 'perchance-interactive',
          providerConsentGrantedAt: granted ? now : null,
          providerAgreementVersion: granted ? IMAGE_PROVIDER_AGREEMENT_VERSION : null,
          cloudProcessingAcceptedAt: granted ? now : null,
          thirdPartyTermsAcceptedAt: granted ? now : null,
          providerAdultAttestedAt: null,
          providerIntroAcknowledgedAt: null,
          updatedAt: now,
        };
      } else if (input.action === 'perchance-access') {
        if (input.enabled === true && input.adultAttested !== true) {
          throw imageError(403, 'perchance-adult-attestation-required', 'Perchance access requires an explicit 18+ attestation under its current Terms.');
        }
        next = {
          ...current,
          revision: current.revision + 1,
          providerAdultAttestedAt: input.enabled === true ? now : null,
          updatedAt: now,
        };
      } else if (input.action === 'perchance-intro') {
        if (input.enabled !== true
          || !hasCurrentProviderConsent(current)
          || !validTimestampOrNull(current.providerAdultAttestedAt)) {
          throw imageError(403, 'perchance-intro-prerequisites-required', 'Accept the current provider agreement and 18+ requirement first.');
        }
        next = {
          ...current,
          revision: current.revision + 1,
          providerIntroAcknowledgedAt: now,
          updatedAt: now,
        };
      } else if (input.action === 'incognito-persistence') {
        if (!['never', 'ask', 'always'].includes(String(input.value || ''))) {
          throw imageError(400, 'invalid-incognito-persistence', 'Unknown incognito image persistence mode.');
        }
        next = {
          ...current,
          revision: current.revision + 1,
          incognitoPersistence: input.value!,
          updatedAt: now,
        };
      } else {
        const mode = input.mode || 'off';
        if (!['off', 'one-hour', 'persistent'].includes(mode)) {
          throw imageError(400, 'invalid-mature-mode', 'Unknown mature image mode.');
        }
        if (mode !== 'off' && input.adultAttested !== true) {
          throw imageError(403, 'adult-attestation-required', 'Adult content mode requires an explicit 18+ attestation.');
        }
        next = {
          ...current,
          revision: current.revision + 1,
          matureMode: mode,
          matureEnabledUntil: mode === 'one-hour' ? new Date(this.now() + ONE_HOUR_MS).toISOString() : null,
          adultAttestedAt: mode === 'off' ? current.adultAttestedAt : now,
          updatedAt: now,
        };
        if (mode === 'off') this.matureChallenges.clear();
      }
      await this.writeJsonAtomic(this.policyPath, next);
      return this.snapshotPolicy(next);
    });
  }

  async prepareGeneration(rawDraft: ImageGenerationDraftV1): Promise<ImageGenerationPreparationV1> {
    return this.startGeneration(rawDraft);
  }

  async startGeneration(rawDraft: ImageGenerationDraftV1): Promise<ImageGenerationPreparationV1> {
    const draft = normalizeDraft(rawDraft);
    const policy = await this.readPolicy();
    const snapshot = this.snapshotPolicy(policy);
    const classification = classifyImagePrompt(`${draft.prompt}\n${draft.negativePrompt}`);
    if (classification === 'prohibited') {
      return { schemaVersion: 1, status: 'blocked', reason: 'prohibited-content', contentRating: 'nsfw' };
    }
    const contentRating: ImageContentRatingV1 = classification === 'nsfw' ? 'nsfw' : 'safe';
    if (!snapshot.providerConsentCurrent) {
      return { schemaVersion: 1, status: 'blocked', reason: 'provider-consent-required', contentRating };
    }
    if (draft.providerId === 'perchance-interactive' && !validTimestampOrNull(policy.providerAdultAttestedAt)) {
      return { schemaVersion: 1, status: 'blocked', reason: 'perchance-adult-attestation-required', contentRating };
    }
    if (contentRating === 'nsfw' && !snapshot.matureModeActive) {
      return { schemaVersion: 1, status: 'blocked', reason: 'mature-mode-disabled', contentRating };
    }
    if (contentRating === 'nsfw') {
      const draftHash = hashDraft(draft);
      if (!this.consumeMatureChallenge(draft.confirmationId, draftHash)) {
        const challengeId = `image_challenge_${randomUUID().replace(/-/gu, '')}`;
        const expiresAtMs = this.now() + CHALLENGE_TTL_MS;
        this.matureChallenges.set(challengeId, { id: challengeId, draftHash, expiresAtMs });
        this.pruneChallenges();
        return {
          schemaVersion: 1,
          status: 'confirmation-required',
          challengeId,
          kind: 'nsfw-generation',
          expiresAt: new Date(expiresAtMs).toISOString(),
          contentRating: 'nsfw',
          summary: draft.providerId === 'perchance-interactive'
            ? 'Передать этот 18+ prompt в интерактивный Perchance?'
            : 'Отправить этот 18+ prompt в AI Horde, где его обрабатывает независимый volunteer worker?',
        };
      }
    }

    if (draft.providerId === 'perchance-interactive') {
      return {
        schemaVersion: 1,
        status: 'interactive-ready',
        providerId: 'perchance-interactive',
        providerLabel: 'Perchance',
        contentRating,
        privacyMode: draft.privacyMode,
        prompt: draft.prompt,
        promptText: formatPerchancePrompt(draft),
        url: PERCHANCE_URL,
      };
    }

    const privacyMode = draft.privacyMode;
    const savePolicy = privacyMode === 'persistent'
      ? 'save'
      : policy.incognitoPersistence === 'always'
        ? 'save'
        : policy.incognitoPersistence === 'ask' ? 'ask' : 'discard';
    return this.withSubmission(async () => {
      const activeCount = await this.countActiveJobs();
      if (activeCount >= 3) {
        throw imageError(429, 'too-many-active-generations', 'Wait for one of the three active image generations to finish or cancel it.');
      }
      let submitted;
      try {
        submitted = await this.provider.submit(draft, contentRating);
      } catch (error) {
        throw providerAsServiceError(error);
      }
      const timestamp = new Date(this.now()).toISOString();
      const jobId = `image_job_${randomUUID().replace(/-/gu, '')}`;
      const job: StoredGenerationJobV1 = {
        schemaVersion: 1,
        providerRequestId: submitted.requestId,
        draft,
        lastProviderPollAt: null,
        snapshot: {
          schemaVersion: 1,
          status: 'queued',
          jobId,
          providerId: 'aihorde-anonymous',
          providerLabel: 'AI Horde',
          contentRating,
          privacyMode,
          savePolicy,
          prompt: draft.prompt,
          requestedCount: draft.count,
          queuePosition: 0,
          waitTimeSeconds: 0,
          finishedCount: 0,
          processingCount: 0,
          waitingCount: draft.count,
          sharedWithLaion: true,
          results: [],
          warnings: [
            ...submitted.warnings,
            ...(submitted.message ? [submitted.message] : []),
          ],
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      };
      if (privacyMode === 'incognito') {
        this.incognitoJobs.set(jobId, job);
      } else {
        await this.withMutation(async () => {
          const jobs = await this.readJobs();
          jobs.jobs.push(job);
          await this.writeJobs(jobs);
        });
      }
      return job.snapshot;
    });
  }

  async readGenerationJob(rawId: string): Promise<ImageGenerationJobSnapshotV1> {
    const id = normalizeJobId(rawId);
    const existing = this.activePolls.get(id);
    if (existing) return existing;
    const operation = this.refreshGenerationJob(id).finally(() => this.activePolls.delete(id));
    this.activePolls.set(id, operation);
    return operation;
  }

  async cancelGeneration(rawId: string): Promise<ImageGenerationJobSnapshotV1> {
    const id = normalizeJobId(rawId);
    const job = await this.findJob(id);
    if (isTerminalJob(job.snapshot.status)) return job.snapshot;
    try {
      await this.provider.cancel(job.providerRequestId);
    } catch (error) {
      throw providerAsServiceError(error);
    }
    job.snapshot = {
      ...job.snapshot,
      status: 'cancelled',
      waitingCount: 0,
      processingCount: 0,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.persistJob(job);
    this.ephemeralResults.delete(id);
    return job.snapshot;
  }

  async readGenerationResult(rawJobId: string, rawIndex: number): Promise<{ mimeType: ImageLibraryRecordV1['mimeType']; bytes: Buffer }> {
    const job = await this.findJob(normalizeJobId(rawJobId));
    if (job.snapshot.contentRating === 'nsfw' && !this.snapshotPolicy(await this.readPolicy()).matureModeActive) {
      throw imageError(409, 'mature-mode-disabled', 'Enable adult content mode before opening this NSFW result.');
    }
    const index = normalizeResultIndex(rawIndex);
    const result = job.snapshot.results.find((candidate) => candidate.index === index);
    if (!result || !result.available) throw imageError(404, 'generation-result-not-found', 'Generation result was not found.');
    if (result.libraryRecordId) {
      const asset = await this.readImage(result.libraryRecordId);
      return { mimeType: asset.record.mimeType, bytes: await readFile(asset.filePath) };
    }
    const generated = this.ephemeralResults.get(job.snapshot.jobId)?.[index];
    if (!generated) throw imageError(410, 'generation-result-expired', 'This ephemeral result is no longer available.');
    return { mimeType: generated.mimeType, bytes: generated.bytes };
  }

  async saveGenerationResults(rawJobId: string): Promise<ImageGenerationJobSnapshotV1> {
    const job = await this.findJob(normalizeJobId(rawJobId));
    if (job.snapshot.status !== 'completed') throw imageError(409, 'generation-not-completed', 'Generation is not complete.');
    if (job.snapshot.results.every((result) => result.libraryRecordId)) return job.snapshot;
    const generated = this.ephemeralResults.get(job.snapshot.jobId);
    if (!generated?.length) throw imageError(410, 'generation-result-expired', 'This ephemeral result is no longer available.');
    const records = await this.saveGeneratedImages(job, generated);
    job.snapshot = {
      ...job.snapshot,
      savePolicy: 'save',
      results: buildResultSnapshots(generated, records),
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.persistJob(job);
    this.ephemeralResults.delete(job.snapshot.jobId);
    return job.snapshot;
  }

  async evaluateIntent(rawText: string): Promise<ImageGenerationIntentV1> {
    const prompt = normalizeText(rawText, MAX_PROMPT_LENGTH);
    if (!looksLikeImageGenerationRequest(prompt)) {
      return {
        schemaVersion: 1,
        isImageGeneration: false,
        prompt: '',
        contentRating: 'unknown',
        disposition: 'not-image-generation',
        providerId: 'perchance-interactive',
      };
    }
    const classification = classifyImagePrompt(prompt);
    if (classification === 'prohibited') {
      return {
        schemaVersion: 1,
        isImageGeneration: true,
        prompt,
        contentRating: 'nsfw',
        disposition: 'prohibited-content',
        providerId: 'perchance-interactive',
      };
    }
    const contentRating: ImageContentRatingV1 = classification === 'nsfw' ? 'nsfw' : 'safe';
    const snapshot = this.snapshotPolicy(await this.readPolicy());
    const disposition = !snapshot.providerConsentCurrent
      ? 'provider-consent-required'
      : !snapshot.providerAdultAttestedAt
        ? 'perchance-adult-attestation-required'
        : contentRating === 'nsfw' && !snapshot.matureModeActive
          ? 'mature-mode-disabled'
          : contentRating === 'nsfw' ? 'confirmation-required' : 'ready';
    return {
      schemaVersion: 1,
      isImageGeneration: true,
      prompt,
      contentRating,
      disposition,
      providerId: 'perchance-interactive',
    };
  }

  async importImage(input: {
    name?: string;
    mimeType?: string;
    dataBase64?: string;
    contentRating?: ImageContentRatingV1;
    prompt?: string;
    privacyMode?: 'persistent' | 'incognito';
    explicitSave?: boolean;
  }): Promise<ImageLibraryRecordV1> {
    const mimeType = normalizeImageMimeType(input.mimeType);
    const bytes = decodeImage(input.dataBase64);
    assertImageSignature(bytes, mimeType);
    const privacyMode = input.privacyMode === 'incognito' ? 'incognito' : 'persistent';
    const policy = await this.readPolicy();
    if (privacyMode === 'incognito' && policy.incognitoPersistence === 'never' && input.explicitSave !== true) {
      throw imageError(409, 'incognito-image-save-disabled', 'Incognito image saving is disabled.');
    }
    if (privacyMode === 'incognito' && policy.incognitoPersistence === 'ask' && input.explicitSave !== true) {
      throw imageError(409, 'incognito-image-save-confirmation-required', 'Explicit save is required for this incognito image.');
    }
    const contentRating = normalizeContentRating(input.contentRating);
    if (contentRating === 'nsfw' && !this.snapshotPolicy(policy).matureModeActive) {
      throw imageError(409, 'mature-mode-disabled', 'Enable adult content mode before importing an NSFW image.');
    }
    return this.withMutation(async () => this.storeImage({
      ...(input.name ? { name: input.name } : {}),
      mimeType,
      bytes,
      contentRating,
      prompt: normalizeText(input.prompt, MAX_PROMPT_LENGTH),
      providerId: 'import',
      generationJobId: null,
      generationIndex: null,
      privacyMode,
    }));
  }

  async readImage(id: string): Promise<{ record: ImageLibraryRecordV1; filePath: string }> {
    const safeId = normalizeRecordId(id);
    const library = await this.readLibrary();
    const record = library.records.find((candidate) => candidate.id === safeId);
    if (!record) throw imageError(404, 'image-not-found', 'Image was not found.');
    if (record.contentRating === 'nsfw' && !this.snapshotPolicy(await this.readPolicy()).matureModeActive) {
      throw imageError(409, 'mature-mode-disabled', 'Enable adult content mode before opening this NSFW image.');
    }
    return { record, filePath: path.join(this.assetsRoot, `${record.id}${extensionForMime(record.mimeType)}`) };
  }

  async deleteImage(id: string): Promise<void> {
    const safeId = normalizeRecordId(id);
    await this.withMutation(async () => {
      const library = await this.readLibrary();
      const index = library.records.findIndex((candidate) => candidate.id === safeId);
      if (index < 0) throw imageError(404, 'image-not-found', 'Image was not found.');
      const [record] = library.records.splice(index, 1);
      if (!record) throw imageError(404, 'image-not-found', 'Image was not found.');
      await this.writeJsonAtomic(this.libraryPath, library);
      await rm(path.join(this.assetsRoot, `${record.id}${extensionForMime(record.mimeType)}`), { force: true });
    });
  }

  private async refreshGenerationJob(id: string): Promise<ImageGenerationJobSnapshotV1> {
    const job = await this.findJob(id);
    if (isTerminalJob(job.snapshot.status)) return job.snapshot;
    if (job.snapshot.contentRating === 'nsfw' && !this.snapshotPolicy(await this.readPolicy()).matureModeActive) {
      await this.provider.cancel(job.providerRequestId).catch(() => undefined);
      job.snapshot = {
        ...job.snapshot,
        status: 'cancelled',
        queuePosition: 0,
        waitTimeSeconds: 0,
        processingCount: 0,
        waitingCount: 0,
        error: { code: 'mature-mode-disabled', message: 'Режим 18+ выключен или истёк; NSFW job отменён.' },
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.persistJob(job);
      this.ephemeralResults.delete(job.snapshot.jobId);
      return job.snapshot;
    }
    const lastPollMs = Date.parse(job.lastProviderPollAt || '');
    if (Number.isFinite(lastPollMs) && this.now() - lastPollMs < MIN_PROVIDER_POLL_MS) return job.snapshot;
    let check;
    try {
      check = await this.provider.check(job.providerRequestId);
    } catch (error) {
      if (isPermanentProviderJobError(error)) {
        const now = new Date(this.now()).toISOString();
        job.snapshot = failJob(job.snapshot, error.code, error.message, now);
        await this.persistJob(job);
        return job.snapshot;
      }
      throw providerAsServiceError(error);
    }
    const now = new Date(this.now()).toISOString();
    job.lastProviderPollAt = now;
    if (check.faulted) {
      job.snapshot = failJob(job.snapshot, 'provider-job-faulted', 'AI Horde reported that the generation failed.', now);
      await this.persistJob(job);
      return job.snapshot;
    }
    if (check.done) return this.completeGenerationJob(job, now);
    job.snapshot = {
      ...job.snapshot,
      status: check.processing > 0 ? 'processing' : 'queued',
      queuePosition: check.queuePosition,
      waitTimeSeconds: check.waitTime,
      finishedCount: check.finished,
      processingCount: check.processing,
      waitingCount: check.waiting,
      warnings: check.isPossible ? job.snapshot.warnings : addUnique(job.snapshot.warnings, 'Сейчас нет подходящего worker; Monarch продолжит проверять очередь.'),
      updatedAt: now,
    };
    await this.persistJob(job);
    return job.snapshot;
  }

  private async completeGenerationJob(job: StoredGenerationJobV1, now: string): Promise<ImageGenerationJobSnapshotV1> {
    let status;
    try {
      status = await this.provider.status(job.providerRequestId);
    } catch (error) {
      if (isPermanentProviderJobError(error)) {
        job.snapshot = failJob(job.snapshot, error.code, error.message, now);
        await this.persistJob(job);
        return job.snapshot;
      }
      throw providerAsServiceError(error);
    }
    if (status.faulted) {
      job.snapshot = failJob(job.snapshot, 'provider-job-faulted', 'AI Horde reported that the generation failed.', now);
      await this.persistJob(job);
      return job.snapshot;
    }
    if (status.generations.some(isCsamResult)) {
      job.snapshot = failJob(job.snapshot, 'provider-prohibited-result', 'AI Horde marked this result as prohibited. Monarch discarded it.', now);
      await this.persistJob(job);
      this.ephemeralResults.delete(job.snapshot.jobId);
      return job.snapshot;
    }
    const accepted = status.generations.filter((result) => {
      if (result.censored || result.state === 'censored') return false;
      if (job.snapshot.contentRating === 'safe' && result.metadataTypes.includes('nsfw')) return false;
      return result.state === '' || result.state === 'ok';
    });
    if (!accepted.length) {
      job.snapshot = failJob(job.snapshot, 'provider-result-filtered', 'AI Horde did not return an image Monarch can display for this request.', now);
      await this.persistJob(job);
      return job.snapshot;
    }

    let records: ImageLibraryRecordV1[] = [];
    if (job.snapshot.savePolicy === 'save') records = await this.saveGeneratedImages(job, accepted);
    else this.ephemeralResults.set(job.snapshot.jobId, accepted);
    job.snapshot = {
      ...job.snapshot,
      status: 'completed',
      queuePosition: 0,
      waitTimeSeconds: 0,
      finishedCount: accepted.length,
      processingCount: 0,
      waitingCount: 0,
      results: buildResultSnapshots(accepted, records),
      warnings: job.snapshot.warnings,
      error: null,
      updatedAt: now,
    };
    await this.persistJob(job);
    return job.snapshot;
  }

  private async saveGeneratedImages(job: StoredGenerationJobV1, generated: AiHordeGenerationResult[]): Promise<ImageLibraryRecordV1[]> {
    return this.withMutation(async () => {
      const library = await this.readLibrary();
      const existing = library.records
        .filter((record) => record.generationJobId === job.snapshot.jobId)
        .sort((left, right) => Number(left.generationIndex) - Number(right.generationIndex));
      if (existing.length === generated.length) return existing;
      if (existing.length) {
        throw imageError(409, 'generation-save-conflict', 'A partial local save already exists for this generation.');
      }
      await mkdir(this.assetsRoot, { recursive: true });
      const records: ImageLibraryRecordV1[] = [];
      const createdFiles: string[] = [];
      const createdAt = new Date(this.now()).toISOString();
      try {
        for (const [index, result] of generated.entries()) {
          assertImageSignature(result.bytes, result.mimeType);
          const id = `image_${randomUUID().replace(/-/gu, '')}`;
          const extension = extensionForMime(result.mimeType);
          const filePath = path.join(this.assetsRoot, `${id}${extension}`);
          await writeFile(filePath, result.bytes, { flag: 'wx' });
          createdFiles.push(filePath);
          records.push({
            schemaVersion: 1,
            id,
            name: `AI Horde ${createdAt.replace(/[:.]/gu, '-')}-${index + 1}${extension}`,
            mimeType: result.mimeType,
            bytes: result.bytes.byteLength,
            sha256: createHash('sha256').update(result.bytes).digest('hex'),
            contentRating: job.snapshot.contentRating,
            prompt: job.snapshot.prompt,
            providerId: 'aihorde-anonymous',
            generationJobId: job.snapshot.jobId,
            generationIndex: index,
            privacyMode: job.snapshot.privacyMode,
            createdAt,
          });
        }
        library.records.push(...records);
        await this.writeJsonAtomic(this.libraryPath, library);
      } catch (error) {
        await Promise.all(createdFiles.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
        throw error;
      }
      return records;
    });
  }

  private async storeImage(input: {
    name?: string;
    mimeType: ImageLibraryRecordV1['mimeType'];
    bytes: Buffer;
    contentRating: ImageContentRatingV1;
    prompt: string;
    providerId: ImageLibraryRecordV1['providerId'];
    generationJobId: string | null;
    generationIndex: number | null;
    privacyMode: ImageLibraryRecordV1['privacyMode'];
  }): Promise<ImageLibraryRecordV1> {
    assertImageSignature(input.bytes, input.mimeType);
    const library = await this.readLibrary();
    const id = `image_${randomUUID().replace(/-/gu, '')}`;
    const extension = extensionForMime(input.mimeType);
    const filePath = path.join(this.assetsRoot, `${id}${extension}`);
    await mkdir(this.assetsRoot, { recursive: true });
    await writeFile(filePath, input.bytes, { flag: 'wx' });
    const record: ImageLibraryRecordV1 = {
      schemaVersion: 1,
      id,
      name: normalizeImageName(input.name, extension),
      mimeType: input.mimeType,
      bytes: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      contentRating: input.contentRating,
      prompt: normalizeText(input.prompt, MAX_PROMPT_LENGTH),
      providerId: input.providerId,
      generationJobId: input.generationJobId,
      generationIndex: input.generationIndex,
      privacyMode: input.privacyMode,
      createdAt: new Date(this.now()).toISOString(),
    };
    library.records.push(record);
    try {
      await this.writeJsonAtomic(this.libraryPath, library);
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    }
    return record;
  }

  private async findJob(id: string): Promise<StoredGenerationJobV1> {
    const incognito = this.incognitoJobs.get(id);
    if (incognito) return incognito;
    const stored = await this.readJobs();
    const job = stored.jobs.find((candidate) => candidate.snapshot.jobId === id);
    if (!job) throw imageError(404, 'generation-job-not-found', 'Generation job was not found.');
    return job;
  }

  private async countActiveJobs(): Promise<number> {
    const stored = await this.readJobs();
    return [...stored.jobs, ...this.incognitoJobs.values()]
      .filter((job) => job.snapshot.status === 'queued' || job.snapshot.status === 'processing')
      .length;
  }

  private async persistJob(job: StoredGenerationJobV1): Promise<void> {
    if (job.snapshot.privacyMode === 'incognito') {
      this.incognitoJobs.set(job.snapshot.jobId, job);
      return;
    }
    await this.withMutation(async () => {
      const stored = await this.readJobs();
      const index = stored.jobs.findIndex((candidate) => candidate.snapshot.jobId === job.snapshot.jobId);
      if (index >= 0) stored.jobs[index] = job;
      else stored.jobs.push(job);
      await this.writeJobs(stored);
    });
  }

  private async readPolicy(): Promise<ImageGenerationPolicyV1> {
    const fallback = defaultPolicy(this.now());
    const value = await readJson<Partial<ImageGenerationPolicyV1>>(this.policyPath).catch(() => null);
    if (!value || value.schemaVersion !== 1) return fallback;
    return {
      ...fallback,
      ...value,
      schemaVersion: 1,
      providerId: 'perchance-interactive',
      revision: Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision) : 0,
      matureMode: value.matureMode && ['off', 'one-hour', 'persistent'].includes(value.matureMode) ? value.matureMode : 'off',
      incognitoPersistence: value.incognitoPersistence && ['never', 'ask', 'always'].includes(value.incognitoPersistence)
        ? value.incognitoPersistence
        : 'never',
      providerAgreementVersion: typeof value.providerAgreementVersion === 'string' ? value.providerAgreementVersion : null,
      providerConsentGrantedAt: validTimestampOrNull(value.providerConsentGrantedAt),
      cloudProcessingAcceptedAt: validTimestampOrNull(value.cloudProcessingAcceptedAt),
      thirdPartyTermsAcceptedAt: validTimestampOrNull(value.thirdPartyTermsAcceptedAt),
      providerAdultAttestedAt: validTimestampOrNull(value.providerAdultAttestedAt),
      providerIntroAcknowledgedAt: validTimestampOrNull(value.providerIntroAcknowledgedAt),
      matureEnabledUntil: validTimestampOrNull(value.matureEnabledUntil),
      adultAttestedAt: validTimestampOrNull(value.adultAttestedAt),
      updatedAt: validTimestampOrNull(value.updatedAt) || fallback.updatedAt,
    };
  }

  private async readLibrary(): Promise<StoredLibraryV1> {
    const value = await readJson<StoredLibraryV1>(this.libraryPath).catch(() => null);
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.records)) return { schemaVersion: 1, records: [] };
    return {
      schemaVersion: 1,
      records: value.records.filter(isLibraryRecord).map((record) => ({
        ...record,
        generationJobId: /^image_job_[a-f0-9]{32}$/u.test(String(record.generationJobId || ''))
          ? String(record.generationJobId)
          : null,
        generationIndex: Number.isSafeInteger(record.generationIndex) && Number(record.generationIndex) >= 0
          ? Number(record.generationIndex)
          : null,
      })),
    };
  }

  private async readJobs(): Promise<StoredJobsV1> {
    const value = await readJson<StoredJobsV1>(this.jobsPath).catch(() => null);
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.jobs)) return { schemaVersion: 1, jobs: [] };
    return { schemaVersion: 1, jobs: value.jobs.filter(isStoredJob) };
  }

  private async writeJobs(value: StoredJobsV1): Promise<void> {
    value.jobs = value.jobs
      .sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt))
      .slice(0, MAX_STORED_JOBS);
    await this.writeJsonAtomic(this.jobsPath, value);
  }

  private snapshotPolicy(policy: ImageGenerationPolicyV1): ImageGenerationPolicySnapshotV1 {
    const expiry = policy.matureMode === 'one-hour' ? Date.parse(policy.matureEnabledUntil || '') : Number.NaN;
    const active = policy.matureMode === 'persistent'
      || (policy.matureMode === 'one-hour' && Number.isFinite(expiry) && expiry > this.now());
    return {
      ...policy,
      providerConsentCurrent: hasCurrentProviderConsent(policy),
      providerAgreementCurrentVersion: IMAGE_PROVIDER_AGREEMENT_VERSION,
      matureModeActive: active,
      matureModeRemainingMs: policy.matureMode === 'one-hour' && active ? Math.max(0, expiry - this.now()) : null,
      ...(active ? {} : { matureMode: 'off', matureEnabledUntil: null }),
    };
  }

  private consumeMatureChallenge(id: string | undefined, draftHash: string): boolean {
    if (!id) return false;
    const challenge = this.matureChallenges.get(id);
    this.matureChallenges.delete(id);
    return Boolean(challenge && challenge.expiresAtMs > this.now() && challenge.draftHash === draftHash);
  }

  private pruneChallenges(): void {
    for (const [id, challenge] of this.matureChallenges) {
      if (challenge.expiresAtMs <= this.now()) this.matureChallenges.delete(id);
    }
  }

  private async writeJsonAtomic(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }


  private withSubmission<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.submissionQueue.then(operation, operation);
    this.submissionQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class ImageGenerationServiceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ImageGenerationServiceError';
  }
}

export function classifyImagePrompt(value: string): 'safe' | 'nsfw' | 'prohibited' {
  const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase('ru');
  const explicitMinor = /\b(?:loli|lolicon|shota|shotacon)\b/u.test(normalized);
  const minor = /(?:\b(?:child|kid|minor|underage|schoolgirl|schoolboy|teenager)\b|реб[её]нок|несовершеннолет|малолет|школьниц|школьник|подросток)/u.test(normalized);
  const sexual = /(?:\b(?:nsfw|nude|nudity|naked|sex|sexual|erotic|porn|explicit|genitals|breasts?)\b|обнаж|голая|голый|нюд|секс|эрот|порн|интим|генитал|груд[ьи])/u.test(normalized);
  if (explicitMinor || (minor && sexual)) return 'prohibited';
  return sexual ? 'nsfw' : 'safe';
}

export function looksLikeImageGenerationRequest(value: string): boolean {
  const text = String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!text) return false;
  if (/(?:сгенерируй|создай|сделай|generate|create|make)(?:\s|$)[^.!?]{0,60}(?:сайт|код|страниц\p{L}*|макет|компонент|описан\p{L}*|промпт|website|code|page|layout|component|description|prompt)[^.!?]{0,60}(?:изображен\p{L}*|картин\p{L}*|image|picture)/iu.test(text)) return false;
  if (/(?:^|\s)(?:\$image|\/image)(?:\s|:|$)/iu.test(text)) return true;
  if (/^(?:oscar[,:]?\s*)?(?:image\s*gen(?:eration)?|генерац\p{L}*\s+(?:изображен\p{L}*|картин\p{L}*|фото|арт))(?:\s|:|$)/iu.test(text)) return true;
  if (/^(?:oscar[,:]?\s*)?(?:нарисуй|изобрази|draw|illustrate)(?:\s|$)/iu.test(text)) return true;
  return /(?:^|[.!?]\s*)(?:(?:(?:ты\s+)?(?:можешь|сможешь)|could\s+you|can\s+you|would\s+you)\s+)?(?:сгенерируй|создай|сделай|generate|create|make)(?:\s|$)[^.!?]{0,100}(?:изображен\p{L}*|картин\p{L}*|фото|арт|иллюстрац\p{L}*|обои|аватар\p{L}*|портрет\p{L}*|image|picture|photo|artwork|illustration|wallpaper|avatar|portrait)(?:\s|[,.:;!?]|$)/iu.test(text);
}

function normalizeDraft(input: ImageGenerationDraftV1): NormalizedDraft {
  const prompt = normalizeText(input?.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) throw imageError(400, 'image-prompt-required', 'Image prompt is required.');
  return {
    prompt,
    providerId: input?.providerId === 'perchance-interactive' ? 'perchance-interactive' : 'aihorde-anonymous',
    negativePrompt: normalizeText(input?.negativePrompt, MAX_NEGATIVE_PROMPT_LENGTH),
    style: normalizeChoice(input?.style, ['none', 'cinematic', 'anime', 'illustration', 'photo'], 'none'),
    aspectRatio: normalizeChoice(input?.aspectRatio, ['1:1', '16:9', '9:16', '4:5', '3:2'], '1:1'),
    count: Math.min(4, Math.max(1, Number.isSafeInteger(input?.count) ? Number(input.count) : 1)),
    seed: normalizeText(input?.seed, 64),
    privacyMode: input?.privacyMode === 'incognito' ? 'incognito' : 'persistent',
    ...(normalizeText(input?.confirmationId, 160) ? { confirmationId: normalizeText(input.confirmationId, 160) } : {}),
  };
}

function formatPerchancePrompt(draft: NormalizedDraft): string {
  return [
    draft.prompt,
    draft.negativePrompt ? `Negative prompt: ${draft.negativePrompt}` : '',
    draft.style !== 'none' ? `Style: ${draft.style}` : '',
    `Aspect ratio: ${draft.aspectRatio}`,
    draft.seed ? `Seed: ${draft.seed}` : '',
    draft.count > 1 ? `Images: ${draft.count}` : '',
  ].filter(Boolean).join('\n');
}

function hashDraft(draft: NormalizedDraft): string {
  return createHash('sha256').update(JSON.stringify({ ...draft, confirmationId: undefined })).digest('hex');
}

function defaultPolicy(nowMs: number): ImageGenerationPolicyV1 {
  const now = new Date(nowMs).toISOString();
  return {
    schemaVersion: 1,
    revision: 0,
    providerId: 'perchance-interactive',
    providerConsentGrantedAt: null,
    providerAgreementVersion: null,
    cloudProcessingAcceptedAt: null,
    thirdPartyTermsAcceptedAt: null,
    providerAdultAttestedAt: null,
    providerIntroAcknowledgedAt: null,
    matureMode: 'off',
    matureEnabledUntil: null,
    adultAttestedAt: null,
    incognitoPersistence: 'never',
    updatedAt: now,
  };
}

function validTimestampOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function hasCurrentProviderConsent(policy: ImageGenerationPolicyV1): boolean {
  return policy.providerId === 'perchance-interactive'
    && policy.providerAgreementVersion === IMAGE_PROVIDER_AGREEMENT_VERSION
    && validTimestampOrNull(policy.providerConsentGrantedAt) !== null
    && validTimestampOrNull(policy.cloudProcessingAcceptedAt) !== null
    && validTimestampOrNull(policy.thirdPartyTermsAcceptedAt) !== null;
}

function buildResultSnapshots(generated: AiHordeGenerationResult[], records: ImageLibraryRecordV1[]): ImageGenerationResultV1[] {
  return generated.map((result, index) => ({
    schemaVersion: 1,
    index,
    name: records[index]?.name || `AI Horde result ${index + 1}${extensionForMime(result.mimeType)}`,
    mimeType: result.mimeType,
    bytes: result.bytes.byteLength,
    seed: result.seed,
    model: result.model,
    libraryRecordId: records[index]?.id || null,
    available: true,
  }));
}

function isCsamResult(result: AiHordeGenerationResult): boolean {
  return result.state === 'csam' || result.metadataTypes.includes('csam');
}

function failJob(snapshot: ImageGenerationJobSnapshotV1, code: string, message: string, now: string): ImageGenerationJobSnapshotV1 {
  return {
    ...snapshot,
    status: 'failed',
    queuePosition: 0,
    waitTimeSeconds: 0,
    processingCount: 0,
    waitingCount: 0,
    results: [],
    error: { code, message },
    updatedAt: now,
  };
}

function isTerminalJob(status: ImageGenerationJobSnapshotV1['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function decodeImage(value: string | undefined): Buffer {
  const compact = String(value || '').replace(/\s+/gu, '');
  if (!compact || compact.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16) {
    throw imageError(413, 'image-payload-too-large', 'Image payload is empty or too large.');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw imageError(413, 'image-payload-too-large', 'Image payload is empty or too large.');
  }
  return bytes;
}

function normalizeImageMimeType(value: string | undefined): ImageLibraryRecordV1['mimeType'] {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp') return value;
  throw imageError(415, 'unsupported-image-type', 'Only PNG, JPEG, and WebP images are supported.');
}

function assertImageSignature(bytes: Buffer, mimeType: ImageLibraryRecordV1['mimeType']): void {
  const valid = mimeType === 'image/png'
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw imageError(415, 'image-signature-mismatch', 'Image bytes do not match the declared MIME type.');
}

function normalizeContentRating(value: unknown): ImageContentRatingV1 {
  return value === 'safe' || value === 'nsfw' || value === 'unknown' ? value : 'unknown';
}

function normalizeImageName(value: unknown, extension: string): string {
  const base = normalizeText(value, 160).replace(/[\\/:*?"<>|]/gu, '-');
  return base || `image${extension}`;
}

function normalizeRecordId(value: unknown): string {
  const id = String(value || '').trim();
  if (!/^image_[a-f0-9]{32}$/u.test(id)) throw imageError(400, 'invalid-image-id', 'Image id is invalid.');
  return id;
}

function normalizeJobId(value: unknown): string {
  const id = String(value || '').trim();
  if (!/^image_job_[a-f0-9]{32}$/u.test(id)) throw imageError(400, 'invalid-generation-job-id', 'Generation job id is invalid.');
  return id;
}

function normalizeResultIndex(value: unknown): number {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index > 3) throw imageError(400, 'invalid-generation-result-index', 'Generation result index is invalid.');
  return index;
}

function normalizeText(value: unknown, maxLength: number): string {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim().slice(0, maxLength);
}

function normalizeChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = String(value || '').trim() as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

function extensionForMime(value: ImageLibraryRecordV1['mimeType']): '.png' | '.jpg' | '.webp' {
  return value === 'image/png' ? '.png' : value === 'image/webp' ? '.webp' : '.jpg';
}

function isLibraryRecord(value: unknown): value is ImageLibraryRecordV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ImageLibraryRecordV1>;
  return record.schemaVersion === 1
    && typeof record.id === 'string'
    && /^image_[a-f0-9]{32}$/u.test(record.id)
    && typeof record.sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(record.sha256)
    && (record.mimeType === 'image/png' || record.mimeType === 'image/jpeg' || record.mimeType === 'image/webp');
}

function isStoredJob(value: unknown): value is StoredGenerationJobV1 {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<StoredGenerationJobV1>;
  return job.schemaVersion === 1
    && typeof job.providerRequestId === 'string'
    && Boolean(job.snapshot)
    && /^image_job_[a-f0-9]{32}$/u.test(String(job.snapshot?.jobId || ''))
    && job.snapshot?.providerId === 'aihorde-anonymous'
    && Boolean(job.draft && typeof job.draft.prompt === 'string');
}

function providerAsServiceError(error: unknown): ImageGenerationServiceError {
  if (error instanceof AiHordeProviderError) {
    return imageError(error.statusCode, error.code, error.message);
  }
  return imageError(502, 'provider-unavailable', error instanceof Error ? error.message : 'AI Horde is unavailable.');
}

function isPermanentProviderJobError(error: unknown): error is AiHordeProviderError {
  return error instanceof AiHordeProviderError && [
    'provider-job-not-found',
    'provider-invalid-response',
    'provider-invalid-result',
    'provider-remote-result-rejected',
    'provider-invalid-image',
  ].includes(error.code);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function imageError(statusCode: number, code: string, message: string): ImageGenerationServiceError {
  return new ImageGenerationServiceError(statusCode, code, message);
}
