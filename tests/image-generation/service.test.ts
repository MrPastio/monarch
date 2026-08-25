import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AiHordeGenerationResult,
  type AiHordeProviderLike,
  ImageGenerationService,
  ImageGenerationServiceError,
  IMAGE_PROVIDER_AGREEMENT_VERSION,
  classifyImagePrompt,
  looksLikeImageGenerationRequest,
} from '../../src/image-generation';

const roots: string[] = [];
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlK4eQAAAAASUVORK5CYII=';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ImageGenerationService', () => {
  it('blocks cloud generation before the current two-part provider consent', async () => {
    const service = await createService();
    const context = await service.readContext();

    expect(context.policy).toMatchObject({
      providerId: 'perchance-interactive',
      matureMode: 'off',
      matureModeActive: false,
      providerConsentGrantedAt: null,
      providerConsentCurrent: false,
      incognitoPersistence: 'never',
    });
    expect(context.primaryProvider).toMatchObject({ id: 'perchance-interactive', mode: 'interactive' });
    expect(context.emergencyProvider).toMatchObject({
      id: 'aihorde-anonymous',
      mode: 'emergency',
      activation: 'provider-error-or-explicit-user-action',
    });
    await expect(service.startGeneration({ prompt: 'quiet mountain lake' })).resolves.toMatchObject({
      status: 'blocked',
      reason: 'provider-consent-required',
      contentRating: 'safe',
    });
  });

  it('submits a direct anonymous AI Horde job without Oscar context', async () => {
    const service = await createService();
    await acceptProviderAgreement(service);

    const result = await service.startGeneration({
      prompt: 'quiet mountain lake',
      negativePrompt: 'text',
      style: 'photo',
      aspectRatio: '16:9',
      privacyMode: 'incognito',
    });

    expect(result).toMatchObject({
      status: 'queued',
      contentRating: 'safe',
      savePolicy: 'discard',
      providerId: 'aihorde-anonymous',
      providerLabel: 'AI Horde',
      sharedWithLaion: true,
      prompt: 'quiet mountain lake',
    });
  });

  it('prepares Perchance as a human-controlled primary provider without submitting AI Horde', async () => {
    let submitCalls = 0;
    const service = await createService({
      provider: createProvider({
        submit: async () => {
          submitCalls += 1;
          return { requestId: '12345678-1234-1234-1234-123456789abc', kudos: 0, message: null, warnings: [] };
        },
      }),
    });
    await acceptProviderAgreement(service);
    const draft = {
      providerId: 'perchance-interactive' as const,
      prompt: 'orange cat in a black car',
      negativePrompt: 'snow',
      style: 'photo' as const,
      aspectRatio: '16:9' as const,
      privacyMode: 'incognito' as const,
    };

    await expect(service.startGeneration(draft)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'perchance-adult-attestation-required',
    });
    await expect(service.updatePolicy({ action: 'perchance-access', enabled: true }))
      .rejects.toMatchObject({ code: 'perchance-adult-attestation-required' });
    await service.updatePolicy({ action: 'perchance-access', enabled: true, adultAttested: true });
    await expect(service.updatePolicy({ action: 'perchance-intro', enabled: true })).resolves.toMatchObject({
      providerIntroAcknowledgedAt: expect.any(String),
    });
    await expect(service.startGeneration(draft)).resolves.toMatchObject({
      status: 'interactive-ready',
      providerId: 'perchance-interactive',
      providerLabel: 'Perchance',
      privacyMode: 'incognito',
      prompt: 'orange cat in a black car',
      promptText: expect.stringContaining('Negative prompt: snow'),
      url: 'https://perchance.org/ai-text-to-image-generator',
    });
    expect(submitCalls).toBe(0);
  });

  it('requires current consent and the Perchance age attestation before acknowledging its introduction', async () => {
    const service = await createService();
    await expect(service.updatePolicy({ action: 'perchance-intro', enabled: true }))
      .rejects.toMatchObject({ code: 'perchance-intro-prerequisites-required' });
    await acceptProviderAgreement(service);
    await expect(service.updatePolicy({ action: 'perchance-intro', enabled: true }))
      .rejects.toMatchObject({ code: 'perchance-intro-prerequisites-required' });
    await service.updatePolicy({ action: 'perchance-access', enabled: true, adultAttested: true });
    const acknowledged = await service.updatePolicy({ action: 'perchance-intro', enabled: true });
    expect(acknowledged.providerIntroAcknowledgedAt).toEqual(expect.any(String));

    const revoked = await service.updatePolicy({ action: 'provider-consent', enabled: false });
    expect(revoked.providerIntroAcknowledgedAt).toBeNull();
  });

  it('requires the current agreement and both checkboxes before every provider submission', async () => {
    const service = await createService();
    await expect(service.updatePolicy({ action: 'provider-consent', enabled: true }))
      .rejects.toMatchObject({ code: 'provider-agreement-required' });
    await expect(service.updatePolicy({
      action: 'provider-consent',
      enabled: true,
      agreementVersion: 'stale-version',
      cloudProcessingAccepted: true,
      thirdPartyTermsAccepted: true,
    })).rejects.toMatchObject({ code: 'provider-agreement-required' });

    const accepted = await acceptProviderAgreement(service);
    expect(accepted).toMatchObject({
      providerConsentCurrent: true,
      providerAgreementVersion: IMAGE_PROVIDER_AGREEMENT_VERSION,
      providerAdultAttestedAt: null,
    });
    await expect(service.startGeneration({ prompt: 'first lake' })).resolves.toMatchObject({ status: 'queued' });
    await expect(service.startGeneration({ prompt: 'second lake' })).resolves.toMatchObject({ status: 'queued' });

    const revoked = await service.updatePolicy({ action: 'provider-consent', enabled: false });
    expect(revoked).toMatchObject({
      providerConsentCurrent: false,
      providerAgreementVersion: null,
      cloudProcessingAcceptedAt: null,
      thirdPartyTermsAcceptedAt: null,
      providerAdultAttestedAt: null,
    });
    await expect(service.startGeneration({ prompt: 'third lake' })).resolves.toMatchObject({
      status: 'blocked',
      reason: 'provider-consent-required',
    });
  });

  it('invalidates legacy Perchance consent after the provider/data-flow change', async () => {
    const service = await createService();
    const timestamp = '2030-01-01T00:00:00.000Z';
    await writeFile(path.join(service.root, 'policy.v1.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 7,
      providerId: 'perchance-interactive',
      providerConsentGrantedAt: timestamp,
      providerAgreementVersion: '2026-08-09.1',
      cloudProcessingAcceptedAt: timestamp,
      thirdPartyTermsAcceptedAt: timestamp,
      providerAdultAttestedAt: timestamp,
      matureMode: 'off',
      matureEnabledUntil: null,
      adultAttestedAt: null,
      incognitoPersistence: 'never',
      updatedAt: timestamp,
    }), 'utf8');

    expect((await service.readContext()).policy).toMatchObject({
      providerId: 'perchance-interactive',
      providerConsentGrantedAt: timestamp,
      providerConsentCurrent: false,
    });
    await expect(service.startGeneration({ prompt: 'legacy lake' })).resolves.toMatchObject({
      status: 'blocked',
      reason: 'provider-consent-required',
    });
  });

  it('classifies Oscar image intent without hijacking image-related coding work', async () => {
    const service = await createService();
    expect(service.readCapabilitySnapshot()).toMatchObject({
      available: true,
      surface: 'images',
      primaryProvider: { id: 'perchance-interactive', mode: 'interactive' },
      emergencyProvider: { id: 'aihorde-anonymous', mode: 'emergency' },
    });
    expect(looksLikeImageGenerationRequest('Создай фотореалистичное изображение горного озера')).toBe(true);
    expect(looksLikeImageGenerationRequest('Нарисуй кота в короне')).toBe(true);
    expect(looksLikeImageGenerationRequest('Создай сайт по этому изображению')).toBe(false);
    await expect(service.evaluateIntent('Объясни, как работает генерация изображений')).resolves.toMatchObject({
      isImageGeneration: false,
      disposition: 'not-image-generation',
      providerId: 'perchance-interactive',
    });
    await expect(service.evaluateIntent('Ты умеешь создавать картинки?')).resolves.toMatchObject({
      isImageGeneration: false,
      disposition: 'not-image-generation',
      providerId: 'perchance-interactive',
    });
    await expect(service.evaluateIntent('Создай изображение горного озера')).resolves.toMatchObject({
      isImageGeneration: true,
      contentRating: 'safe',
      disposition: 'provider-consent-required',
      providerId: 'perchance-interactive',
    });
  });

  it('requires mature mode plus an exact single-use confirmation for NSFW', async () => {
    const service = await createService();
    await acceptProviderAgreement(service);
    await expect(service.startGeneration({ prompt: 'adult erotic portrait' })).resolves.toMatchObject({
      status: 'blocked',
      reason: 'mature-mode-disabled',
    });
    await expect(service.updatePolicy({ action: 'mature-mode', mode: 'persistent' }))
      .rejects.toMatchObject({ code: 'adult-attestation-required' });
    await service.updatePolicy({ action: 'mature-mode', mode: 'persistent', adultAttested: true });

    const challenge = await service.startGeneration({ prompt: 'adult erotic portrait' });
    expect(challenge).toMatchObject({ status: 'confirmation-required', kind: 'nsfw-generation' });
    if (challenge.status !== 'confirmation-required') throw new Error('Expected mature challenge.');

    await expect(service.startGeneration({
      prompt: 'different adult erotic portrait',
      confirmationId: challenge.challengeId,
    })).resolves.toMatchObject({ status: 'confirmation-required' });
    const replacement = await service.startGeneration({ prompt: 'adult erotic portrait' });
    if (replacement.status !== 'confirmation-required') throw new Error('Expected replacement challenge.');
    await expect(service.startGeneration({
      prompt: 'adult erotic portrait',
      confirmationId: replacement.challengeId,
    })).resolves.toMatchObject({ status: 'queued', contentRating: 'nsfw' });
    await expect(service.startGeneration({
      prompt: 'adult erotic portrait',
      confirmationId: replacement.challengeId,
    })).resolves.toMatchObject({ status: 'confirmation-required' });
  });

  it('expires the one-hour mode and always blocks sexualized minor content', async () => {
    let now = Date.parse('2030-01-01T00:00:00.000Z');
    const service = await createService({ now: () => now });
    await service.updatePolicy({ action: 'mature-mode', mode: 'one-hour', adultAttested: true });
    expect((await service.readContext()).policy.matureModeActive).toBe(true);
    now += 60 * 60_000 + 1;
    expect((await service.readContext()).policy).toMatchObject({ matureMode: 'off', matureModeActive: false });
    expect(classifyImagePrompt('explicit sexual schoolgirl')).toBe('prohibited');
    await expect(service.startGeneration({ prompt: 'explicit sexual schoolgirl' })).resolves.toMatchObject({
      status: 'blocked',
      reason: 'prohibited-content',
    });
  });

  it('cancels an active NSFW job when mature mode expires and blocks direct NSFW reads', async () => {
    let now = Date.parse('2030-01-01T00:00:00.000Z');
    let cancelCalls = 0;
    const provider = createProvider({ cancel: async () => { cancelCalls += 1; } });
    const service = await createService({ now: () => now, provider });
    await acceptProviderAgreement(service);
    await service.updatePolicy({ action: 'mature-mode', mode: 'one-hour', adultAttested: true });
    const challenge = await service.startGeneration({ prompt: 'adult erotic portrait' });
    if (challenge.status !== 'confirmation-required') throw new Error('Expected mature challenge.');
    const started = await service.startGeneration({ prompt: 'adult erotic portrait', confirmationId: challenge.challengeId });
    if (started.status !== 'queued') throw new Error('Expected queued job.');

    const imported = await service.importImage({
      name: 'adult.png',
      mimeType: 'image/png',
      dataBase64: PNG_1X1,
      contentRating: 'nsfw',
      explicitSave: true,
    });
    now += 60 * 60_000 + 1;
    await expect(service.readGenerationJob(started.jobId)).resolves.toMatchObject({
      status: 'cancelled',
      error: { code: 'mature-mode-disabled' },
    });
    expect(cancelCalls).toBe(1);
    await expect(service.readImage(imported.id)).rejects.toMatchObject({ code: 'mature-mode-disabled' });
  });

  it('polls the provider, saves persistent results, and exposes the local asset', async () => {
    let now = Date.parse('2030-01-01T00:00:00.000Z');
    let checkCount = 0;
    const provider = createProvider({
      check: async () => {
        checkCount += 1;
        return checkCount === 1 ? providerCheck({ processing: 1, waiting: 0 }) : providerCheck({ done: true, finished: 1, waiting: 0 });
      },
      status: async () => providerStatus([pngResult()]),
    });
    const service = await createService({ now: () => now, provider });
    await acceptProviderAgreement(service);
    const started = await service.startGeneration({ prompt: 'persistent lake', privacyMode: 'persistent' });
    if (started.status !== 'queued') throw new Error('Expected queued job.');

    await expect(service.readGenerationJob(started.jobId)).resolves.toMatchObject({ status: 'processing' });
    now += 2_001;
    const completed = await service.readGenerationJob(started.jobId);
    expect(completed).toMatchObject({ status: 'completed', finishedCount: 1 });
    expect(completed.results[0]?.libraryRecordId).toMatch(/^image_/u);
    const asset = await service.readGenerationResult(started.jobId, 0);
    expect(asset.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect((await service.readContext()).library).toEqual([
      expect.objectContaining({ generationJobId: started.jobId, generationIndex: 0 }),
    ]);
  });

  it('keeps incognito discard results in memory only', async () => {
    const provider = createProvider({
      check: async () => providerCheck({ done: true, finished: 1, waiting: 0 }),
      status: async () => providerStatus([pngResult()]),
    });
    const service = await createService({ provider });
    await acceptProviderAgreement(service);
    const started = await service.startGeneration({ prompt: 'ephemeral lake', privacyMode: 'incognito' });
    if (started.status !== 'queued') throw new Error('Expected queued job.');
    const completed = await service.readGenerationJob(started.jobId);
    expect(completed).toMatchObject({ status: 'completed', savePolicy: 'discard' });
    expect((await service.readContext()).library).toHaveLength(0);
    await expect(service.readGenerationResult(started.jobId, 0)).resolves.toMatchObject({ mimeType: 'image/png' });

    const restarted = new ImageGenerationService(service.root, { provider });
    await expect(restarted.readGenerationJob(started.jobId)).rejects.toMatchObject({ code: 'generation-job-not-found' });
  });

  it('discards a provider result marked as CSAM', async () => {
    const provider = createProvider({
      check: async () => providerCheck({ done: true, finished: 1, waiting: 0 }),
      status: async () => providerStatus([{ ...pngResult(), state: 'csam', metadataTypes: ['csam'] }]),
    });
    const service = await createService({ provider });
    await acceptProviderAgreement(service);
    const started = await service.startGeneration({ prompt: 'safe landscape' });
    if (started.status !== 'queued') throw new Error('Expected queued job.');
    await expect(service.readGenerationJob(started.jobId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'provider-prohibited-result' },
      results: [],
    });
    expect((await service.readContext()).library).toHaveLength(0);
  });

  it('bounds concurrent anonymous jobs without imposing a lifetime quota', async () => {
    const service = await createService();
    await acceptProviderAgreement(service);
    await service.startGeneration({ prompt: 'job one' });
    await service.startGeneration({ prompt: 'job two' });
    await service.startGeneration({ prompt: 'job three' });
    await expect(service.startGeneration({ prompt: 'job four' })).rejects.toMatchObject({
      code: 'too-many-active-generations',
      statusCode: 429,
    });
  });

  it('validates imported image bytes and deletes exact records', async () => {
    const service = await createService();
    await expect(service.importImage({
      name: 'fake.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('<html>').toString('base64'),
    })).rejects.toBeInstanceOf(ImageGenerationServiceError);

    const record = await service.importImage({
      name: 'result.png',
      mimeType: 'image/png',
      dataBase64: PNG_1X1,
      contentRating: 'safe',
      privacyMode: 'incognito',
      explicitSave: true,
    });
    const asset = await service.readImage(record.id);
    expect((await readFile(asset.filePath)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await service.deleteImage(record.id);
    expect((await service.readContext()).library).toHaveLength(0);
  });
});

