import { loadAstraMaxHost } from './astra-max-host-loader.mjs';

export const ASTRA_MAX_SOURCE_PREVIEW_SWITCH = '--astra-max-preview';
export const ASTRA_MAX_QWEN_PREVIEW_SWITCH = '--astra-max-qwen-preview';
export const ASTRA_MAX_SOURCE_PREVIEW_MODE = 'source-preview-v1';

const MODEL_CHOICES = Object.freeze([
  Object.freeze({ id: 'gpt-oss-120b', label: 'GPT OSS 120B', detail: 'Для самых сложных задач', preview: false }),
]);

export function resolveAstraMaxSourcePreviewMode({ argv, isPackaged, isolatedMode = false }) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw Error('astra-max-desktop:argv');
  }
  return !isPackaged && !isolatedMode && argv.includes(ASTRA_MAX_SOURCE_PREVIEW_SWITCH)
    ? ASTRA_MAX_SOURCE_PREVIEW_MODE
    : null;
}

export function resolveAstraMaxSourceModelSelection({ argv, previewMode }) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw Error('astra-max-desktop:argv');
  }
  if (previewMode !== ASTRA_MAX_SOURCE_PREVIEW_MODE) {
    return Object.freeze({ preference: 'automatic', previewAcknowledged: false });
  }
  return Object.freeze({ preference: 'automatic', previewAcknowledged: false });
}

/**
 * Main-process-only connection surface. It deliberately exposes neither the
 * protected store nor model execution to the renderer. Task routing gets a
 * separate authority-bearing bridge after its own acceptance gate.
 */
