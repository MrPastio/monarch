import {
  cancelImageGenerationJob,
  deleteImageLibraryRecord,
  fetchImageGenerationContext,
  fetchImageGenerationJob,
  fetchImageGenerationResult,
  fetchImageProviderAgreement,
  fetchImageLibraryAsset,
  importImageToLibrary,
  prepareImageGeneration,
  saveImageGenerationResults,
  translateImagePrompt,
  updateImageGenerationPolicy,
} from './api.js';
import { MonarchGenesisField } from './monarch-genesis-field.js';
import { escapeHtml, readErrorMessage } from './utils.js';

let context = null;
let loadPromise = null;
let activeTab = 'perchance';
let nsfwVisible = false;
let latestProvider = null;
let genesisField = null;
let reservedBrowserProviderWindow = null;
let emergencyProviderAvailable = false;
let embeddedProviderConnected = false;
let embeddedProviderResizeObserver = null;
let embeddedProviderStateUnsubscribe = null;
let embeddedProviderDownloadUnsubscribe = null;
let embeddedProviderBoundsFrame = 0;
let providerAgreement = null;
let providerAgreementPromise = null;
let activeJob = null;
let generationWatchToken = 0;
let activeResultIndex = 0;
let activePreviewUrl = '';
const galleryObjectUrls = new Map();

export function initImageGenerationPane() {
  const root = document.querySelector('#images-section');
  if (!root) return;
  genesisField = new MonarchGenesisField(document.querySelector('#monarch-genesis-field'));
  root.querySelectorAll('[data-images-tab]').forEach((button) => {
    button.addEventListener('click', () => selectImagesTab(button.dataset.imagesTab));
  });
  document.querySelector('#image-generation-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitImageGeneration();
  });
  document.querySelector('#image-prompt')?.addEventListener('input', (event) => {
    const count = document.querySelector('#image-prompt-count');
    if (count) count.textContent = String(event.currentTarget.value.length);
  });
  document.querySelector('#image-aspect-ratio')?.addEventListener('change', syncImageAspectRatio);
  document.querySelector('#image-provider-open-again')?.addEventListener('click', () => void openProvider(latestProvider));
  document.querySelector('#image-manual-fallback')?.addEventListener('click', () => void openManualFallback());
  document.querySelector('#image-perchance-connect')?.addEventListener('click', () => void openEmbeddedPerchance({ requestAccess: true }));
  document.querySelector('#image-perchance-back')?.addEventListener('click', () => void navigateEmbeddedPerchance('back'));
  document.querySelector('#image-perchance-reload')?.addEventListener('click', () => void navigateEmbeddedPerchance('reload'));
  document.querySelector('#image-perchance-zoom')?.addEventListener('change', () => void openEmbeddedPerchance({ requestAccess: false }));
  document.querySelector('#image-perchance-translate')?.addEventListener('click', () => void translatePerchancePrompt());
  document.querySelector('#image-perchance-copy')?.addEventListener('click', () => void copyPerchancePrompt());
  document.querySelector('#image-perchance-external')?.addEventListener('click', () => void openPerchanceExternally());
  document.querySelector('#image-perchance-unavailable')?.addEventListener('click', () => {
    revealEmergencyProvider('Perchance отмечен как недоступный. Открыт аварийный AI Horde.');
    selectImagesTab('create');
  });
  document.querySelector('#image-generation-cancel')?.addEventListener('click', () => void cancelActiveGeneration());
  document.querySelector('#image-generation-save')?.addEventListener('click', () => void saveActiveGeneration());
  document.querySelector('#image-result-prev')?.addEventListener('click', () => void showGenerationResult(activeResultIndex - 1));
  document.querySelector('#image-result-next')?.addEventListener('click', () => void showGenerationResult(activeResultIndex + 1));
  document.querySelector('#image-nsfw-visible')?.addEventListener('change', (event) => {
    nsfwVisible = event.currentTarget.checked === true;
    renderGallery();
  });
  document.querySelector('#image-import-input')?.addEventListener('change', (event) => void importSelectedImage(event.currentTarget));
  document.querySelector('#image-gallery-grid')?.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-image-delete]');
    if (deleteButton) void deleteLibraryImage(deleteButton.dataset.imageDelete);
  });
  window.addEventListener('monarch:view-change', (event) => {
    if (event.detail?.view === 'images-section') {
      void ensureContextLoaded(true).then(() => {
        if (activeTab === 'perchance') void openEmbeddedPerchance({ requestAccess: false });
      });
      return;
    }
    void hideEmbeddedPerchance();
  });
  window.addEventListener('monarch:images-policy-changed', (event) => {
    if (!context || !event.detail?.policy) return;
    context.policy = event.detail.policy;
    if (!context.policy.providerConsentCurrent) {
      latestProvider = null;
      closeReservedProviderWindow();
      void window.monarchDesktop?.closeImageProvider?.();
      embeddedProviderConnected = false;
      setPerchanceState('idle');
    }
    if (!context.policy.matureModeActive) nsfwVisible = false;
    renderPolicyState();
    renderGallery();
  });
  const bridge = document.querySelector('#image-perchance-bridge');
  if (bridge && typeof ResizeObserver === 'function') {
    embeddedProviderResizeObserver = new ResizeObserver(() => scheduleEmbeddedProviderBoundsSync());
    embeddedProviderResizeObserver.observe(bridge);
  }
  window.addEventListener('resize', scheduleEmbeddedProviderBoundsSync);
  window.addEventListener('scroll', scheduleEmbeddedProviderBoundsSync, true);
  if (typeof window.monarchDesktop?.onImageProviderState === 'function') {
    embeddedProviderStateUnsubscribe = window.monarchDesktop.onImageProviderState(handleEmbeddedProviderState);
  }
  if (typeof window.monarchDesktop?.onImageProviderDownload === 'function') {
    embeddedProviderDownloadUnsubscribe = window.monarchDesktop.onImageProviderDownload((value) => {
      void handleImageProviderDownload(value);
    });
  }
  window.addEventListener('pagehide', () => {
    embeddedProviderStateUnsubscribe?.();
    embeddedProviderDownloadUnsubscribe?.();
    embeddedProviderResizeObserver?.disconnect();
  }, { once: true });
  syncImageAspectRatio();
}

