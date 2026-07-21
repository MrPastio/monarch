import { executeCapability, executeConfirmedCapability } from './api.js';
import { escapeHtml, readErrorMessage } from './utils.js';

const ICON_ROOT = '/assets/icons/phosphor';
const DEFAULT_IMAGE = '/assets/studio/guided-portrait.png';
const MAX_PHOTO_EDGE = 4096;
const MAX_VIDEO_WIDTH = 1280;
const CYRILLIC_TO_LATIN = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', є: 'ye', ж: 'zh', з: 'z',
  и: 'i', і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
});

export const STUDIO_PRESETS = Object.freeze({
  auto: Object.freeze({ exposure: 8, contrast: 5, saturation: 8, warmth: 4, label: 'Автоулучшение' }),
  warm: Object.freeze({ exposure: 13, contrast: 4, saturation: 16, warmth: 18, label: 'Теплее и ярче' }),
  cool: Object.freeze({ exposure: -4, contrast: 18, saturation: -8, warmth: -18, label: 'Холоднее и контрастнее' }),
});

const studioState = {
  initialized: false,
  active: false,
  mode: 'photo',
  sourceImageUrl: DEFAULT_IMAGE,
  sourceImageName: 'guided-portrait.png',
  photoFormat: 'png',
  videoUrl: '',
  videoName: '',
  ratio: 'original',
  rotation: 0,
  flipX: false,
  flipY: false,
  outputWidth: 0,
  outputHeight: 0,
  exposure: STUDIO_PRESETS.auto.exposure,
  contrast: STUDIO_PRESETS.auto.contrast,
  saturation: STUDIO_PRESETS.auto.saturation,
  warmth: STUDIO_PRESETS.auto.warmth,
  skin: false,
  detail: false,
  text: '',
  textSize: 42,
  textColor: '#ffffff',
  videoText: '',
  drawTool: 'pen',
  drawColor: '#ff8428',
  drawSize: 8,
  drawingActive: false,
  annotations: [],
  history: [],
  historyCursor: -1,
  exporting: false,
};

function byId(id) {
  return document.getElementById(id);
}

