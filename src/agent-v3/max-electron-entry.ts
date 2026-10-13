// Dedicated Electron-main bundle surface. Keep credentials and settings behind
// this host-only entry; renderer/preload must receive only explicit view DTOs.
export { AstraMaxHostService, type AstraMaxSetupView } from './max-host-service';
export { AstraMaxPreparedModelHost, AstraMaxPreparedModelHostError } from './max-prepared-model-host';
export { AstraMaxSettingsStore, AstraMaxSettingsError, type AstraMaxProtectedStorage,
  type AstraMaxSettingsStatus } from './max-settings-store';
export { ASTRA_MAX_FIRST_USE_DISCLOSURE, ASTRA_MAX_PROVIDER_AGREEMENT_VERSION,
  ASTRA_MAX_PRIMARY_MODELS, ASTRA_MAX_PROVIDER_ID, ASTRA_MAX_SAFETY_MODEL, ASTRA_MAX_MODEL_LIMITS,
  astraMaxModelLimits, astraMaxPreparedModelDigest } from './max-provider-contract';
export { ASTRA_MAX_MODEL_POLICY_VERSION, selectAstraMaxModel } from './max-model-policy';
export { completeMaxNative, streamMaxNative } from './max-native-completion';

export { MaxCloudHost } from './max-cloud-host';
export { MAX_CLOUD_PROVIDERS, MAX_CLOUD_AGREEMENT } from './max-cloud-catalog';
export { LocalModelPreferenceStore } from '../settings/model-preference';
export { resolveMonarchRuntimePaths } from '../core/runtime-paths';
