import { randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMaxSelection } from './max-selection.mjs';
import { restrictProtectedIntegrationAcl } from './protected-integration-acl.mjs';

const AGREEMENT = 'monarch.astra-max.groq-consent.2026-09-04.v1';
const MODEL_POLICY = 'monarch.astra-max.model-policy.2026-09-07.v2';
const MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];
const fail = (code) => { throw Error('astra-max-loader:' + code); };

/** Exact main-process loader shared by native desktop and isolated validation. */
export async function loadAstraMaxHost(options) {
  if (!['isolated-validation', 'source-preview', 'native-desktop'].includes(options?.deployment)) fail('deployment');
  const versionRoot = exactAbsolute(options.versionRoot, 'version-root');
  const dataRoot = exactAbsolute(options.dataRoot, 'data-root');
  if (within(versionRoot, dataRoot) || within(dataRoot, options.deployment === 'native-desktop'
    ? path.join(versionRoot, 'dist') : versionRoot)) fail('root-overlap');
  await exactDirectory(versionRoot, 'version-root');
  await exactDirectory(dataRoot, 'data-root');
  const bundlePath = path.join(versionRoot, 'dist', 'astra-max-electron.mjs');
  await exactFile(bundlePath, 'bundle-identity');
  let module;
  try { module = await import(pathToFileURL(bundlePath).href); }
  catch { fail('bundle-import'); }
  if (typeof module.AstraMaxSettingsStore !== 'function' || typeof module.AstraMaxHostService !== 'function'
    || typeof module.LocalModelPreferenceStore !== 'function' || typeof module.resolveMonarchRuntimePaths !== 'function'
    || typeof module.AstraMaxPreparedModelHost !== 'function'
    || typeof module.selectAstraMaxModel !== 'function' || typeof module.astraMaxModelLimits !== 'function'
    || module.ASTRA_MAX_MODEL_POLICY_VERSION !== MODEL_POLICY
    || module.ASTRA_MAX_PROVIDER_AGREEMENT_VERSION !== AGREEMENT
    || JSON.stringify(module.ASTRA_MAX_PRIMARY_MODELS) !== JSON.stringify(MODELS)) fail('bundle-contract');
  // MAX credentials have their own root. Chat/agent limits belong to the same
  // state root as the runtime child, not to that credential directory.
  const preferenceRoot = options.runtimeEnvironment
    ? module.resolveMonarchRuntimePaths(exactAbsolute(options.runtimeWorkspaceRoot ?? versionRoot, 'runtime-workspace-root'), options.runtimeEnvironment).stateRoot
    : path.join(dataRoot, 'runtime');
  const modelPreferences = new module.LocalModelPreferenceStore(preferenceRoot);
  const refreshLimits = () => modelPreferences.refreshLimits();
  const settingsRoot = path.join(dataRoot, 'integrations', 'astra-max');
  const restrictAccess = options.restrictAccess || restrictProtectedIntegrationAcl;
  const settings = new module.AstraMaxSettingsStore({ deployment: options.deployment, rootPath: settingsRoot,
    protectedStorage: options.safeStorage, restrictAccess,
    ...(options.now ? { now: options.now } : {}) });
  const host = new module.AstraMaxHostService({ deployment: options.deployment, settings,
    ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
  const globalSelection = createMaxSelection(settingsRoot);
  const cloudStores = new Map([['groq', settings]]);
  const cloud = new module.MaxCloudHost({ groq: host, store: id => {
    if (!cloudStores.has(id)) cloudStores.set(id, new module.AstraMaxSettingsStore({ deployment: options.deployment,
      rootPath: settingsRoot, providerId: id, protectedStorage: options.safeStorage, restrictAccess,
      ...(options.now ? { now: options.now } : {}) }));
    return cloudStores.get(id);
  }, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) });
  const preference = options.modelPreference ?? 'automatic';
  const selectedModelId = preference === 'qwen-3.8-27b' ? 'qwen/qwen3.8-27b' : 'openai/gpt-oss-120b';
  const maxOutputTokens = module.astraMaxModelLimits(selectedModelId).maxOutputTokens;
  const selection = module.selectAstraMaxModel({ preference,
    inputModality: 'text', providerToolsRequired: false, previewAcknowledged: options.previewAcknowledged === true,
    maxOutputTokens, reasoningEffort: 'high' });
  if (selection?.status !== 'accepted') fail('model-selection-' + String(selection?.code || 'invalid'));
  let selectedCloudRole = null;
  try {
    const selectedProvider = await globalSelection.read();
    const candidate = (await cloud.view()).find(item => item.id === selectedProvider && item.id !== 'groq' && item.state === 'ready');
    if (candidate) selectedCloudRole = candidate.role;
  } catch { /* A broken optional connection must not remove the native Groq host. */ }
  // Retain native bindings for persisted tasks and expose one selected cloud
  // identity in the descriptor. Other exact cloud roles are admitted
  // dynamically and rechecked against the encrypted connection at dispatch.
  const primaryModelId = selectedCloudRole ?? selection.modelId;
  const modelIds = [primaryModelId, ...module.ASTRA_MAX_PRIMARY_MODELS.filter(modelId => modelId !== primaryModelId)];
  const preparedModel = new module.AstraMaxPreparedModelHost({ deployment: options.deployment,
    refreshLimits,
    modelId: primaryModelId, modelIds, provider: host, cloudProvider: cloud,
    hostGeneration: 'astra_max_' + randomBytes(16).toString('hex'), ...(options.now ? { now: options.now } : {}),
    // Measurement override only; the host validates it and defaults to high.
    ...(process.env.MONARCH_MAX_REASONING_EFFORT ? { reasoningEffort: process.env.MONARCH_MAX_REASONING_EFFORT } : {}) });
  return Object.freeze({
    setupView: () => host.setupView(),
    providersView: () => cloud.view(),
    selectedProviderId: () => globalSelection.read(),
    selectProvider: async id => {
      const candidate = (await cloud.view()).find(p => p.id === id && p.state === 'ready');
      if (!candidate) throw Error('max-selection:unavailable');
      await globalSelection.write(id); return { providerId: id, role: candidate.role, modelId: candidate.model };
    },
    withSelectedConnection: async consume => {
      const id = await globalSelection.read();
      const candidate = (await cloud.view()).find(p => p.id === id && p.state === 'ready');
      if (!candidate) throw Error('max-selection:unavailable');
      const connection = await cloudStores.get(id).resolveConnection();
      return consume({ providerId: id, modelId: candidate.model, role: candidate.role, apiKey: connection.apiKey });
    },
    listProviderModels: input => cloud.models(input),
    listStoredProviderModels: id => cloud.storedModels(id),
    configureProvider: input => cloud.configure(input),
    updateProviderModel: input => cloud.updateModel(input),
    verifyProvider: id => cloud.verify(id),
    configure: (input) => host.configure(input),
    verifyConnection: () => host.verifyConnection(),
    completeNative: (input, signal) => {
      refreshLimits();
      return module.completeMaxNative({ proposePrepared: request => host.proposePrepared(request),
        proposeCloud: (request, signal) => cloud.propose(request, signal) }, input, signal);
    },
    streamNative: async function* (input, signal) {
      refreshLimits();
      yield* module.streamMaxNative({ proposePrepared: request => host.proposePrepared(request),
        proposeCloud: (request, signal) => cloud.propose(request, signal),
        streamCloud: (request, signal) => cloud.streamText(request, signal) }, input, signal);
    },
    decideRead: (input) => host.decideRead(input),
    preparedModelHost: () => { if (!preparedModel) fail('prepared-host-unavailable'); return preparedModel; },
    setReasoningEffort: value => { preparedModel.setReasoningEffort(value); cloud.setReasoningEffort(value); },
  });
}

function exactAbsolute(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 1024) fail(code);
  return path.resolve(value);
}
async function exactDirectory(value, code) {
  const info = await lstat(value).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(code);
  if (!samePath(await realpath(value), value)) fail(code);
}
async function exactFile(value, code) {
  const info = await lstat(value).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 50_000 || info.size > 2 * 1024 * 1024) fail(code);
  if (!samePath(await realpath(value), value)) fail(code);
}
function samePath(left, right) {
  return path.resolve(left).replace(/[\\/]+$/u, '').toLowerCase()
    === path.resolve(right).replace(/[\\/]+$/u, '').toLowerCase();
}
function within(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