export function slugifyModuleName(value) {
  return String(value || '')
    .toLowerCase()
    .split('')
    .map((character) => CYRILLIC_TO_LATIN[character] ?? character)
    .join('')
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function formatMediaTime(value) {
  const seconds = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

export function buildPhotoFilter(settings) {
  const exposure = clamp(Number(settings.exposure), -50, 50);
  const contrast = clamp(Number(settings.contrast) + (settings.detail ? 5 : 0), -50, 55);
  const saturation = clamp(Number(settings.saturation) + (settings.detail ? 3 : 0), -50, 55);
  const warmth = clamp(Number(settings.warmth), -50, 50);
  const temperatureHue = warmth < 0 ? warmth * 0.2 : warmth * 0.08;
  const sepia = warmth > 0 ? Math.min(0.22, warmth / 120) : 0;
  const parts = [
    `brightness(${(1 + exposure / 100).toFixed(2)})`,
    `contrast(${(1 + contrast / 100).toFixed(2)})`,
    `saturate(${(1 + saturation / 100).toFixed(2)})`,
  ];
  if (sepia > 0) parts.push(`sepia(${sepia.toFixed(2)})`);
  if (temperatureHue !== 0) parts.push(`hue-rotate(${temperatureHue.toFixed(1)}deg)`);
  if (settings.skin) parts.push('blur(0.3px)');
  return parts.join(' ');
}

export function unwrapCapabilityResponse(payload) {
  return payload?.result && typeof payload.result === 'object' ? payload.result : payload;
}

export function pickMediaRecorderMime(MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass) return '';
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return types.find((type) => MediaRecorderClass.isTypeSupported?.(type)) || '';
}

export function initStudioPane() {
  if (studioState.initialized || !byId('modules-workspace')) return;
  studioState.initialized = true;

  bindTabs();
  bindPhotoEditor();
  bindVideoEditor();
  bindBuilder();
  bindLibrary();
  bindMediaInputs();
  bindKeyboardShortcuts();
  bindAnnotationCanvas();
  const image = byId('studio-photo-after');
  image?.addEventListener('load', () => syncSourceDimensions(false));
  resetPhotoEditor(false);
  if (image?.complete) syncSourceDimensions(false);
}

export function setStudioActive(active) {
  studioState.active = active === true;
  if (!studioState.active) {
    byId('studio-video')?.pause();
  }
}

function bindTabs() {
  document.querySelectorAll('[data-modules-tab]').forEach((button) => {
    button.addEventListener('click', () => openModulesPanel(button.dataset.modulesTab || 'studio'));
  });
  document.querySelectorAll('[data-open-studio]').forEach((button) => {
    button.addEventListener('click', () => openModulesPanel('studio'));
  });
  document.querySelectorAll('[data-open-builder]').forEach((button) => {
    button.addEventListener('click', () => openModulesPanel('builder'));
  });
}

function openModulesPanel(panelName) {
  document.querySelectorAll('[data-modules-tab]').forEach((button) => {
    const active = button.dataset.modulesTab === panelName;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-modules-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.modulesPanel !== panelName;
  });
  if (panelName !== 'studio') byId('studio-video')?.pause();
  if (panelName === 'library') void loadModuleLibrary();
}

function bindPhotoEditor() {
  byId('studio-split')?.addEventListener('input', (event) => {
    byId('studio-photo-preview')?.style.setProperty('--studio-split', `${event.currentTarget.value}%`);
  });

  document.querySelectorAll('[data-studio-preset]').forEach((button) => {
    button.addEventListener('click', () => applyPreset(button.dataset.studioPreset || 'auto'));
  });

  const fineToggle = byId('studio-fine-toggle');
  fineToggle?.addEventListener('click', () => {
    const controls = byId('studio-fine-controls');
    if (!controls) return;
    const expanded = controls.hidden;
    controls.hidden = !expanded;
    document.querySelectorAll('[data-studio-advanced-group]').forEach((group) => {
      group.hidden = !expanded;
    });
    fineToggle.setAttribute('aria-expanded', String(expanded));
    const icon = fineToggle.querySelector('img');
    if (icon) icon.src = `${ICON_ROOT}/${expanded ? 'caret-down' : 'caret-right'}.svg`;
  });

  for (const key of ['exposure', 'contrast', 'saturation', 'warmth']) {
    const input = byId(`studio-${key}`);
    input?.addEventListener('input', () => {
      studioState[key] = Number(input.value);
      byId(`studio-${key}-output`).textContent = input.value;
      clearSelectedPreset();
      renderPhotoPreview();
    });
    input?.addEventListener('change', () => addHistory('Точная настройка'));
  }

  document.querySelectorAll('[data-studio-accordion]').forEach((button) => {
    button.addEventListener('click', () => toggleAccordion(button));
  });

  document.querySelectorAll('[data-studio-ratio]').forEach((button) => {
    button.addEventListener('click', () => {
      studioState.ratio = button.dataset.studioRatio || 'original';
      document.querySelectorAll('[data-studio-ratio]').forEach((item) => item.classList.toggle('active', item === button));
      renderPhotoPreview();
      addHistory(studioState.ratio === 'original' ? 'Оригинальный кадр' : `Кадр ${studioState.ratio.replace(' / ', ':')}`);
    });
  });

  byId('studio-rotate')?.addEventListener('click', () => {
    studioState.rotation = (studioState.rotation + 90) % 360;
    renderPhotoPreview();
    addHistory(`Поворот ${studioState.rotation}°`);
  });

  for (const [id, key, label] of [
    ['studio-flip-x', 'flipX', 'Отражение по горизонтали'],
    ['studio-flip-y', 'flipY', 'Отражение по вертикали'],
  ]) {
    byId(id)?.addEventListener('click', (event) => {
      studioState[key] = !studioState[key];
      event.currentTarget.classList.toggle('active', studioState[key]);
      renderPhotoPreview();
      addHistory(label);
    });
  }

  for (const [id, key] of [
    ['studio-output-width', 'outputWidth'],
    ['studio-output-height', 'outputHeight'],
  ]) {
    byId(id)?.addEventListener('change', (event) => {
      studioState[key] = clamp(Math.round(Number(event.currentTarget.value)), 1, MAX_PHOTO_EDGE);
      event.currentTarget.value = String(studioState[key]);
      addHistory('Размер экспорта');
    });
  }
  byId('studio-source-size')?.addEventListener('click', () => {
    syncSourceDimensions(true);
    addHistory('Размер источника');
  });

  for (const [id, key, label] of [
    ['studio-skin', 'skin', 'Мягкая ретушь'],
    ['studio-detail', 'detail', 'Детали'],
  ]) {
    byId(id)?.addEventListener('change', (event) => {
      studioState[key] = event.currentTarget.checked;
      renderPhotoPreview();
      addHistory(`${label}: ${studioState[key] ? 'включено' : 'выключено'}`);
    });
  }

  byId('studio-text-input')?.addEventListener('input', (event) => {
    studioState.text = event.currentTarget.value;
    renderTextOverlays();
  });
  byId('studio-text-input')?.addEventListener('change', () => {
    if (studioState.text) addHistory('Текст добавлен');
  });
  byId('studio-text-size')?.addEventListener('input', (event) => {
    studioState.textSize = Number(event.currentTarget.value);
    renderTextOverlays();
  });
  byId('studio-text-color')?.addEventListener('input', (event) => {
    studioState.textColor = event.currentTarget.value;
    renderTextOverlays();
  });

  document.querySelectorAll('[data-studio-draw-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      studioState.drawTool = button.dataset.studioDrawTool || 'pen';
      document.querySelectorAll('[data-studio-draw-tool]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });
  byId('studio-draw-color')?.addEventListener('input', (event) => { studioState.drawColor = event.currentTarget.value; });
  byId('studio-draw-size')?.addEventListener('input', (event) => { studioState.drawSize = Number(event.currentTarget.value); });
  byId('studio-draw-toggle')?.addEventListener('click', () => toggleDrawing());
  byId('studio-draw-clear')?.addEventListener('click', () => {
    if (studioState.annotations.length === 0) return;
    studioState.annotations = [];
    renderAnnotations();
    addHistory('Разметка очищена');
  });

  byId('studio-reset')?.addEventListener('click', () => resetPhotoEditor(true));
  byId('studio-photo-format')?.addEventListener('change', (event) => {
    studioState.photoFormat = ['png', 'jpeg', 'webp'].includes(event.currentTarget.value) ? event.currentTarget.value : 'png';
    renderSaveLabel();
  });
  byId('studio-save')?.addEventListener('click', () => {
    void (studioState.mode === 'photo' ? exportPhoto() : exportVideo());
  });
}

function bindVideoEditor() {
  const video = byId('studio-video');
  byId('studio-play')?.addEventListener('click', () => {
    if (!video?.src) return setStudioStatus('Сначала добавь видео.', 'error');
    if (video.paused) void video.play();
    else video.pause();
  });

  video?.addEventListener('play', () => renderPlayState(true));
  video?.addEventListener('pause', () => renderPlayState(false));
  video?.addEventListener('ended', () => renderPlayState(false));
  video?.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const progress = clamp(video.currentTime / video.duration * 100, 0, 100);
    byId('studio-timeline-progress').style.width = `${progress}%`;
    byId('studio-timeline-label').textContent = `${formatMediaTime(video.currentTime)} / ${formatMediaTime(video.duration)}`;
    const end = readTrimWindow(video.duration).end;
    if (!studioState.exporting && video.currentTime >= end && end < video.duration) video.pause();
  });
  video?.addEventListener('loadedmetadata', () => {
    renderTrimLabels();
    byId('studio-timeline-label').textContent = `0:00 / ${formatMediaTime(video.duration)}`;
  });
  video?.addEventListener('error', () => setStudioStatus('Этот видеокодек не открылся. Попробуй MP4 H.264 или WebM.', 'error'));

  for (const id of ['studio-trim-start', 'studio-trim-end']) {
    byId(id)?.addEventListener('input', () => {
      enforceTrimOrder(id);
      renderTrimLabels();
    });
  }
  byId('studio-speed')?.addEventListener('change', (event) => {
    if (video) video.playbackRate = Number(event.currentTarget.value);
  });
  byId('studio-volume')?.addEventListener('input', (event) => {
    const volume = Number(event.currentTarget.value);
    if (video) video.volume = volume / 100;
    byId('studio-volume-output').textContent = `${volume}%`;
  });
  byId('studio-video-text')?.addEventListener('input', (event) => {
    studioState.videoText = event.currentTarget.value;
    renderTextOverlays();
  });
}

function bindMediaInputs() {
  document.querySelectorAll('[data-studio-open-media]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.studioOpenMedia || studioState.mode;
      byId(mode === 'video' ? 'studio-video-input' : 'studio-photo-input')?.click();
    });
  });

  byId('studio-mode')?.addEventListener('change', (event) => switchStudioMode(event.currentTarget.value));
  byId('studio-photo-input')?.addEventListener('change', (event) => void openPhotoFile(event.currentTarget.files?.[0]));
  byId('studio-video-input')?.addEventListener('change', (event) => openVideoFile(event.currentTarget.files?.[0]));
  window.addEventListener('beforeunload', () => revokeVideoUrl());
}