export function renderImageGenerationPane() {
  void ensureContextLoaded().then((value) => {
    restoreActiveJob(value?.jobs);
    if (activeTab === 'perchance') void openEmbeddedPerchance({ requestAccess: false });
  });
  renderPolicyState();
}

export function reserveOscarImageProviderWindow(text) {
  return looksLikeLocalImageRequest(text);
}

export function closeOscarImageProviderReservation() {
  // Perchance lives in the Images view; there is no popup to reserve or close.
}

export async function handoffOscarImageGeneration(intent, options = {}) {
  if (!intent?.isImageGeneration) {
    return { status: 'ignored' };
  }
  if (intent.disposition === 'mature-mode-disabled' || intent.disposition === 'prohibited-content') {
    return { status: 'blocked', reason: intent.disposition };
  }
  const draft = {
    providerId: 'perchance-interactive',
    prompt: String(intent.prompt || '').trim(),
    style: 'none',
    aspectRatio: '1:1',
    count: 1,
    privacyMode: options.privacyMode === 'incognito' ? 'incognito' : 'persistent',
  };
  let confirmationId = '';
  for (let step = 0; step < 3; step += 1) {
    const preparation = await prepareImageGeneration({
      ...draft,
      ...(confirmationId ? { confirmationId } : {}),
    }, { signal: options.signal });
    if (preparation.status === 'blocked' && preparation.reason === 'provider-consent-required') {
      if (!await acceptImageProviderAgreement()) {
        return { status: 'cancelled', reason: 'provider-consent-declined' };
      }
      continue;
    }
    if (preparation.status === 'blocked' && preparation.reason === 'perchance-adult-attestation-required') {
      if (!await acceptPerchanceAdultRequirement()) {
        return { status: 'cancelled', reason: 'perchance-adult-attestation-declined' };
      }
      continue;
    }
    if (preparation.status === 'confirmation-required') {
      if (!await requestDialogConfirmation('#image-mature-confirmation-dialog')) {
        return { status: 'cancelled', reason: 'nsfw-confirmation-declined' };
      }
      confirmationId = preparation.challengeId;
      continue;
    }
    if (preparation.status === 'blocked') {
      return { status: 'blocked', reason: preparation.reason };
    }
    if (preparation.status === 'interactive-ready') {
      latestProvider = preparation;
      syncPerchancePromptControls(preparation);
      await copyText(preparation.promptText);
      selectImagesTab('perchance');
      window.dispatchEvent(new CustomEvent('monarch:navigate', { detail: { view: 'images-section' } }));
      await openEmbeddedPerchance({ requestAccess: false, requestIntroduction: true });
      window.dispatchEvent(new CustomEvent('monarch:image-generation-started', {
        detail: { source: 'oscar', preparation },
      }));
      return { status: 'started', mode: 'interactive', preparation };
    }
    activeJob = preparation;
    void watchGenerationJob(preparation);
    window.dispatchEvent(new CustomEvent('monarch:image-generation-started', {
      detail: { source: 'oscar', preparation },
    }));
    return { status: 'started', preparation };
  }
  return { status: 'blocked', reason: 'image-confirmation-loop' };
}