export function createAstraMaxDesktopBridge(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options');
  if (![null, ASTRA_MAX_SOURCE_PREVIEW_MODE, 'native-desktop'].includes(options.mode)) fail('mode');
  if (typeof options.versionRoot !== 'string' || typeof options.dataRoot !== 'string') fail('roots');
  const now = options.now || Date.now;
  const loadHost = options.loadHost || loadAstraMaxHost;
  if (typeof now !== 'function' || typeof loadHost !== 'function') fail('dependencies');
  const modelSelection = options.modelSelection || { preference: 'automatic', previewAcknowledged: false };
  if (!modelSelection || typeof modelSelection !== 'object' || Array.isArray(modelSelection)
    || Object.keys(modelSelection).length !== 2
    || !['automatic', 'gpt-oss-120b'].includes(modelSelection.preference)
    || typeof modelSelection.previewAcknowledged !== 'boolean'
    || modelSelection.preference === 'qwen-3.8-27b' && modelSelection.previewAcknowledged !== true
    || modelSelection.preference !== 'qwen-3.8-27b' && modelSelection.previewAcknowledged !== false) fail('model-selection');
  let pendingHost = null;
  // The person's reasoning depth for MAX agent decisions; applied when the host loads.
  let agentReasoningEffort;

  const host = async () => {
    if (options.mode === null) return null;
    if (!pendingHost) {
      pendingHost = Promise.resolve(loadHost({
        deployment: options.mode === 'native-desktop' ? 'native-desktop' : 'source-preview',
        versionRoot: options.versionRoot,
        dataRoot: options.dataRoot,
        runtimeEnvironment: options.runtimeEnvironment,
        runtimeWorkspaceRoot: options.runtimeWorkspaceRoot,
        safeStorage: options.safeStorage,
        modelPreference: modelSelection.preference,
        previewAcknowledged: modelSelection.previewAcknowledged,
        now,
      })).then(loaded => {
        if (agentReasoningEffort) loaded.setReasoningEffort?.(agentReasoningEffort);
        return loaded;
      }).catch(error => {
        pendingHost = null;
        throw error;
      });
    }
    return pendingHost;
  };

  const bridge = {
    providers: async () => {
      if (options.mode === null) return { available: false, providers: [] };
      try { return { available: true, providers: await (await host()).providersView(), selectedProviderId: await (await host()).selectedProviderId() }; }
      catch { return { available: false, providers: [], detail: 'Не удалось открыть подключения. Попробуй ещё раз.' }; }
    },
    selectProvider: async id => {
      if (options.mode === null || typeof id !== 'string') return { ok: false, detail: 'Подключи провайдер MAX.' };
      try {
        await options.beforeSelectionChange?.();
        await (await host()).selectProvider(id);
        const warning = await options.afterSelectionChange?.();
        return { ok: true, available: true, providers: await (await host()).providersView(), selectedProviderId: id, ...(warning ? { warning } : {}) };
      }
      catch { return { ok: false, detail: 'Не удалось выбрать подключение. Прежний выбор сохранён.' }; }
    },
    listProviderModels: async input => {
      if (options.mode === null || !input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['providerId', 'apiKey'].includes(key))
        || typeof input.providerId !== 'string' || typeof input.apiKey !== 'string'
        || !/^[\x21-\x7e]{20,512}$/u.test(input.apiKey)) return { ok: false, detail: 'Сначала вставь ключ сервиса.' };
      try { return { ok: true, models: await (await host()).listProviderModels(input) }; }
      catch (error) { return { ok: false, detail: /credential/.test(String(error?.message))
        ? 'Сервис не принял ключ. Проверь его и попробуй снова.' : 'Не удалось загрузить список. Попробуй ещё раз.' }; }
    },
    listStoredProviderModels: async id => {
      if (options.mode === null || typeof id !== 'string' || !/^[a-z]{2,20}$/.test(id)) {
        return { ok: false, detail: 'Сначала подключи сервис.' };
      }
      try { return { ok: true, models: await (await host()).listStoredProviderModels(id) }; }
      catch (error) { return { ok: false, detail: storedCatalogErrorText(error) }; }
    },
    configureProvider: async input => {
      const normalized = normalizeSetup(input && { apiKey: input.apiKey, acknowledgements: input.acknowledgements });
      if (!normalized || options.mode === null || !input || Object.keys(input).some(key => !['apiKey', 'acknowledgements', 'providerId', 'modelId'].includes(key))
        || typeof input.providerId !== 'string' || typeof input.modelId !== 'string') return { ok: false, detail: 'Вставь ключ и подтверди три пункта.' };
      try {
        await options.beforeSelectionChange?.();
        const providers = await (await host()).configureProvider({ providerId: input.providerId, modelId: input.modelId,
          apiKey: normalized.apiKey, consent: { agreementVersion: 'monarch.max.providers.2026-09-07.v1', providerId: input.providerId,
            acceptedAt: new Date(currentTime(now)).toISOString(), nonLocalProcessingAcknowledged: true,
            selectedContextAcknowledged: true, providerTermsAcknowledged: true } });
        await (await host()).selectProvider(input.providerId);
        const warning = await options.afterSelectionChange?.();
        return { ok: true, available: true, providers, selectedProviderId: input.providerId, ...(warning ? { warning } : {}) };
      } catch (error) { return { ok: false, detail: providerErrorText(error) }; }
    },
    updateProviderModel: async input => {
      if (options.mode === null || !input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['providerId', 'modelId'].includes(key))
        || typeof input.providerId !== 'string' || typeof input.modelId !== 'string'
        || !/^[a-z]{2,20}$/.test(input.providerId)
        || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/u.test(input.modelId)) {
        return { ok: false, detail: 'Выбери модель из списка.' };
      }
      try {
        const selected = await (await host()).selectedProviderId();
        const affectsSelection = selected === input.providerId;
        if (affectsSelection) await options.beforeSelectionChange?.();
        const providers = await (await host()).updateProviderModel({ providerId: input.providerId, modelId: input.modelId });
        const warning = affectsSelection ? await options.afterSelectionChange?.() : undefined;
        return { ok: true, available: true, providers, selectedProviderId: selected, ...(warning ? { warning } : {}) };
      } catch (error) { return { ok: false, detail: providerErrorText(error) }; }
    },
    setReasoningEffort: async value => {
      if (![undefined, null, 'low', 'medium', 'high'].includes(value)) return { ok: false };
      agentReasoningEffort = value || undefined;
      if (options.mode === null || !pendingHost) return { ok: true };
      try { (await host()).setReasoningEffort?.(agentReasoningEffort); return { ok: true }; }
      catch { return { ok: true }; }
    },
    verifyProvider: async id => {
      if (options.mode === null || typeof id !== 'string') return { ok: false, detail: 'Выбери сервис.' };
      try { return { ok: true, available: true, providers: await (await host()).verifyProvider(id) }; }
      catch (error) { return { ok: false, detail: providerErrorText(error) }; }
    },
    verify: async () => {
      if (options.mode === null) return offView();
      try { return readyView(await (await host()).verifyConnection()); }
      catch (error) { return unavailableView(error); }
    },
    status: async () => {
      if (options.mode === null) return offView();
      try { return readyView(await (await host()).setupView()); }
      catch { return unavailableView(); }
    },
    configure: async (input) => {
      if (options.mode === null) return offView();
      const normalized = normalizeSetup(input);
      if (!normalized) return inputView();
      try {
        const acceptedAt = new Date(currentTime(now)).toISOString();
        await options.beforeSelectionChange?.();
        const view = await (await host()).configure({
          apiKey: normalized.apiKey,
          consent: {
            agreementVersion: 'monarch.astra-max.groq-consent.2026-09-04.v1',
            providerId: 'groq',
            acceptedAt,
            nonLocalProcessingAcknowledged: true,
            selectedContextAcknowledged: true,
            providerTermsAcknowledged: true,
          },
        });
        const warning = await options.afterSelectionChange?.();
        return { ...readyView(view), ...(warning ? { warning } : {}) };
      } catch (error) { return unavailableView(error); }
    },
  };
  // Main-process-only and deliberately non-enumerable. preload exposes neither
  // this method nor the object it returns.
  Object.defineProperty(bridge, 'withSelectedConnection', { enumerable: false, value: async consume => {
    if (options.mode === null || typeof consume !== 'function') fail('mode');
    return (await host()).withSelectedConnection(consume);
  } });
  Object.defineProperty(bridge, 'preparedModelHost', { enumerable: false, value: async () => {
      if (options.mode === null) fail('mode');
      return (await host()).preparedModelHost();
    } });
  Object.defineProperty(bridge, 'streamNative', { enumerable: false, value: async function* (input, signal) {
    if (options.mode === null) fail('mode');
    yield* (await host()).streamNative(input, signal);
  } });
  Object.defineProperty(bridge, 'completeNative', { enumerable: false, value: async (input, signal) => {
    if (options.mode === null) fail('mode');
    return (await host()).completeNative(input, signal);
  } });
  return Object.freeze(bridge);
}

function normalizeSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => key !== 'apiKey' && key !== 'acknowledgements')) return null;
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const checks = value.acknowledgements;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)
    || Object.keys(checks).some(key => !['nonLocalProcessing', 'selectedContext', 'providerTerms'].includes(key))
    || checks.nonLocalProcessing !== true || checks.selectedContext !== true || checks.providerTerms !== true
    || !/^[\x21-\x7e]{20,512}$/u.test(apiKey)) return null;
  return { apiKey };
}

function readyView(view) {
  const state = ['ready', 'not-configured', 'corrupt', 'unavailable'].includes(view?.state)
    ? view.state : 'unavailable';
  const source = state === view?.state ? view : unavailableView();
  const connectionVerified = state === 'ready' && source.connectionVerified === true;
  return Object.freeze({
    available: true,
    state,
    connectionVerified,
    title: state === 'ready' ? connectionVerified ? 'MAX готов' : 'Ключ MAX сохранён'
      : safeText(source.title, 'Подключи MAX'),
    detail: state === 'ready' ? connectionVerified
      ? 'Подключение проверено. MAX можно использовать для новых задач.' : 'Доступ проверится при первой задаче.'
      : safeText(source.detail, 'Monarch поможет подключить MAX.'),
    nextAction: ['none', 'connect', 'reconnect', 'retry'].includes(source.nextAction) ? source.nextAction : 'retry',
    models: Array.isArray(source.availableModels) ? MODEL_CHOICES.filter(model => source.availableModels.includes(
      model.id === 'gpt-oss-120b' ? 'openai/gpt-oss-120b' : 'qwen/qwen3.8-27b')) : MODEL_CHOICES,
  });
}

function offView() {
  return Object.freeze({ available: false, state: 'off', title: 'MAX пока не включён',
    connectionVerified: false, detail: 'Этот режим доступен только в отдельной тестовой сессии Monarch.',
    nextAction: 'none', models: MODEL_CHOICES });
}
function unavailableView(error) {
  const code = String(error?.code || error?.message || '');
  const detail = /credential|authentication/u.test(code)
    ? 'Groq не принял ключ. Проверь его или создай новый в кабинете Groq.'
    : /rate-limit/u.test(code) ? 'Groq временно ограничил запросы. Подожди и проверь подключение снова.'
      : /model.*(?:unavailable|available)/u.test(code) ? 'Для этого ключа доступны не все нужные модели. Проверь доступ к моделям в Groq.'
        : 'Не удалось подготовить MAX. Проверь интернет и попробуй ещё раз.';
  return Object.freeze({ available: true, state: 'unavailable', title: 'MAX временно недоступен',
    connectionVerified: false, detail,
    nextAction: 'retry', models: MODEL_CHOICES });
}
function inputView() {
  return Object.freeze({ available: true, state: 'not-configured', title: 'Проверь подключение',
    connectionVerified: false, detail: 'Введи ключ и подтверди все три пункта.',
    nextAction: 'connect', models: MODEL_CHOICES });
}
function safeText(value, fallback) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 ? value : fallback;
}
function currentTime(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail('time');
  return value;
}
function fail(code) { throw Error('astra-max-desktop:' + code); }

function providerErrorText(error) {
  const code = String(error?.code || error?.message || '');
  if (/credential|authentication/.test(code)) return 'Сервис не принял ключ. Скопируй его заново или создай новый.';
  if (/rate-limit|quota/.test(code)) return 'У сервиса закончился лимит или баланс. Проверь его в своём кабинете.';
  if (/model-retired/.test(code)) return 'Для этого сервиса модель в MAX фиксирована.';
  if (/not-configured/.test(code)) return 'Сначала подключи сервис.';
  if (/model|schema|request-rejected/.test(code)) return 'Эта модель пока не ответила в нужном формате. Выбери другую модель из списка.';
  if (/encryption|access-denied|protected/.test(code)) return 'Не получилось защитить ключ на этом компьютере. Подключение не изменено.';
  return 'Не получилось подключиться. Проверь интернет и попробуй снова. Прежний ключ сохранён.';
}
function storedCatalogErrorText(error) {
  const code = String(error?.code || error?.message || '');
  if (/not-configured/.test(code)) return 'Сначала подключи сервис.';
  if (/credential|authentication/.test(code)) return 'Сервис не принял сохранённый ключ. Открой «Настроить» и вставь ключ заново.';
  return 'Не удалось загрузить список. Попробуй ещё раз.';
}