function switchStudioMode(mode) {
  studioState.mode = mode === 'video' ? 'video' : 'photo';
  const isVideo = studioState.mode === 'video';
  const editor = document.querySelector('.studio-editor');
  if (editor) editor.dataset.editorMode = studioState.mode;
  byId('studio-photo-preview').hidden = isVideo;
  byId('studio-video-preview').hidden = !isVideo;
  byId('studio-photo-tools').hidden = isVideo;
  byId('studio-video-tools').hidden = !isVideo;
  document.querySelector('.studio-history-area').hidden = isVideo;
  byId('studio-video-timeline').hidden = !isVideo;
  byId('studio-photo-format-control').hidden = isVideo;
  document.querySelectorAll('[data-studio-open-media]').forEach((button) => {
    if (button.closest('.studio-video-empty')) return;
    button.dataset.studioOpenMedia = studioState.mode;
    const text = button.lastChild;
    if (text?.nodeType === Node.TEXT_NODE) text.textContent = isVideo ? 'Открыть видео' : 'Открыть другое фото';
  });
  renderSaveLabel();
  setStudioStatus(isVideo
    ? (studioState.videoUrl ? 'Видео готово к монтажу · экспорт WebM работает локально' : 'Добавь видео, задай границы и экспортируй WebM')
    : 'Фото готово к обработке · всё работает локально');
}

async function openPhotoFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    return setStudioStatus('Поддерживаются PNG, JPEG и WebP.', 'error');
  }
  if (file.size > 50 * 1024 * 1024) {
    return setStudioStatus('Фото больше 50 МБ. Выбери файл поменьше.', 'error');
  }
  try {
    studioState.sourceImageUrl = await readFileAsDataUrl(file);
    studioState.sourceImageName = file.name;
    for (const id of ['studio-photo-before', 'studio-photo-after']) byId(id).src = studioState.sourceImageUrl;
    resetPhotoEditor(false);
    addHistory('Фото открыто');
    setStudioStatus(`${file.name} · обработка остаётся в браузере`, 'success');
  } catch (error) {
    setStudioStatus(`Не удалось открыть фото: ${readErrorMessage(error)}`, 'error');
  }
}

function openVideoFile(file) {
  if (!file) return;
  if (!/^video\/(mp4|webm|quicktime)$/i.test(file.type)) {
    return setStudioStatus('Поддерживаются MP4, WebM и MOV.', 'error');
  }
  revokeVideoUrl();
  studioState.videoUrl = URL.createObjectURL(file);
  studioState.videoName = file.name;
  const video = byId('studio-video');
  video.src = studioState.videoUrl;
  video.load();
  byId('studio-video-empty').hidden = true;
  video.hidden = false;
  byId('studio-trim-start').value = '0';
  byId('studio-trim-end').value = '100';
  setStudioStatus(`${file.name} · готовлю локальный предпросмотр`, 'success');
}

function revokeVideoUrl() {
  if (!studioState.videoUrl) return;
  URL.revokeObjectURL(studioState.videoUrl);
  studioState.videoUrl = '';
}