async function createService(options: { now?: () => number; provider?: AiHordeProviderLike } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-images-'));
  roots.push(root);
  return new ImageGenerationService(root, {
    ...(options.now ? { now: options.now } : {}),
    provider: options.provider || createProvider(),
  });
}

function acceptProviderAgreement(service: ImageGenerationService) {
  return service.updatePolicy({
    action: 'provider-consent',
    enabled: true,
    agreementVersion: IMAGE_PROVIDER_AGREEMENT_VERSION,
    cloudProcessingAccepted: true,
    thirdPartyTermsAccepted: true,
  });
}

function createProvider(overrides: Partial<AiHordeProviderLike> = {}): AiHordeProviderLike {
  return {
    submit: async () => ({ requestId: '12345678-1234-1234-1234-123456789abc', kudos: 0, message: null, warnings: [] }),
    check: async () => providerCheck({ waiting: 1 }),
    status: async () => providerStatus([]),
    cancel: async () => undefined,
    ...overrides,
  };
}

function providerCheck(overrides: Partial<Awaited<ReturnType<AiHordeProviderLike['check']>>> = {}) {
  return {
    finished: 0,
    processing: 0,
    restarted: 0,
    waiting: 0,
    done: false,
    faulted: false,
    waitTime: 0,
    queuePosition: 0,
    kudos: 0,
    isPossible: true,
    ...overrides,
  };
}

function providerStatus(generations: AiHordeGenerationResult[]) {
  return {
    ...providerCheck({ done: true, finished: generations.length }),
    shared: true,
    generations,
  };
}

function pngResult(): AiHordeGenerationResult {
  return {
    bytes: Buffer.from(PNG_1X1, 'base64'),
    mimeType: 'image/png',
    seed: '42',
    model: 'test-model',
    censored: false,
    state: 'ok',
    metadataTypes: [],
  };
}
