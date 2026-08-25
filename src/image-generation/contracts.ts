export type ImageContentRatingV1 = 'safe' | 'nsfw' | 'unknown';

export type ImageMatureModeV1 = 'off' | 'one-hour' | 'persistent';

export type IncognitoImagePersistenceV1 = 'never' | 'ask' | 'always';

export type ImageGenerationProviderIdV1 = 'aihorde-anonymous' | 'perchance-interactive';

export type ImageGenerationIntentDispositionV1 =
  | 'not-image-generation'
  | 'ready'
  | 'provider-consent-required'
  | 'perchance-adult-attestation-required'
  | 'confirmation-required'
  | 'mature-mode-disabled'
  | 'prohibited-content';

export type ImageGenerationJobStatusV1 = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ImageGenerationPolicyV1 {
  schemaVersion: 1;
  revision: number;
  providerId: 'perchance-interactive';
  providerConsentGrantedAt: string | null;
  providerAgreementVersion: string | null;
  cloudProcessingAcceptedAt: string | null;
  thirdPartyTermsAcceptedAt: string | null;
  providerAdultAttestedAt: string | null;
  providerIntroAcknowledgedAt: string | null;
  matureMode: ImageMatureModeV1;
  matureEnabledUntil: string | null;
  adultAttestedAt: string | null;
  incognitoPersistence: IncognitoImagePersistenceV1;
  updatedAt: string;
}

export interface ImageGenerationPolicySnapshotV1 extends ImageGenerationPolicyV1 {
  providerConsentCurrent: boolean;
  providerAgreementCurrentVersion: string;
  matureModeActive: boolean;
  matureModeRemainingMs: number | null;
}

export interface ImageGenerationDraftV1 {
  prompt: string;
  providerId?: ImageGenerationProviderIdV1;
  negativePrompt?: string;
  style?: string;
  aspectRatio?: string;
  count?: number;
  seed?: string;
  privacyMode?: 'persistent' | 'incognito';
  confirmationId?: string;
}

export interface ImageGenerationChallengeV1 {
  schemaVersion: 1;
  status: 'confirmation-required';
  challengeId: string;
  kind: 'nsfw-generation';
  expiresAt: string;
  contentRating: 'nsfw';
  summary: string;
}

export interface ImageGenerationBlockedV1 {
  schemaVersion: 1;
  status: 'blocked';
  reason:
    | 'provider-consent-required'
    | 'perchance-adult-attestation-required'
    | 'mature-mode-disabled'
    | 'prohibited-content';
  contentRating: ImageContentRatingV1;
}

export interface ImageGenerationInteractiveHandoffV1 {
  schemaVersion: 1;
  status: 'interactive-ready';
  providerId: 'perchance-interactive';
  providerLabel: 'Perchance';
  contentRating: ImageContentRatingV1;
  privacyMode: 'persistent' | 'incognito';
  prompt: string;
  promptText: string;
  url: string;
}

export interface ImageGenerationResultV1 {
  schemaVersion: 1;
  index: number;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  seed: string;
  model: string;
  libraryRecordId: string | null;
  available: boolean;
}

export interface ImageGenerationJobSnapshotV1 {
  schemaVersion: 1;
  status: ImageGenerationJobStatusV1;
  jobId: string;
  providerId: 'aihorde-anonymous';
  providerLabel: 'AI Horde';
  contentRating: ImageContentRatingV1;
  privacyMode: 'persistent' | 'incognito';
  savePolicy: 'save' | 'ask' | 'discard';
  prompt: string;
  requestedCount: number;
  queuePosition: number;
  waitTimeSeconds: number;
  finishedCount: number;
  processingCount: number;
  waitingCount: number;
  sharedWithLaion: true;
  results: ImageGenerationResultV1[];
  warnings: string[];
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export type ImageGenerationPreparationV1 =
  | ImageGenerationJobSnapshotV1
  | ImageGenerationInteractiveHandoffV1
  | ImageGenerationChallengeV1
  | ImageGenerationBlockedV1;

export interface ImageLibraryRecordV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  sha256: string;
  contentRating: ImageContentRatingV1;
  prompt: string;
  providerId: 'aihorde-anonymous' | 'perchance-interactive' | 'import';
  generationJobId: string | null;
  generationIndex: number | null;
  privacyMode: 'persistent' | 'incognito';
  createdAt: string;
}

export interface ImageGenerationManualFallbackV1 {
  id: 'perchance-interactive';
  label: 'Perchance';
  mode: 'interactive';
  url: string;
}

export interface ImageGenerationEmergencyProviderV1 {
  id: 'aihorde-anonymous';
  label: 'AI Horde';
  mode: 'emergency';
  activation: 'provider-error-or-explicit-user-action';
}

export interface ImageGenerationCapabilitySnapshotV1 {
  schemaVersion: 1;
  available: true;
  surface: 'images';
  primaryProvider: ImageGenerationManualFallbackV1;
  emergencyProvider: ImageGenerationEmergencyProviderV1;
}

export interface ImageGenerationContextV1 {
  schemaVersion: 1;
  policy: ImageGenerationPolicySnapshotV1;
  library: ImageLibraryRecordV1[];
  jobs: ImageGenerationJobSnapshotV1[];
  primaryProvider: ImageGenerationManualFallbackV1;
  emergencyProvider: ImageGenerationEmergencyProviderV1;
  /** @deprecated Kept for v1 client compatibility. Use primaryProvider. */
  manualFallback: ImageGenerationManualFallbackV1;
}

export interface ImageGenerationIntentV1 {
  schemaVersion: 1;
  isImageGeneration: boolean;
  prompt: string;
  contentRating: ImageContentRatingV1;
  disposition: ImageGenerationIntentDispositionV1;
  providerId: 'perchance-interactive';
}