function applyPreset(name) {
  const preset = STUDIO_PRESETS[name] || STUDIO_PRESETS.auto;
  for (const key of ['exposure', 'contrast', 'saturation', 'warmth']) studioState[key] = preset[key];
  document.querySelectorAll('[data-studio-preset]').forEach((button) => {
    const active = button.dataset.studioPreset === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  syncAdjustmentInputs();
  renderPhotoPreview();
  addHistory(preset.label);
}

function clearSelectedPreset() {
  document.querySelectorAll('[data-studio-preset]').forEach((button) => {
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
  });
}

function resetPhotoEditor(recordHistory) {
  Object.assign(studioState, {
    ratio: 'original', rotation: 0, flipX: false, flipY: false,
    exposure: STUDIO_PRESETS.auto.exposure,
    contrast: STUDIO_PRESETS.auto.contrast,
    saturation: STUDIO_PRESETS.auto.saturation,
    warmth: STUDIO_PRESETS.auto.warmth,
    skin: false, detail: false, text: '', textSize: 42, textColor: '#ffffff',
    annotations: [], drawingActive: false,
  });
  byId('studio-split').value = '34';
  byId('studio-photo-preview').style.setProperty('--studio-split', '34%');
  byId('studio-skin').checked = false;
  byId('studio-detail').checked = false;
  byId('studio-text-input').value = '';
  byId('studio-text-size').value = '42';
  byId('studio-text-color').value = '#ffffff';
  byId('studio-flip-x').classList.remove('active');
  byId('studio-flip-y').classList.remove('active');
  byId('studio-draw-toggle').classList.remove('active');
  byId('studio-draw-toggle').textContent = 'Начать рисовать';
  byId('studio-annotation-canvas').classList.remove('drawing-active');
  byId('studio-photo-preview').classList.remove('drawing-active');
  document.querySelectorAll('[data-studio-ratio]').forEach((button) => button.classList.toggle('active', button.dataset.studioRatio === 'original'));
  document.querySelectorAll('[data-studio-preset]').forEach((button) => {
    const active = button.dataset.studioPreset === 'auto';
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  syncAdjustmentInputs();
  renderPhotoPreview();
  if (recordHistory) {
    studioState.history = [];
    studioState.historyCursor = -1;
    addHistory('Сброс настроек');
    setStudioStatus('Настройки сброшены.', 'success');
  } else if (studioState.history.length === 0) {
    addHistory('Автоулучшение');
  }
}

function syncAdjustmentInputs() {
  for (const key of ['exposure', 'contrast', 'saturation', 'warmth']) {
    byId(`studio-${key}`).value = String(studioState[key]);
    byId(`studio-${key}-output`).textContent = String(studioState[key]);
  }
}

function renderPhotoPreview() {
  const preview = byId('studio-photo-preview');
  if (!preview) return;
  preview.dataset.ratio = studioState.ratio;
  preview.style.aspectRatio = studioState.ratio === 'original' ? '' : studioState.ratio;
  preview.style.setProperty('--studio-filter', buildPhotoFilter(studioState));
  preview.style.setProperty('--studio-rotation', `${studioState.rotation}deg`);
  preview.style.setProperty('--studio-rotation-scale', studioState.rotation % 180 === 0 ? '1' : '1.18');
  preview.style.setProperty('--studio-flip-x', studioState.flipX ? '-1' : '1');
  preview.style.setProperty('--studio-flip-y', studioState.flipY ? '-1' : '1');
  renderTextOverlays();
  renderAnnotations();
}

function renderTextOverlays() {
  const photoText = byId('studio-text-overlay');
  photoText.textContent = studioState.text;
  photoText.hidden = !studioState.text;
  photoText.style.fontSize = `${studioState.textSize}px`;
  photoText.style.color = studioState.textColor;
  const videoText = byId('studio-video-overlay');
  videoText.textContent = studioState.videoText;
  videoText.hidden = !studioState.videoText;
}

function syncSourceDimensions(recordHistory) {
  const image = byId('studio-photo-after');
  if (!image?.naturalWidth || !image.naturalHeight) return;
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  studioState.outputWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  studioState.outputHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  byId('studio-output-width').value = String(studioState.outputWidth);
  byId('studio-output-height').value = String(studioState.outputHeight);
  if (recordHistory) setStudioStatus(`Размер ${studioState.outputWidth}×${studioState.outputHeight}px`, 'success');
}

function bindAnnotationCanvas() {
  const canvas = byId('studio-annotation-canvas');
  const preview = byId('studio-photo-preview');
  if (!canvas || !preview) return;
  let current = null;

  const begin = (event) => {
    if (!studioState.drawingActive) return;
    canvas.setPointerCapture(event.pointerId);
    const point = annotationPoint(event, canvas);
    current = {
      tool: studioState.drawTool,
      color: studioState.drawColor,
      size: studioState.drawSize,
      points: [point],
    };
    studioState.annotations.push(current);
    renderAnnotations();
  };
  const move = (event) => {
    if (!current || !studioState.drawingActive) return;
    const point = annotationPoint(event, canvas);
    if (current.tool === 'pen') current.points.push(point);
    else current.points[1] = point;
    renderAnnotations();
  };
  const finish = (event) => {
    if (!current) return;
    if (current.points.length === 1 && current.tool !== 'pen') current.points.push(annotationPoint(event, canvas));
    current = null;
    addHistory('Разметка');
  };
  canvas.addEventListener('pointerdown', begin);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  new ResizeObserver(() => renderAnnotations()).observe(preview);
}

function toggleDrawing(force) {
  studioState.drawingActive = typeof force === 'boolean' ? force : !studioState.drawingActive;
  const canvas = byId('studio-annotation-canvas');
  const button = byId('studio-draw-toggle');
  canvas?.classList.toggle('drawing-active', studioState.drawingActive);
  byId('studio-photo-preview')?.classList.toggle('drawing-active', studioState.drawingActive);
  button?.classList.toggle('active', studioState.drawingActive);
  if (button) button.textContent = studioState.drawingActive ? 'Закончить рисование' : 'Начать рисовать';
  if (studioState.drawingActive) {
    byId('studio-split').value = '8';
    byId('studio-photo-preview')?.style.setProperty('--studio-split', '8%');
    setStudioStatus('Рисуй прямо на фото. Источник останется без изменений.');
  }
}

function annotationPoint(event, canvas) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1),
    y: clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1),
  };
}

