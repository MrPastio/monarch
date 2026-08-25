export type MonarchMemoryScopeV1 =
  | { type: 'chat' }
  | { type: 'coder-project'; projectId: string };

export type MonarchSettingsKindV1 = 'memory' | 'profile' | 'personality' | 'voice' | 'prompts' | 'dev' | 'owner-override';

export type MonarchSettingsCommandV1 =
  | 'memory.create'
  | 'memory.update'
  | 'memory.delete'
  | 'memory.restore'
  | 'memory.cross-chat.set'
  | 'profile.update'
  | 'personality.profile.create'
  | 'personality.profile.update'
  | 'personality.profile.select'
  | 'personality.personalization.set'
  | 'personality.scope.copy'
  | 'voice.update'
  | 'voice.preset.create'
  | 'voice.preset.update'
  | 'voice.preset.delete'
  | 'voice.pronunciation.create'
  | 'voice.pronunciation.update'
  | 'voice.pronunciation.delete'
  | 'prompts.update'
  | 'prompts.reset'
  | 'prompts.reset-all'
  | 'dev.update'
  | 'dev.reset'
  | 'owner-override.update'
  | 'owner-override.reset';

export interface MonarchOwnerDevSettingsV1 {
  schemaVersion: 1;
  zeroRetentionEnabled: boolean;
  internetEnabled: boolean;
  memoryEnabled: boolean;
  historyContextEnabled: boolean;
  personalityEnabled: boolean;
  skillsEnabled: boolean;
  runtimeContextEnabled: boolean;
  qualityRegenerationEnabled: boolean;
  updatedAt: string;
  diagnostic?: string;
}

export type MonarchPersonalityVariantV2 = 'restrained' | 'direct' | 'lively';
export type MonarchPersonalityAddressV2 = 'ты' | 'вы' | 'neutral';
export type MonarchPersonalityLanguageV2 = 'auto' | 'ru' | 'en' | 'uk' | 'bg';

export interface MonarchPersonalityDimensionsV2 {
  brevity: number;
  warmth: number;
  directness: number;
  initiative: number;
  humor: number;
  skepticism: number;
  technicalDepth: number;
  structure: number;
}

export interface PersonalityProfileV2 {
  schemaVersion: 2;
  id: string;
  variant: MonarchPersonalityVariantV2;
  name: string;
  revision: number;
  contentHash: string;
  dimensions: MonarchPersonalityDimensionsV2;
  addressForm: MonarchPersonalityAddressV2;
  language: MonarchPersonalityLanguageV2;
  customRules: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PersonalityVariantSetV1 {
  schemaVersion: 2;
  enabled: boolean;
  selectedProfileId: string | null;
  questionnaire: MonarchPersonalityDimensionsV2 & {
    addressForm: MonarchPersonalityAddressV2;
    language: MonarchPersonalityLanguageV2;
  };
  profiles: [PersonalityProfileV2, PersonalityProfileV2, PersonalityProfileV2] | PersonalityProfileV2[];
  createdAt: string;
  updatedAt: string;
}

export interface MonarchPersonalityContextV2 {
  schemaVersion: 2;
  profileId: string;
  profileRevision: number;
  profileHash: string;
  variant: MonarchPersonalityVariantV2;
  name: string;
  dimensions: MonarchPersonalityDimensionsV2;
  addressForm: MonarchPersonalityAddressV2;
  language: MonarchPersonalityLanguageV2;
  customRules: string[];
}

export type MonarchVoiceIdV2 = 'oscar' | 'oscar-clear' | 'aurora';
export type MonarchVoiceStyleV2 = 'natural' | 'calm' | 'warm' | 'focused' | 'energetic';

export interface VoiceTuningV2 {
  voice: MonarchVoiceIdV2;
  style: MonarchVoiceStyleV2;
  speed: number;
  pitch: number;
  expressiveness: number;
  pauseMs: number;
  volume: number;
  instruction: string;
  activePresetId: string | null;
}

export interface VoicePresetV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  preferences: Omit<VoiceTuningV2, 'activePresetId'>;
  createdAt: string;
  updatedAt: string;
}

export interface VoicePronunciationRuleV1 {
  schemaVersion: 1;
  id: string;
  word: string;
  pronunciation: string;
  context: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceInputPreferencesV1 {
  schemaVersion: 1;
  autoSendAfterDictation: boolean;
}

export interface VoicePreferencesV2 {
  schemaVersion: 2;
  preferences: VoiceTuningV2;
  presets: VoicePresetV2[];
  pronunciations: VoicePronunciationRuleV1[];
  input: VoiceInputPreferencesV1;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceRuntimeCapabilitiesV1 {
  schemaVersion: 1;
  platform: string;
  primaryEngine: 'qwen3-tts-0.6b-base' | 'windows-sapi' | 'unavailable';
  neuralInstalled: boolean;
  modelVariant: 'base' | 'custom-voice' | 'voice-design' | 'none';
  instructionControlled: boolean;
  stressAnalyzer: 'silero-stress-1.4' | 'unavailable';
  stressAccentor: 'silero-stress-1.4' | 'unavailable';
  pronunciationControl: 'engine-native' | 'unavailable';
  pronunciationDiagnostic: 'qwen-base-stress-markup-unsupported' | 'voice-engine-unavailable';
  controls: {
    speed: 'dsp' | 'unavailable';
    pitch: 'dsp' | 'unavailable';
    volume: 'audio-gain' | 'system' | 'unavailable';
    pause: 'audio-pipeline' | 'unavailable';
    expressiveness: 'generation-parameters' | 'unavailable';
    freeFormInstruction: boolean;
  };
}

export interface MonarchSettingsReadRequestV1 {
  schemaVersion: 1;
  kind: MonarchSettingsKindV1;
  scope: MonarchMemoryScopeV1;
}

export interface MonarchSettingsReadResultV1 {
  schemaVersion: 1;
  kind: MonarchSettingsKindV1;
  scope: MonarchMemoryScopeV1;
  revision: number;
  contentHash: string;
  value: unknown;
}

export interface MonarchSettingsCommandRequestV1 {
  schemaVersion: 1;
  clientRequestId: string;
  command: MonarchSettingsCommandV1;
  scope: MonarchMemoryScopeV1;
  expectedRevision: number;
  payload: Record<string, unknown>;
}

export interface MonarchSettingsWriteReceiptV1 {
  schemaVersion: 1;
  receiptId: string;
  clientRequestId: string;
  command: MonarchSettingsCommandV1;
  scope: MonarchMemoryScopeV1;
  revision: number;
  contentHash: string;
  readBackHash: string;
  policyDecisionHash: string;
  committedAt: string;
  replayed: boolean;
  result: unknown;
}

export interface MonarchSettingsBackend {
  read(request: MonarchSettingsReadRequestV1): Promise<MonarchSettingsReadResultV1>;
  execute(
    request: MonarchSettingsCommandRequestV1 & { policyDecisionHash: string },
  ): Promise<MonarchSettingsWriteReceiptV1>;
}

export interface MonarchSettingsCommandPolicy {
  evaluateLocalSettingsCommand(input: {
    source: 'desktop';
    command: MonarchSettingsCommandV1;
    scope: MonarchMemoryScopeV1;
    payload: unknown;
  }): {
    outcome: 'allow' | 'deny';
    reason: string;
    policyDecisionHash: string;
  };
}