async function ensureContextLoaded(force = false) {
  if (context && !force) return context;
  if (!loadPromise) {
    loadPromise = fetchImageGenerationContext()
      .then((value) => {
        context = value;
        renderPolicyState();
        renderGallery();
        return value;
      })
      .catch((error) => {
        setGenerationStatus(readErrorMessage(error), true);
        throw error;
      })
      .finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

function selectImagesTab(value) {
  const requested = ['perchance', 'create', 'gallery'].includes(value) ? value : 'perchance';
  activeTab = requested === 'create' && !emergencyProviderAvailable ? 'perchance' : requested;
  document.querySelectorAll('[data-images-tab]').forEach((button) => {
    const selected = button.dataset.imagesTab === activeTab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('[data-images-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.imagesPanel !== activeTab;
  });
  if (activeTab === 'gallery') void ensureContextLoaded(true);
  if (activeTab === 'perchance') void openEmbeddedPerchance({ requestAccess: false });
  else void hideEmbeddedPerchance();
  renderPolicyState();
}

async function submitImageGeneration(confirmationId = '') {
  const draft = readGenerationDraft(confirmationId, 'aihorde-anonymous');
  const preview = document.querySelector('#image-resolved-preview');
  activeJob = null;
  resetActivePreview();
  genesisField?.resetResolved(preview);
  genesisField?.setState('preparing', 'Отправка в AI Horde');
  setStageState('loading');
  setGenerationBusy(true);
  setGenerationStatus('Проверяю policy и создаю anonymous job…');
  try {
    const preparation = await prepareImageGeneration(draft);
    if (preparation.status === 'blocked' && preparation.reason === 'provider-consent-required') {
      genesisField?.setState('idle');
      if (await acceptImageProviderAgreement()) {
        return submitImageGeneration(confirmationId);
      }
      setStageState('empty');
      setGenerationStatus('Отправка prompt отменена.');
      setGenerationBusy(false);
      return;
    }
    if (preparation.status === 'blocked') {
      genesisField?.setState('error', 'Запрос остановлен');
      setStageState('error');
      setGenerationStatus(blockedReason(preparation.reason), true);
      setGenerationBusy(false);
      return;
    }
    if (preparation.status === 'confirmation-required') {
      genesisField?.setState('idle');
      if (await requestDialogConfirmation('#image-mature-confirmation-dialog')) {
        return submitImageGeneration(preparation.challengeId);
      }
      setStageState('empty');
      setGenerationStatus('NSFW-генерация отменена.');
      setGenerationBusy(false);
      return;
    }
    activeJob = preparation;
    void watchGenerationJob(preparation);
  } catch (error) {
    genesisField?.setState('error', 'Генерация остановлена');
    setStageState('error');
    setGenerationStatus(readErrorMessage(error), true);
    setGenerationBusy(false);
  }
}

async function watchGenerationJob(initialJob) {
  const token = ++generationWatchToken;
  let job = initialJob;
  let retryDelay = 2_200;
  renderGenerationJob(job);
  while (token === generationWatchToken && (job.status === 'queued' || job.status === 'processing')) {
    await delay(retryDelay);
    if (token !== generationWatchToken) return;
    try {
      job = await fetchImageGenerationJob(job.jobId);
      activeJob = job;
      retryDelay = 2_200;
      renderGenerationJob(job);
    } catch (error) {
      retryDelay = Math.min(10_000, retryDelay * 1.6);
      setGenerationStatus(`Очередь недоступна: ${readErrorMessage(error)} · повторяю…`, true);
    }
  }
}

function renderGenerationJob(job) {
  if (!job) return;
  activeJob = job;
  const active = job.status === 'queued' || job.status === 'processing';
  setGenerationBusy(active);
  document.querySelector('#image-generation-save')?.toggleAttribute('hidden', job.status !== 'completed' || job.savePolicy === 'save');
  if (job.status === 'queued') {
    genesisField?.setState('generating', 'Ожидание worker');
    setStageState('loading');
    const queue = job.queuePosition > 0 ? `позиция ${job.queuePosition}` : 'позиция уточняется';
    const wait = job.waitTimeSeconds > 0 ? ` · примерно ${formatWaitTime(job.waitTimeSeconds)}` : '';
    setGenerationStatus(`Очередь AI Horde · ${queue}${wait}`);
    return;
  }
  if (job.status === 'processing') {
    genesisField?.setState('generating', 'Volunteer worker создаёт изображение');
    setStageState('loading');
    setGenerationStatus(`AI Horde обрабатывает · готово ${job.finishedCount} из ${job.requestedCount}`);
    return;
  }
  if (job.status === 'completed') {
    setStageState('complete');
    setGenerationStatus(`${job.results.length} готово · ${job.savePolicy === 'save' ? 'сохранено локально' : 'временно в памяти'} · anonymous sharing с LAION`);
    void showGenerationResult(0);
    void ensureContextLoaded(true);
    return;
  }
  genesisField?.setState(job.status === 'cancelled' ? 'idle' : 'error', job.status === 'cancelled' ? '' : 'Генерация остановлена');
  setStageState(job.status === 'cancelled' ? 'empty' : 'error');
  setGenerationStatus(job.status === 'cancelled' ? (job.error?.message || 'Запрос AI Horde отменён.') : (job.error?.message || 'AI Horde не вернул результат.'), job.status === 'failed');
}

async function showGenerationResult(requestedIndex) {
  const job = activeJob;
  if (!job || job.status !== 'completed' || !job.results.length) return;
  const index = Math.min(job.results.length - 1, Math.max(0, Number(requestedIndex) || 0));
  activeResultIndex = index;
  const actions = document.querySelector('#image-result-actions');
  const counter = document.querySelector('#image-result-counter');
  if (actions) actions.hidden = job.results.length <= 1;
  if (counter) counter.textContent = `${index + 1} / ${job.results.length}`;
  const previous = document.querySelector('#image-result-prev');
  const next = document.querySelector('#image-result-next');
  if (previous) previous.disabled = index === 0;
  if (next) next.disabled = index >= job.results.length - 1;
  try {
    const blob = await fetchImageGenerationResult(job.jobId, index);
    resetActivePreview();
    activePreviewUrl = URL.createObjectURL(blob);
    const preview = document.querySelector('#image-resolved-preview');
    genesisField?.resetResolved(preview);
    await genesisField?.resolve(activePreviewUrl, preview);
  } catch (error) {
    setGenerationStatus(readErrorMessage(error), true);
  }
}

async function cancelActiveGeneration() {
  const job = activeJob;
  if (!job || (job.status !== 'queued' && job.status !== 'processing')) return;
  const cancelButton = document.querySelector('#image-generation-cancel');
  cancelButton?.setAttribute('disabled', '');
  try {
    const cancelled = await cancelImageGenerationJob(job.jobId);
    generationWatchToken += 1;
    activeJob = cancelled;
    renderGenerationJob(cancelled);
  } catch (error) {
    setGenerationStatus(readErrorMessage(error), true);
  } finally {
    cancelButton?.removeAttribute('disabled');
  }
}

async function saveActiveGeneration() {
  if (!activeJob || activeJob.status !== 'completed') return;
  try {
    activeJob = await saveImageGenerationResults(activeJob.jobId);
    renderGenerationJob(activeJob);
    await ensureContextLoaded(true);
  } catch (error) {
    setGenerationStatus(readErrorMessage(error), true);
  }
}

function restoreActiveJob(jobs) {
  if (activeJob || !Array.isArray(jobs)) return;
  const candidate = jobs.find((job) => job.status === 'queued' || job.status === 'processing');
  if (candidate) void watchGenerationJob(candidate);
}

function setGenerationBusy(active) {
  const button = document.querySelector('#image-generate-button');
  const cancel = document.querySelector('#image-generation-cancel');
  if (button) button.disabled = active;
  if (cancel) cancel.hidden = !active || !activeJob;
}

function resetActivePreview() {
  if (activePreviewUrl) URL.revokeObjectURL(activePreviewUrl);
  activePreviewUrl = '';
  const actions = document.querySelector('#image-result-actions');
  if (actions) actions.hidden = true;
}

function formatWaitTime(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} сек`;
  return `${Math.max(1, Math.round(seconds / 60))} мин`;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function readGenerationDraft(confirmationId, providerId = 'perchance-interactive') {
  return {
    providerId,
    prompt: document.querySelector('#image-prompt')?.value || '',
    negativePrompt: document.querySelector('#image-negative-prompt')?.value || '',
    style: document.querySelector('#image-style')?.value || 'none',
    aspectRatio: document.querySelector('#image-aspect-ratio')?.value || '1:1',
    count: Number(document.querySelector('#image-count')?.value || 1),
    seed: document.querySelector('#image-seed')?.value || '',
    privacyMode: document.querySelector('#image-incognito-mode')?.checked ? 'incognito' : 'persistent',
    ...(confirmationId ? { confirmationId } : {}),
  };
}

async function openManualFallback() {
  try {
    selectImagesTab('perchance');
    await openEmbeddedPerchance({ requestAccess: true });
  } catch (error) {
    setGenerationStatus(readErrorMessage(error), true);
  }
}

async function openEmbeddedPerchance({ requestAccess, requestIntroduction = false }) {
  if (!isImagesViewActive() || activeTab !== 'perchance') return { ok: false, inactive: true };
  const loaded = await ensureContextLoaded();
  const primaryProvider = loaded?.primaryProvider || loaded?.manualFallback;
  if (!primaryProvider?.url) throw new Error('Perchance сейчас недоступен.');
  if (!loaded.policy?.providerConsentCurrent) {
    setPerchanceState('consent');
    if (!requestAccess) return { ok: false, consentRequired: true };
    if (!await acceptImageProviderAgreement()) return { ok: false, cancelled: true };
  }
  if (!context?.policy?.providerAdultAttestedAt) {
    setPerchanceState('age');
    if (!requestAccess) return { ok: false, ageRequired: true };
    if (!await acceptPerchanceAdultRequirement()) return { ok: false, cancelled: true };
  }
  if (!context?.policy?.providerIntroAcknowledgedAt) {
    setPerchanceState('intro');
    if (!requestAccess && !requestIntroduction) return { ok: false, introductionRequired: true };
    if (!await acceptPerchanceIntroduction()) return { ok: false, cancelled: true };
  }
  const bounds = readEmbeddedProviderBounds();
  if (!bounds) return { ok: false, tooSmall: true };
  const draft = readPerchanceDraft();
  latestProvider = latestProvider?.providerId === 'perchance-interactive'
    ? { ...latestProvider, promptText: formatManualProviderPrompt(draft), privacyMode: draft.privacyMode }
    : {
      ...primaryProvider,
      providerId: 'perchance-interactive',
      promptText: formatManualProviderPrompt(draft),
      privacyMode: draft.privacyMode,
    };
  syncPerchancePromptControls(latestProvider);
  const desktop = window.monarchDesktop;
  if (typeof desktop?.showEmbeddedImageProvider !== 'function') {
    setPerchanceState('browser');
    return { ok: false, desktopRequired: true };
  }
  setPerchanceState('loading');
  const result = await desktop.showEmbeddedImageProvider({
    url: latestProvider.url,
    prompt: latestProvider.promptText,
    zoom: Number(document.querySelector('#image-perchance-zoom')?.value || 0.9),
    bounds,
  });
  if (!result?.ok) {
    handleEmbeddedProviderState({ status: 'error', description: result?.error || 'provider-view-unavailable' });
    return result;
  }
  embeddedProviderConnected = true;
  scheduleEmbeddedProviderBoundsSync();
  return result;
}

async function acceptPerchanceAdultRequirement() {
  const accepted = await requestPerchanceAdultAttestation();
  if (!accepted) return null;
  const policy = await updateImageGenerationPolicy({
    action: 'perchance-access',
    enabled: true,
    adultAttested: true,
  });
  adoptPolicy(policy);
  return policy;
}

async function acceptPerchanceIntroduction() {
  if (!await requestPerchanceIntroduction()) return null;
  const policy = await updateImageGenerationPolicy({
    action: 'perchance-intro',
    enabled: true,
  });
  adoptPolicy(policy);
  return policy;
}

function requestPerchanceIntroduction() {
  const dialog = document.querySelector('#image-perchance-intro-dialog');
  if (!dialog?.showModal) return Promise.resolve(false);
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function requestPerchanceAdultAttestation() {
  const dialog = document.querySelector('#image-perchance-age-dialog');
  const checkbox = document.querySelector('#image-perchance-adult-attestation');
  const confirmButton = document.querySelector('#image-perchance-age-confirm');
  if (!dialog?.showModal || !checkbox || !confirmButton) return Promise.resolve(false);
  checkbox.checked = false;
  confirmButton.disabled = true;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    const sync = () => { confirmButton.disabled = checkbox.checked !== true; };
    const onClose = () => {
      checkbox.onchange = null;
      resolve(dialog.returnValue === 'confirm' && checkbox.checked === true);
    };
    checkbox.onchange = sync;
    dialog.addEventListener('close', onClose, { once: true });
    dialog.showModal();
  });
}

async function navigateEmbeddedPerchance(action) {
  if (!embeddedProviderConnected) return;
  const result = await window.monarchDesktop?.navigateEmbeddedImageProvider?.(action);
  if (!result?.ok && action !== 'back') {
    handleEmbeddedProviderState({ status: 'error', description: result?.error || 'provider-navigation-failed' });
  }
}

async function copyPerchancePrompt() {
  const draft = readPerchanceDraft();
  const prompt = formatManualProviderPrompt(draft);
  if (!prompt.trim()) {
    setPerchanceStatus('Сначала введи prompt или попроси Oscar подготовить изображение.', true);
    return;
  }
  await copyText(prompt);
  setPerchanceStatus('Prompt скопирован. Вставь его в поле Description внутри Perchance.');
}

async function translatePerchancePrompt() {
  const input = document.querySelector('#image-perchance-prompt');
  const button = document.querySelector('#image-perchance-translate');
  const text = String(input?.value || '').trim();
  if (!text) {
    setPerchanceStatus('Сначала введи prompt для перевода.', true);
    return;
  }
  try {
    if (button) button.disabled = true;
    setPerchanceStatus('Перевожу через Fast-модель — без истории и памяти…');
    const result = await translateImagePrompt(text);
    if (input) input.value = result.translatedText;
    latestProvider = latestProvider ? { ...latestProvider, prompt: result.translatedText, promptText: result.translatedText } : latestProvider;
    await copyText(result.translatedText);
    setPerchanceStatus('Английский prompt готов и скопирован. Вставь его в Description внутри Perchance.');
  } catch (error) {
    setPerchanceStatus(readErrorMessage(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function openPerchanceExternally() {
  const loaded = await ensureContextLoaded();
  const primaryProvider = loaded?.primaryProvider || loaded?.manualFallback;
  if (!primaryProvider?.url) throw new Error('Perchance сейчас недоступен.');
  if (!loaded.policy?.providerConsentCurrent && !await acceptImageProviderAgreement()) return;
  if (!context?.policy?.providerAdultAttestedAt && !await acceptPerchanceAdultRequirement()) return;
  if (!context?.policy?.providerIntroAcknowledgedAt && !await acceptPerchanceIntroduction()) return;
  const draft = readPerchanceDraft();
  latestProvider = latestProvider?.providerId === 'perchance-interactive'
    ? { ...latestProvider, promptText: formatManualProviderPrompt(draft), privacyMode: draft.privacyMode }
    : { ...primaryProvider, providerId: 'perchance-interactive', promptText: formatManualProviderPrompt(draft), privacyMode: draft.privacyMode };
  await openProvider(latestProvider);
}

async function handleImageProviderDownload(value = {}) {
  if (value.status === 'started') {
    setPerchanceStatus(`Perchance скачивает ${String(value.name || 'изображение')}…`);
    return;
  }
  if (value.status === 'cancelled') {
    setPerchanceStatus('Скачивание отменено.');
    return;
  }
  if (value.status === 'rejected' || value.status === 'failed') {
    setPerchanceStatus(String(value.message || 'Не удалось безопасно импортировать скачанный файл.'), true);
    return;
  }
  if (value.status !== 'ready') return;

  const privacyMode = document.querySelector('#image-perchance-download-privacy')?.value === 'incognito'
    ? 'incognito'
    : 'persistent';
  const policy = context?.policy;
  if (privacyMode === 'incognito' && policy?.incognitoPersistence === 'never') {
    setPerchanceStatus('Файл не сохранён: для инкогнито выбрано «никогда не сохранять».');
    return;
  }
  if (privacyMode === 'incognito' && policy?.incognitoPersistence === 'ask'
    && !window.confirm('Сохранить это изображение из инкогнито-чата в локальную Галерею?')) {
    setPerchanceStatus('Файл не сохранён по правилу инкогнито.');
    return;
  }

  try {
    setPerchanceStatus(`Проверяю и сохраняю ${formatDownloadBytes(value.bytes)} в локальную Галерею…`);
    await importImageToLibrary({
      name: value.name,
      mimeType: value.mimeType,
      dataBase64: value.dataBase64,
      contentRating: document.querySelector('#image-perchance-download-rating')?.value || 'unknown',
      prompt: String(document.querySelector('#image-perchance-prompt')?.value || ''),
      privacyMode,
      explicitSave: true,
    });
    await ensureContextLoaded(true);
    setPerchanceStatus('Изображение сохранено в локальной Галерее. Perchance остаётся открытым.');
  } catch (error) {
    setPerchanceStatus(readErrorMessage(error), true);
  }
}

function readPerchanceDraft() {
  const fallback = readGenerationDraft('', 'perchance-interactive');
  return {
    ...fallback,
    prompt: String(document.querySelector('#image-perchance-prompt')?.value || latestProvider?.prompt || latestProvider?.promptText || fallback.prompt || '').trim(),
    privacyMode: document.querySelector('#image-perchance-download-privacy')?.value === 'incognito'
      ? 'incognito'
      : fallback.privacyMode,
  };
}

function syncPerchancePromptControls(provider = {}) {
  const prompt = document.querySelector('#image-perchance-prompt');
  const privacy = document.querySelector('#image-perchance-download-privacy');
  const rating = document.querySelector('#image-perchance-download-rating');
  const promptText = String(provider.prompt || provider.promptText || '').trim();
  if (prompt && promptText) prompt.value = promptText;
  if (privacy && provider.privacyMode) privacy.value = provider.privacyMode === 'incognito' ? 'incognito' : 'persistent';
  if (rating && ['safe', 'nsfw', 'unknown'].includes(provider.contentRating)) rating.value = provider.contentRating;
}

function formatDownloadBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

async function copyText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (typeof window.monarchDesktop?.copyText === 'function') {
    const result = await window.monarchDesktop.copyText(text);
    return result?.ok !== false;
  }
  await navigator.clipboard?.writeText?.(text);
  return true;
}

function readEmbeddedProviderBounds() {
  const bridge = document.querySelector('#image-perchance-bridge');
  if (!bridge || bridge.hidden) return null;
  const rect = bridge.getBoundingClientRect();
  if (rect.width < 480 || rect.height < 360) return null;
  return {
    x: Math.round(rect.left + 1),
    y: Math.round(rect.top + 1),
    width: Math.round(rect.width - 2),
    height: Math.round(rect.height - 2),
  };
}

function scheduleEmbeddedProviderBoundsSync() {
  if (!embeddedProviderConnected || !isImagesViewActive() || activeTab !== 'perchance') return;
  window.cancelAnimationFrame(embeddedProviderBoundsFrame);
  embeddedProviderBoundsFrame = window.requestAnimationFrame(() => {
    const bounds = readEmbeddedProviderBounds();
    if (bounds) void window.monarchDesktop?.updateEmbeddedImageProviderBounds?.(bounds);
  });
}

async function hideEmbeddedPerchance() {
  if (!embeddedProviderConnected) return;
  window.cancelAnimationFrame(embeddedProviderBoundsFrame);
  await window.monarchDesktop?.hideEmbeddedImageProvider?.();
}

function handleEmbeddedProviderState(value = {}) {
  if (value.status === 'loading') {
    setPerchanceState('loading');
    return;
  }
  if (value.status === 'ready') {
    embeddedProviderConnected = true;
    setPerchanceState('ready');
    scheduleEmbeddedProviderBoundsSync();
    return;
  }
  if (value.status === 'error') {
    void window.monarchDesktop?.hideEmbeddedImageProvider?.();
    embeddedProviderConnected = false;
    setPerchanceState('error');
    revealEmergencyProvider(`Perchance недоступен (${String(value.description || 'ошибка загрузки')}). Разблокирован аварийный AI Horde.`);
  }
}

function setPerchanceState(value) {
  const panel = document.querySelector('.image-perchance-panel');
  const placeholder = document.querySelector('#image-perchance-placeholder');
  if (panel) panel.dataset.providerState = value;
  if (placeholder) placeholder.hidden = value === 'ready' || value === 'loading';
  if (value === 'loading') setPerchanceStatus('Подключаю тестовую BETA-интеграцию Perchance…');
  else if (value === 'ready') setPerchanceStatus('Тестовая BETA-интеграция Perchance открыта. Вставь prompt и нажми Generate вручную.');
  else if (value === 'consent') setPerchanceStatus('Для доступа к внешнему сервису нужно один раз принять соглашение.');
  else if (value === 'age') setPerchanceStatus('Perchance требует отдельного подтверждения возраста 18+.');
  else if (value === 'intro') setPerchanceStatus('Остался короткий обзор бесплатного внешнего сервиса, рекламы и сохранения изображений.');
  else if (value === 'browser') setPerchanceStatus('Встроенный режим доступен только в desktop-приложении. Можно открыть Perchance отдельно.', true);
  else if (value === 'error') setPerchanceStatus('Perchance не загрузился. Доступен явно помеченный аварийный AI Horde.', true);
}

function setPerchanceStatus(message, error = false) {
  const status = document.querySelector('#image-perchance-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', error);
}

function revealEmergencyProvider(message = '') {
  emergencyProviderAvailable = true;
  const tab = document.querySelector('#image-emergency-tab');
  if (tab) tab.hidden = false;
  if (message) setGenerationStatus(message, true);
}

function isImagesViewActive() {
  return !document.querySelector('#images-section')?.classList.contains('view-hidden');
}

export function formatManualProviderPrompt(draft) {
  const prompt = String(draft?.prompt || '').trim();
  if (!prompt) return '';
  return [
    prompt,
    draft.negativePrompt ? `Negative prompt: ${draft.negativePrompt}` : '',
    draft.style !== 'none' ? `Style: ${draft.style}` : '',
    `Aspect ratio: ${draft.aspectRatio}`,
    draft.seed ? `Seed: ${draft.seed}` : '',
    draft.count > 1 ? `Images: ${draft.count}` : '',
  ].filter(Boolean).join('\n');
}

async function openProvider(provider) {
  if (!provider) return;
  if (typeof window.monarchDesktop?.openImageProvider === 'function') {
    const result = await window.monarchDesktop.openImageProvider({ url: provider.url, prompt: provider.promptText });
    if (!result?.ok) throw new Error('Не удалось открыть интерактивный provider.');
    return;
  }
  await navigator.clipboard?.writeText?.(provider.promptText).catch(() => undefined);
  const opened = reservedBrowserProviderWindow && !reservedBrowserProviderWindow.closed
    ? reservedBrowserProviderWindow
    : window.open('about:blank', '_blank');
  if (!opened) throw new Error('Браузер заблокировал окно Perchance. Разреши всплывающие окна и повтори.');
  reservedBrowserProviderWindow = null;
  opened.location.replace(provider.url);
}

function reserveBrowserProviderWindow() {
  if (typeof window.monarchDesktop?.openImageProvider === 'function') return;
  if (reservedBrowserProviderWindow && !reservedBrowserProviderWindow.closed) return;
  reservedBrowserProviderWindow = window.open('about:blank', '_blank');
}

function closeReservedProviderWindow() {
  if (reservedBrowserProviderWindow && !reservedBrowserProviderWindow.closed) {
    reservedBrowserProviderWindow.close();
  }
  reservedBrowserProviderWindow = null;
}

async function importSelectedImage(input) {
  const file = input.files?.[0];
  if (!file) return;
  const status = document.querySelector('#image-gallery-status');
  status.textContent = 'Импортирую локально…';
  status.classList.remove('is-error');
  try {
    const dataBase64 = await fileToBase64(file);
    const rating = document.querySelector('#image-import-rating')?.value || 'unknown';
    const privacyMode = document.querySelector('#image-incognito-mode')?.checked ? 'incognito' : 'persistent';
    await importImageToLibrary({
      name: file.name,
      mimeType: file.type,
      dataBase64,
      contentRating: rating,
      prompt: document.querySelector('#image-prompt')?.value || '',
      privacyMode,
      explicitSave: true,
    });
    await ensureContextLoaded(true);
    status.textContent = 'Изображение сохранено в локальной галерее.';
    selectImagesTab('gallery');
  } catch (error) {
    genesisField?.setState('error', 'Импорт остановлен');
    status.textContent = readErrorMessage(error);
    status.classList.add('is-error');
  } finally {
    input.value = '';
  }
}

async function deleteLibraryImage(id) {
  const record = context?.library?.find((candidate) => candidate.id === id);
  if (!record || !window.confirm(`Удалить «${record.name}» из локальной галереи?`)) return;
  try {
    await deleteImageLibraryRecord(id);
    const objectUrl = galleryObjectUrls.get(id);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    galleryObjectUrls.delete(id);
    await ensureContextLoaded(true);
  } catch (error) {
    const status = document.querySelector('#image-gallery-status');
    status.textContent = readErrorMessage(error);
    status.classList.add('is-error');
  }
}

function renderPolicyState() {
  const policy = context?.policy;
  if (!policy) return;
  const active = policy.matureModeActive === true;
  const state = document.querySelector('#images-policy-state');
  const badge = document.querySelector('#image-rating-badge');
  const visibility = document.querySelector('#image-nsfw-visibility');
  if (state) {
    state.dataset.mode = active ? 'nsfw' : 'safe';
    state.querySelector('strong').textContent = activeTab === 'create'
      ? 'Аварийный AI Horde'
      : active ? 'Perchance · BETA · NSFW' : 'Perchance · BETA';
    const detail = state.querySelector('small');
    if (detail) detail.textContent = activeTab === 'create'
      ? 'аварийный внешний сервис'
      : 'тестовая внешняя функция · 18+';
  }
  if (badge) badge.textContent = active ? '18+' : 'PG-13';
  if (visibility) visibility.hidden = !active;
  if (!active) {
    nsfwVisible = false;
    const toggle = document.querySelector('#image-nsfw-visible');
    if (toggle) toggle.checked = false;
  }
}

function renderGallery() {
  const grid = document.querySelector('#image-gallery-grid');
  if (!grid || !context) return;
  const records = (context.library || []).filter((record) => record.contentRating !== 'nsfw' || nsfwVisible);
  grid.innerHTML = records.length ? records.map((record) => `
    <article class="image-gallery-card" data-rating="${escapeHtml(record.contentRating)}">
      <div class="image-gallery-media" data-image-media="${escapeHtml(record.id)}"><span>Загрузка…</span></div>
      <div class="image-gallery-card-copy">
        <span><strong>${escapeHtml(record.name)}</strong><small>${formatImageMeta(record)}</small></span>
        <button type="button" data-image-delete="${escapeHtml(record.id)}" aria-label="Удалить ${escapeHtml(record.name)}" title="Удалить">×</button>
      </div>
    </article>
  `).join('') : `<div class="image-gallery-empty"><strong>${context.library?.length ? 'NSFW скрыты' : 'Галерея пока пуста'}</strong><span>${context.library?.length ? 'Включи показ NSFW, если режим 18+ активен.' : 'Локально импортированные и явно сохранённые изображения появятся здесь.'}</span></div>`;
  for (const record of records) void hydrateGalleryImage(record);
}

async function hydrateGalleryImage(record) {
  const media = document.querySelector(`[data-image-media="${CSS.escape(record.id)}"]`);
  if (!media) return;
  try {
    let url = galleryObjectUrls.get(record.id);
    if (!url) {
      url = URL.createObjectURL(await fetchImageLibraryAsset(record.id));
      galleryObjectUrls.set(record.id, url);
    }
    media.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(record.name)}" loading="lazy">`;
  } catch {
    media.innerHTML = '<span>Файл недоступен</span>';
  }
}

function adoptPolicy(policy) {
  if (!context) context = { schemaVersion: 1, policy, library: [] };
  else context.policy = policy;
  renderPolicyState();
  window.dispatchEvent(new CustomEvent('monarch:images-policy-changed', { detail: { policy } }));
}

function syncImageAspectRatio() {
  const stage = document.querySelector('#image-result-stage');
  const ratio = document.querySelector('#image-aspect-ratio')?.value || '1:1';
  if (stage) stage.dataset.ratio = ratio.replace(':', '-');
}

function setStageState(value) {
  const stage = document.querySelector('#image-result-stage');
  if (stage) stage.dataset.state = value;
}

function setGenerationStatus(message, error = false) {
  const status = document.querySelector('#image-generation-status');
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('is-error', error);
}

function requestDialogConfirmation(selector) {
  const dialog = document.querySelector(selector);
  if (!dialog?.showModal) return Promise.resolve(false);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

export async function acceptImageProviderAgreement() {
  const acceptance = await requestImageProviderAgreementConsent();
  if (!acceptance) return null;
  const policy = await updateImageGenerationPolicy({
    action: 'provider-consent',
    enabled: true,
    ...acceptance,
  });
  adoptPolicy(policy);
  return policy;
}

export async function requestImageProviderAgreementConsent() {
  const dialog = document.querySelector('#image-provider-consent-dialog');
  const cloudCheckbox = document.querySelector('#image-cloud-processing-consent');
  const termsCheckbox = document.querySelector('#image-third-party-terms-consent');
  const confirmButton = document.querySelector('#image-provider-consent-confirm');
  const errorLabel = document.querySelector('#image-provider-agreement-error');
  if (!dialog?.showModal || !cloudCheckbox || !termsCheckbox || !confirmButton) return null;

  try {
    const agreement = await ensureProviderAgreementLoaded();
    renderProviderAgreement(agreement);
    cloudCheckbox.checked = false;
    termsCheckbox.checked = false;
    confirmButton.disabled = true;
    if (errorLabel) errorLabel.textContent = '';
    dialog.returnValue = '';

    return await new Promise((resolve) => {
      const sync = () => {
        confirmButton.disabled = !(cloudCheckbox.checked === true && termsCheckbox.checked === true);
      };
      const onClose = () => {
        cloudCheckbox.onchange = null;
        termsCheckbox.onchange = null;
        const accepted = dialog.returnValue === 'confirm'
          && cloudCheckbox.checked === true
          && termsCheckbox.checked === true;
        resolve(accepted ? {
          agreementVersion: agreement.version,
          cloudProcessingAccepted: true,
          thirdPartyTermsAccepted: true,
        } : null);
      };
      cloudCheckbox.onchange = sync;
      termsCheckbox.onchange = sync;
      dialog.addEventListener('close', onClose, { once: true });
      dialog.showModal();
    });
  } catch (error) {
    if (errorLabel) errorLabel.textContent = `Соглашение недоступно: ${readErrorMessage(error)}`;
    return null;
  }
}

async function ensureProviderAgreementLoaded() {
  if (providerAgreement) return providerAgreement;
  if (!providerAgreementPromise) {
    providerAgreementPromise = fetchImageProviderAgreement()
      .then((agreement) => {
        if (agreement?.schemaVersion !== 1 || !agreement.version || !Array.isArray(agreement.sections)) {
          throw new Error('Получена неподдерживаемая версия соглашения.');
        }
        providerAgreement = agreement;
        return agreement;
      })
      .finally(() => { providerAgreementPromise = null; });
  }
  return providerAgreementPromise;
}

function renderProviderAgreement(agreement) {
  const root = document.querySelector('#image-provider-agreement-content');
  const version = document.querySelector('#image-provider-agreement-version');
  if (!root) return;
  root.replaceChildren();

  const critical = document.createElement('section');
  const criticalTitle = document.createElement('h4');
  criticalTitle.textContent = 'Существенные условия';
  critical.append(criticalTitle);
  const criticalList = document.createElement('ul');
  for (const notice of agreement.criticalNotices || []) {
    const item = document.createElement('li');
    item.textContent = String(notice || '');
    criticalList.append(item);
  }
  critical.append(criticalList);
  root.append(critical);

  for (const source of agreement.sections) {
    const section = document.createElement('section');
    const title = document.createElement('h4');
    title.textContent = String(source.title || '');
    section.append(title);
    for (const value of source.paragraphs || []) {
      const paragraph = document.createElement('p');
      paragraph.textContent = String(value || '');
      section.append(paragraph);
    }
    if (Array.isArray(source.bullets) && source.bullets.length) {
      const list = document.createElement('ul');
      for (const value of source.bullets) {
        const item = document.createElement('li');
        item.textContent = String(value || '');
        list.append(item);
      }
      section.append(list);
    }
    root.append(section);
  }

  const links = document.createElement('section');
  const linksTitle = document.createElement('h4');
  linksTitle.textContent = 'Документы внешних providers';
  links.append(linksTitle);
  links.append(createAgreementLink('Условия Perchance', agreement.manualFallback?.termsUrl));
  links.append(createAgreementLink('Privacy Perchance', agreement.manualFallback?.privacyUrl));
  links.append(createAgreementLink('Условия AI Horde', agreement.provider?.termsUrl));
  links.append(createAgreementLink('Privacy AI Horde', agreement.provider?.privacyUrl));
  root.append(links);
  if (version) version.textContent = `Версия ${agreement.version} · действует с ${agreement.effectiveAt} · ${agreement.publisher}`;
}

function createAgreementLink(label, value) {
  const link = document.createElement('a');
  link.textContent = label;
  link.href = String(value || '#');
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function blockedReason(reason) {
  if (reason === 'mature-mode-disabled') return 'Этот prompt относится к NSFW. Режим 18+ выключен в Настройки → Изображения → Расширенная политика контента.';
  if (reason === 'prohibited-content') return 'Monarch не создаёт сексуализированный контент с несовершеннолетними.';
  if (reason === 'perchance-adult-attestation-required') return 'Perchance доступен только после отдельного подтверждения возраста 18+.';
  return 'Генерация заблокирована политикой изображений.';
}

function formatImageMeta(record) {
  const rating = record.contentRating === 'nsfw' ? 'NSFW' : record.contentRating === 'safe' ? 'Обычное' : 'Неизвестно';
  const size = record.bytes >= 1024 * 1024 ? `${(record.bytes / (1024 * 1024)).toFixed(1)} МБ` : `${Math.max(1, Math.round(record.bytes / 1024))} КБ`;
  return `${rating} · ${size}`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

function looksLikeLocalImageRequest(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (/(?:сгенерируй|создай|сделай|generate|create|make)(?:\s|$).{0,60}(?:сайт|код|страниц|макет|компонент|описан|промпт|website|code|page|layout|component|description|prompt).{0,60}(?:изображен|картин|image|picture)/i.test(text)) return false;
  return /(?:\$image|\/image|image\s*gen|генерац\S*\s+(?:изображен|картин|фото|арт)|^(?:oscar[,:]?\s*)?(?:нарисуй|изобрази|draw|illustrate)(?:\s|$)|(?:сгенерируй|создай|сделай|generate|create|make)(?:\s|$).{0,100}(?:изображен|картин|фото|арт|иллюстрац|обои|аватар|портрет|image|picture|photo|artwork|illustration|wallpaper|avatar|portrait))/i.test(text);
}