function renderAnnotations() {
  const canvas = byId('studio-annotation-canvas');
  if (!canvas) return;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const density = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(bounds.width * density));
  const height = Math.max(1, Math.round(bounds.height * density));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  drawAnnotations(context, studioState.annotations, width, height, density);
}

function drawAnnotations(context, annotations, width, height, density = 1) {
  for (const item of annotations) {
    if (!Array.isArray(item.points) || item.points.length === 0) continue;
    context.save();
    context.strokeStyle = item.color || '#ff8428';
    context.lineWidth = Math.max(1, Number(item.size || 8) * density);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    const first = item.points[0];
    const last = item.points.at(-1) || first;
    if (item.tool === 'rectangle') {
      context.rect(first.x * width, first.y * height, (last.x - first.x) * width, (last.y - first.y) * height);
    } else if (item.tool === 'ellipse') {
      const centerX = (first.x + last.x) * width / 2;
      const centerY = (first.y + last.y) * height / 2;
      const radiusX = Math.abs(last.x - first.x) * width / 2;
      const radiusY = Math.abs(last.y - first.y) * height / 2;
      if (radiusX < 0.5 || radiusY < 0.5) context.arc(first.x * width, first.y * height, Math.max(1, context.lineWidth / 2), 0, Math.PI * 2);
      else context.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
    } else {
      context.moveTo(first.x * width, first.y * height);
      for (const point of item.points.slice(1)) context.lineTo(point.x * width, point.y * height);
      if (item.points.length === 1) context.lineTo(first.x * width + 0.1, first.y * height + 0.1);
    }
    context.stroke();
    context.restore();
  }
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (!studioState.active || isEditableTarget(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      stepStudioHistory(event.shiftKey ? 1 : -1);
    } else if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void (studioState.mode === 'photo' ? exportPhoto() : exportVideo());
    } else if (event.code === 'Space' && studioState.mode === 'video') {
      event.preventDefault();
      byId('studio-play')?.click();
    }
  });
}

function isEditableTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function toggleAccordion(button) {
  const group = button.closest('.studio-tool-group');
  const content = group?.querySelector('.studio-tool-content');
  if (!group || !content) return;
  const expanded = content.hidden;
  content.hidden = !expanded;
  group.classList.toggle('open', expanded);
  button.setAttribute('aria-expanded', String(expanded));
  const caret = button.querySelector('.studio-caret');
  if (caret) caret.src = `${ICON_ROOT}/${expanded ? 'caret-up' : 'caret-down'}.svg`;
}

function addHistory(label) {
  const snapshot = {
    label,
    ratio: studioState.ratio,
    rotation: studioState.rotation,
    flipX: studioState.flipX,
    flipY: studioState.flipY,
    outputWidth: studioState.outputWidth,
    outputHeight: studioState.outputHeight,
    exposure: studioState.exposure,
    contrast: studioState.contrast,
    saturation: studioState.saturation,
    warmth: studioState.warmth,
    skin: studioState.skin,
    detail: studioState.detail,
    text: studioState.text,
    textSize: studioState.textSize,
    textColor: studioState.textColor,
    annotations: cloneAnnotations(studioState.annotations),
  };
  if (studioState.historyCursor < studioState.history.length - 1) {
    studioState.history = studioState.history.slice(0, studioState.historyCursor + 1);
  }
  const previous = studioState.history[studioState.historyCursor];
  if (previous && JSON.stringify({ ...previous, label: '' }) === JSON.stringify({ ...snapshot, label: '' })) return;
  studioState.history.push(snapshot);
  studioState.history = studioState.history.slice(-8);
  studioState.historyCursor = studioState.history.length - 1;
  renderHistory();
}

function renderHistory() {
  const region = byId('studio-history');
  if (!region) return;
  region.innerHTML = studioState.history.map((entry, index) => `
    <button type="button" data-studio-history-index="${index}" class="${index === studioState.historyCursor ? 'active' : ''}">
      ${escapeHtml(entry.label)}<img src="${ICON_ROOT}/arrow-counter-clockwise.svg" alt="Вернуться к этому шагу">
    </button>`).join('');
  region.querySelectorAll('[data-studio-history-index]').forEach((button) => {
    button.addEventListener('click', () => restoreHistory(Number(button.dataset.studioHistoryIndex)));
  });
}

function restoreHistory(index) {
  const snapshot = studioState.history[index];
  if (!snapshot) return;
  Object.assign(studioState, snapshot, { annotations: cloneAnnotations(snapshot.annotations) });
  studioState.historyCursor = index;
  syncAdjustmentInputs();
  byId('studio-skin').checked = studioState.skin;
  byId('studio-detail').checked = studioState.detail;
  byId('studio-text-input').value = studioState.text;
  byId('studio-text-size').value = String(studioState.textSize);
  byId('studio-text-color').value = studioState.textColor;
  byId('studio-output-width').value = String(studioState.outputWidth);
  byId('studio-output-height').value = String(studioState.outputHeight);
  byId('studio-flip-x').classList.toggle('active', studioState.flipX);
  byId('studio-flip-y').classList.toggle('active', studioState.flipY);
  toggleDrawing(false);
  document.querySelectorAll('[data-studio-ratio]').forEach((button) => button.classList.toggle('active', button.dataset.studioRatio === studioState.ratio));
  clearSelectedPreset();
  renderPhotoPreview();
  renderHistory();
  setStudioStatus(`Возвращено: ${snapshot.label}`, 'success');
}

function stepStudioHistory(direction) {
  const next = clamp(studioState.historyCursor + direction, 0, studioState.history.length - 1);
  if (next === studioState.historyCursor || !studioState.history[next]) return;
  restoreHistory(next);
}

async function exportPhoto() {
  if (studioState.exporting) return;
  studioState.exporting = true;
  setStudioBusy(true, 'Сохраняю…');
  try {
    const image = await loadImage(studioState.sourceImageUrl);
    const requestedWidth = studioState.outputWidth || image.naturalWidth || image.width;
    const requestedHeight = studioState.outputHeight || image.naturalHeight || image.height;
    const dimensions = photoExportDimensions(requestedWidth, requestedHeight, studioState.ratio);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas недоступен');
    context.fillStyle = '#101110';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.filter = buildPhotoFilter(studioState);
    drawCover(context, image, canvas.width, canvas.height, studioState.rotation, studioState.flipX, studioState.flipY);
    context.filter = 'none';
    const previewWidth = byId('studio-photo-preview')?.getBoundingClientRect().width || canvas.width;
    drawAnnotations(context, studioState.annotations, canvas.width, canvas.height, canvas.width / previewWidth);
    drawCanvasText(context, studioState.text, canvas.width, canvas.height, studioState.textSize, studioState.textColor);
    const format = studioState.photoFormat;
    const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const extension = format === 'jpeg' ? 'jpg' : format;
    const blob = await canvasToBlob(canvas, mimeType, format === 'png' ? undefined : 0.92);
    downloadBlob(blob, `${withoutExtension(studioState.sourceImageName || 'monarch-studio')}-edited.${extension}`);
    setStudioStatus(`${format.toUpperCase()} ${canvas.width}×${canvas.height} сохранён локально.`, 'success');
  } catch (error) {
    setStudioStatus(`Не удалось сохранить фото: ${readErrorMessage(error)}`, 'error');
  } finally {
    studioState.exporting = false;
    setStudioBusy(false);
  }
}

async function exportVideo() {
  const video = byId('studio-video');
  if (studioState.exporting) return;
  if (!video?.src || !Number.isFinite(video.duration)) return setStudioStatus('Сначала добавь и дождись загрузки видео.', 'error');
  const mimeType = pickMediaRecorderMime();
  if (!mimeType || !HTMLCanvasElement.prototype.captureStream) return setStudioStatus('В этом браузере недоступен локальный WebM-экспорт.', 'error');

  studioState.exporting = true;
  setStudioBusy(true, 'Экспорт 0%');
  const original = {
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    volume: video.volume,
    muted: video.muted,
  };
  let outputStream = null;
  let recorder = null;
  try {
    const trim = readTrimWindow(video.duration);
    const speed = Number(byId('studio-speed').value);
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, MAX_VIDEO_WIDTH / sourceWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(sourceWidth * scale));
    canvas.height = Math.max(2, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas недоступен');

    const canvasStream = canvas.captureStream(30);
    const sourceStream = typeof video.captureStream === 'function' ? video.captureStream() : null;
    const audioTracks = sourceStream?.getAudioTracks?.() || [];
    outputStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
    recorder = new MediaRecorder(outputStream, { mimeType, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.addEventListener('error', () => reject(recorder.error || new Error('MediaRecorder error')), { once: true });
    });

    await seekVideo(video, trim.start);
    video.playbackRate = speed;
    video.volume = Number(byId('studio-volume').value) / 100;
    video.muted = false;
    recorder.start(500);
    await video.play();
    await renderVideoFrames({ video, context, canvas, start: trim.start, end: trim.end });
    video.pause();
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) throw new Error('Экспорт получился пустым');
    downloadBlob(blob, `${withoutExtension(studioState.videoName || 'monarch-studio')}-edited.webm`);
    setStudioStatus(`WebM сохранён · ${formatBytes(blob.size)}${audioTracks.length ? '' : ' · без аудио'}`, 'success');
  } catch (error) {
    setStudioStatus(`Не удалось экспортировать видео: ${readErrorMessage(error)}`, 'error');
  } finally {
    video.pause();
    if (recorder?.state && recorder.state !== 'inactive') recorder.stop();
    outputStream?.getTracks().forEach((track) => track.stop());
    video.playbackRate = original.playbackRate;
    video.volume = original.volume;
    video.muted = original.muted;
    await seekVideo(video, Math.min(original.currentTime, video.duration || original.currentTime)).catch(() => undefined);
    studioState.exporting = false;
    setStudioBusy(false);
  }
}

function renderVideoFrames({ video, context, canvas, start, end }) {
  return new Promise((resolve, reject) => {
    let animationId = 0;
    const deadline = Date.now() + Math.max(20_000, (end - start) / Math.max(0.25, video.playbackRate) * 1_000 + 15_000);
    const render = () => {
      try {
        if (Date.now() > deadline) throw new Error('Экспорт остановлен: видео перестало воспроизводиться');
        if (video.error) throw new Error('Ошибка декодирования видео');
        context.fillStyle = '#080908';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        drawCanvasText(context, studioState.videoText, canvas.width, canvas.height, Math.max(24, canvas.width * 0.04), '#ffffff');
        const percent = clamp((video.currentTime - start) / Math.max(0.01, end - start) * 100, 0, 100);
        setStudioBusy(true, `Экспорт ${Math.round(percent)}%`);
        if (video.currentTime >= end || video.ended) {
          resolve();
          return;
        }
        animationId = requestAnimationFrame(render);
      } catch (error) {
        cancelAnimationFrame(animationId);
        reject(error);
      }
    };
    animationId = requestAnimationFrame(render);
  });
}

function bindBuilder() {
  const form = byId('module-builder-form');
  const name = byId('module-builder-name');
  const id = byId('module-builder-id');
  let idEdited = false;
  id?.addEventListener('input', () => { idEdited = true; invalidateBuilderPreview(); });
  name?.addEventListener('input', () => {
    if (!idEdited || !id.value) id.value = slugifyModuleName(name.value);
    invalidateBuilderPreview();
  });
  for (const elementId of ['module-builder-description', 'module-builder-template', 'module-builder-parent']) {
    byId(elementId)?.addEventListener('input', invalidateBuilderPreview);
  }
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void previewModuleScaffold();
  });
  byId('module-builder-create')?.addEventListener('click', () => void createModuleScaffold());
}

function readModuleDraft() {
  const standalone = byId('module-builder-parent').value === 'standalone';
  return {
    id: byId('module-builder-id').value.trim(),
    name: byId('module-builder-name').value.trim(),
    description: byId('module-builder-description').value.trim(),
    template: byId('module-builder-template').value,
    kind: byId('module-builder-template').value === 'workspace-tool' ? 'tooling' : 'domain',
    standalone,
  };
}

function invalidateBuilderPreview() {
  byId('module-builder-create').disabled = true;
  byId('module-scaffold-preview').hidden = true;
  setBuilderStatus('Изменения ещё не проверены. Покажи файлы заново.');
}

async function previewModuleScaffold() {
  const form = byId('module-builder-form');
  if (!form?.reportValidity()) return;
  setBuilderStatus('Проверяю контракт и собираю предпросмотр…');
  byId('module-builder-create').disabled = true;
  try {
    const payload = await executeCapability('monarch-modules', 'monarch-modules.scaffold.preview', readModuleDraft(), 'studio-ui', false);
    const result = unwrapCapabilityResponse(payload);
    if (!result?.ok) throw new Error(result?.summary || result?.error || 'Предпросмотр не создан');
    const output = result.output || {};
    renderScaffoldPreview(output);
    byId('module-builder-create').disabled = false;
    markBuilderStep(1);
    setBuilderStatus(`${result.summary} Файлы ещё не записаны.`, 'success');
  } catch (error) {
    setBuilderStatus(readErrorMessage(error), 'error');
  }
}

async function createModuleScaffold() {
  const button = byId('module-builder-create');
  if (button.disabled) return;
  button.disabled = true;
  setBuilderStatus('Создаю новый каталог без перезаписи существующих файлов…');
  try {
    const result = await executeConfirmedCapability('monarch-modules', 'monarch-modules.scaffold.create', readModuleDraft(), 'studio-ui');
    if (!result?.ok) throw new Error(result?.summary || result?.error || 'Модуль не создан');
    markBuilderStep(2);
    setBuilderStatus(result.summary, 'success');
    await loadModuleLibrary();
  } catch (error) {
    setBuilderStatus(readErrorMessage(error), 'error');
    button.disabled = false;
  }
}

function renderScaffoldPreview(output) {
  const region = byId('module-scaffold-preview');
  const files = Array.isArray(output.files) ? output.files : [];
  region.innerHTML = `
    <div class="module-scaffold-target"><span>Будет создано</span><code>${escapeHtml(output.target || '')}</code></div>
    ${files.map((file) => `
      <article class="module-scaffold-file">
        <img src="${ICON_ROOT}/square.svg" alt="">
        <strong>${escapeHtml(file.path || '')}</strong>
        <small>${String(file.content || '').split(/\r?\n/).length} строк</small>
      </article>`).join('')}
    <p>Каталог не меняется автоматически: сначала проверь manifest, тест и точку регистрации.</p>`;
  region.hidden = false;
}

function markBuilderStep(lastActiveIndex) {
  document.querySelectorAll('.module-builder-steps li').forEach((step, index) => {
    step.classList.toggle('active', index <= lastActiveIndex);
  });
}

function bindLibrary() {
  byId('module-library-refresh')?.addEventListener('click', () => void loadModuleLibrary());
}

async function loadModuleLibrary() {
  setLibraryStatus('Обновляю локальный каталог…');
  try {
    const payload = await executeCapability('monarch-modules', 'monarch-modules.catalog.list', {}, 'studio-ui', false);
    const result = unwrapCapabilityResponse(payload);
    if (!result?.ok) throw new Error(result?.summary || result?.error || 'Каталог недоступен');
    const modules = Array.isArray(result.output?.modules) ? result.output.modules : [];
    renderModuleLibrary(modules);
    setLibraryStatus(`${modules.length} модулей внутри Monarch Modules`, 'success');
  } catch (error) {
    setLibraryStatus(readErrorMessage(error), 'error');
  }
}

function renderModuleLibrary(modules) {
  const grid = byId('module-library-grid');
  const cards = modules.map((module) => `
    <article class="module-library-card ${module.id === 'studio' ? 'featured' : ''}">
      <div class="module-card-icon"><img src="${ICON_ROOT}/${module.id === 'studio' ? 'image' : 'cube'}.svg" alt=""></div>
      <div><span>${escapeHtml(module.stage ? `${module.stage} · ${module.status || 'registered'}` : module.status || 'registered')}</span><h3>${escapeHtml(module.name || module.id)}</h3><p>${escapeHtml(module.description || '')}</p></div>
      ${module.id === 'studio' ? '<button type="button" data-open-studio>Открыть Studio</button>' : `<button type="button" disabled>${Number(module.capabilities || 0)} возможностей</button>`}
    </article>`).join('');
  grid.innerHTML = `${cards}
    <article class="module-library-card create-card">
      <div class="module-card-icon"><img src="${ICON_ROOT}/magic-wand.svg" alt=""></div>
      <div><span>Guided Builder</span><h3>Создать следующий</h3><p>Выбери рецепт, посмотри каждый файл и создай безопасный scaffold.</p></div>
      <button type="button" data-open-builder>Начать</button>
    </article>`;
  grid.querySelector('[data-open-studio]')?.addEventListener('click', () => openModulesPanel('studio'));
  grid.querySelector('[data-open-builder]')?.addEventListener('click', () => openModulesPanel('builder'));
}

function renderTrimLabels() {
  const video = byId('studio-video');
  const duration = Number.isFinite(video?.duration) ? video.duration : 0;
  const trim = readTrimWindow(duration);
  byId('studio-trim-start-output').textContent = formatMediaTime(trim.start);
  byId('studio-trim-end-output').textContent = formatMediaTime(trim.end);
}

function enforceTrimOrder(changedId) {
  const start = byId('studio-trim-start');
  const end = byId('studio-trim-end');
  if (Number(start.value) < Number(end.value)) return;
  if (changedId === 'studio-trim-start') start.value = String(Math.max(0, Number(end.value) - 1));
  else end.value = String(Math.min(100, Number(start.value) + 1));
}

function readTrimWindow(duration) {
  const startPercent = Number(byId('studio-trim-start')?.value || 0);
  const endPercent = Number(byId('studio-trim-end')?.value || 100);
  return { start: duration * startPercent / 100, end: duration * endPercent / 100 };
}

function renderPlayState(playing) {
  const button = byId('studio-play');
  const icon = button?.querySelector('img');
  if (icon) icon.src = `${ICON_ROOT}/${playing ? 'pause' : 'play'}.svg`;
  button?.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
}

function setStudioBusy(busy, label = '') {
  const button = byId('studio-save');
  if (!button) return;
  button.disabled = busy;
  const span = button.querySelector('span');
  if (span) span.textContent = busy ? label : saveLabel();
}

function renderSaveLabel() {
  const span = byId('studio-save')?.querySelector('span');
  if (span) span.textContent = saveLabel();
}

function saveLabel() {
  return studioState.mode === 'video' ? 'Экспорт WebM' : `Сохранить ${studioState.photoFormat.toUpperCase()}`;
}

function setStudioStatus(message, tone = '') {
  setStatus(byId('studio-status'), message, tone);
}

function setBuilderStatus(message, tone = '') {
  setStatus(byId('module-builder-status'), message, tone);
}

function setLibraryStatus(message, tone = '') {
  setStatus(byId('module-library-status'), message, tone);
}

function setStatus(element, message, tone) {
  if (!element) return;
  element.textContent = String(message || '');
  element.classList.toggle('error', tone === 'error');
  element.classList.toggle('success', tone === 'success');
}

function photoExportDimensions(width, height, ratio) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(safeWidth, safeHeight));
  let outputWidth = Math.round(safeWidth * scale);
  let outputHeight = Math.round(safeHeight * scale);
  const parsedRatio = parseRatio(ratio);
  if (parsedRatio) {
    if (outputWidth / outputHeight > parsedRatio) outputWidth = Math.round(outputHeight * parsedRatio);
    else outputHeight = Math.round(outputWidth / parsedRatio);
  }
  return { width: Math.max(1, outputWidth), height: Math.max(1, outputHeight) };
}

function parseRatio(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  return Number(match[1]) / Number(match[2]);
}

function drawCover(context, image, width, height, rotation, flipX = false, flipY = false) {
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  const swapped = rotation % 180 !== 0;
  const targetWidth = swapped ? height : width;
  const targetHeight = swapped ? width : height;
  const scale = Math.max(targetWidth / image.naturalWidth, targetHeight / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
}

function drawCanvasText(context, text, width, height, size, color) {
  const value = String(text || '').trim();
  if (!value) return;
  const fontSize = clamp(Number(size), 18, Math.max(24, width / 8));
  context.save();
  context.font = `600 ${fontSize}px Inter, Arial, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.fillStyle = color || '#ffffff';
  context.shadowColor = 'rgba(0, 0, 0, 0.72)';
  context.shadowBlur = Math.max(8, fontSize * 0.3);
  context.shadowOffsetY = Math.max(2, fontSize * 0.06);
  const maxWidth = width * 0.82;
  const lines = wrapCanvasText(context, value, maxWidth).slice(0, 3);
  const lineHeight = fontSize * 1.12;
  let y = height * 0.9 - (lines.length - 1) * lineHeight;
  for (const line of lines) {
    context.fillText(line, width / 2, y, maxWidth);
    y += lineHeight;
  }
  context.restore();
}

function wrapCanvasText(context, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Изображение не загрузилось'));
    image.src = source;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Ошибка чтения файла'));
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Браузер не создал файл')), type, quality);
  });
}

function seekVideo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.02) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Не удалось перейти к выбранному кадру')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = time;
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function withoutExtension(filename) {
  return String(filename || '').replace(/\.[^.]+$/, '').replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'monarch-studio';
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function cloneAnnotations(annotations) {
  return Array.isArray(annotations)
    ? annotations.map((item) => ({
      ...item,
      points: Array.isArray(item.points) ? item.points.map((point) => ({ ...point })) : [],
    }))
    : [];
}

function clamp(value, min, max) {
  const numeric = Number.isFinite(value) ? value : 0;
  return Math.min(max, Math.max(min, numeric));
}
