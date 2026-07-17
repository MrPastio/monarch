import {
  executeCapability,
  executeConfirmedCapability,
} from './api.js';
import { escapeHtml, readErrorMessage } from './utils.js';

const DEFAULT_CONNECTION = {
  baseUrl: 'http://127.0.0.1:7861/v1',
  endpoints: {
    models: 'http://127.0.0.1:7861/v1/models',
    chatCompletions: 'http://127.0.0.1:7861/v1/chat/completions',
    audioModels: 'http://127.0.0.1:7861/v1/audio/models',
    audioSpeech: 'http://127.0.0.1:7861/v1/audio/speech',
  },
  authentication: {
    type: 'bearer',
    tokenPath: 'secrets\\oscar_token.txt',
    configured: false,
  },
};

const PRESET_KEY = 'monarch.sharing.preset';
const MODEL_KEY = 'monarch.sharing.model';
const TTS_MODEL_KEY = 'monarch.sharing.tts-model';
const SUPER_FAST_MODEL_IDS = new Set(['qwen2.5-0.5b-instruct', 'qwen3-1.7b-instruct']);
const KNOWN_MODELS = {
  'monarch-auto': ['Auto', 'Monarch выберет локальную модель под запрос.'],
  'monarch-fast': ['Fast', 'Быстрые ответы и лёгкие интеграции.'],
  'monarch-balanced': ['Balanced', 'Основной профиль качества и скорости.'],
  'monarch-deep': ['Deep', 'Сложные задачи с reasoning_effort=high.'],
  'monarch-extra': ['Extra', 'Самый крупный установленный локальный профиль.'],
  'qwen2.5-0.5b-instruct': ['Qwen2.5 0.5B', 'Super Fast: самый лёгкий локальный Qwen для коротких ответов.'],
  'qwen3-1.7b-instruct': ['Qwen3 1.7B', 'Super Fast: быстрый Qwen3 без вывода thinking trace.'],
};
const KNOWN_TTS_MODELS = {
  'qwen3-tts-0.6b-base': ['Qwen3-TTS 0.6B Base', 'Voice clone через встроенные голоса Oscar, Oscar Clear и Aurora.'],
  'qwen3-tts-0.6b-custom': ['Qwen3-TTS 0.6B CustomVoice', 'Встроенные Qwen timbres с естественной стилевой инструкцией.'],
  'qwen3-tts-1.7b-voice-design': ['Qwen3-TTS 1.7B Voice Design', 'Крупная модель для проектирования голоса по описанию.'],
};

const ui = {
  status: null,
  busy: false,
  starting: false,
  loaded: false,
  error: '',
  feedback: '',
  feedbackKind: 'success',
  preset: readStoredValue(PRESET_KEY, ['fields', 'python', 'node', 'powershell'], 'fields'),
  model: readStoredValue(MODEL_KEY, null, 'monarch-auto'),
  ttsModel: readStoredValue(TTS_MODEL_KEY, null, 'qwen3-tts-0.6b-base'),
};

let initialized = false;

export function initSharingPane() {
  if (initialized) return;
  initialized = true;
  const root = document.querySelector('#sharing-page-root');
  root?.addEventListener('click', handleSharingClick);
  root?.addEventListener('change', handleSharingChange);
  window.addEventListener('monarch:view-change', (event) => {
    if (event.detail?.view === 'sharing-section' && !ui.loaded && !ui.busy) {
      void loadSharingStatus();
    }
  });
}

export function renderSharingPane() {
  const root = document.querySelector('#sharing-page-root');
  if (!root) return;
  if (!ui.loaded) {
    root.innerHTML = '<div class="sharing-loading-state">Проверяю локальный API…</div>';
    return;
  }

  const status = ui.status;
  const connection = status?.connection || DEFAULT_CONNECTION;
  const connected = Boolean(status?.connected);
  const models = Array.isArray(status?.models) ? status.models : [];
  const ttsModels = Array.isArray(status?.ttsModels) ? status.ttsModels : [];
  const modelOptions = uniqueModels(models);
  if (!modelOptions.includes(ui.model)) {
    ui.model = modelOptions.includes('monarch-auto') ? 'monarch-auto' : modelOptions[0];
  }
  if (ttsModels.length && !ttsModels.includes(ui.ttsModel)) {
    ui.ttsModel = ttsModels[0];
  }
  const tokenConfigured = Boolean(connection.authentication?.configured);
  const statusDetail = connected
    ? `${models.length} ${pluralizeModels(models.length)} готовы к подключению.`
    : friendlyOfflineMessage(status?.error || ui.error);
  const snippet = buildSnippet(ui.preset, connection, ui.model);

  root.innerHTML = `
    <section class="sharing-status-card ${connected ? 'is-online' : 'is-offline'}" aria-label="Состояние Monarch Sharing">
      <div class="sharing-status-copy">
        <span class="sharing-status-line"><i aria-hidden="true"></i>${connected ? 'API работает' : 'API не запущен'}</span>
        <h3>${connected ? 'Можно подключать приложение' : 'Запусти локальный сервис в один клик'}</h3>
        <p>${escapeHtml(statusDetail)}</p>
        <div class="sharing-trust-line">
          <span>127.0.0.1</span>
          <span>Только этот компьютер</span>
          <span>Без облака</span>
        </div>
      </div>
      <div class="sharing-status-actions">
        ${connected ? '' : `
          <button class="claude-primary-btn" type="button" data-sharing-action="start" ${ui.starting ? 'disabled' : ''}>
            ${ui.starting ? 'Запускаю…' : 'Запустить API'}
          </button>
        `}
        <button class="claude-ghost-btn" type="button" data-sharing-action="refresh" ${ui.busy || ui.starting ? 'disabled' : ''}>
          ${ui.busy ? 'Проверяю…' : 'Проверить'}
        </button>
      </div>
    </section>

    <div class="sharing-workflow">
      <section class="sharing-connect-panel" aria-labelledby="sharing-connect-title">
        <header class="sharing-section-heading">
          <span>1</span>
          <div>
            <h3 id="sharing-connect-title">Данные подключения</h3>
            <p>Три поля, которые нужны любому OpenAI-compatible приложению.</p>
          </div>
        </header>

        <div class="sharing-field-list">
          ${renderCopyField('Base URL', connection.baseUrl, 'base-url', 'Скопировать URL')}
          <div class="sharing-field-row">
            <div class="sharing-field-copy">
              <span>API key</span>
              <strong>${tokenConfigured ? '••••••••••••••••••••' : 'Ключ ещё не создан'}</strong>
              <small>${escapeHtml(connection.authentication?.tokenPath || DEFAULT_CONNECTION.authentication.tokenPath)}</small>
            </div>
            <button class="sharing-inline-button" type="button" data-sharing-action="copy-token" ${tokenConfigured ? '' : 'disabled'}>
              Скопировать ключ
            </button>
          </div>
          <label class="sharing-field-row sharing-model-field" for="sharing-model-select">
            <span class="sharing-field-copy">
              <span>Model</span>
              <small>Для большинства приложений оставь автоматический выбор.</small>
            </span>
            <select id="sharing-model-select" aria-label="Модель Monarch Sharing">
              ${renderModelOptions(modelOptions)}
            </select>
          </label>
        </div>

        <div class="sharing-connection-actions">
          <button class="claude-primary-btn" type="button" data-sharing-copy="environment">Скопировать настройку окружения</button>
          <span>Работает с OpenAI SDK и большинством локальных AI-клиентов.</span>
        </div>
      </section>

      <section class="sharing-code-panel" aria-labelledby="sharing-code-title">
        <header class="sharing-section-heading">
          <span>2</span>
          <div>
            <h3 id="sharing-code-title">Готовое подключение</h3>
            <p>Выбери формат и вставь без ручной сборки запроса.</p>
          </div>
        </header>

        <div class="sharing-preset-tabs" role="tablist" aria-label="Формат подключения">
          ${renderPresetButton('fields', 'Поля')}
          ${renderPresetButton('python', 'Python')}
          ${renderPresetButton('node', 'Node.js')}
          ${renderPresetButton('powershell', 'PowerShell')}
        </div>
        <div class="sharing-code-frame">
          <button type="button" data-sharing-copy="snippet" aria-label="Скопировать пример подключения">Скопировать</button>
          <pre><code>${escapeHtml(snippet)}</code></pre>
        </div>
      </section>
    </div>

    <section class="sharing-models-panel" aria-labelledby="sharing-models-title">
      <header>
        <div>
          <h3 id="sharing-models-title">Модели в API</h3>
          <p>${connected ? 'Показываются только реально доступные локальные профили.' : 'Список появится после запуска API.'}</p>
        </div>
        <span>${connected ? models.length : '—'}</span>
      </header>
      ${renderModels(models, connected)}
    </section>

    <section class="sharing-tts-panel" aria-labelledby="sharing-tts-title">
      <header>
        <div>
          <span class="sharing-kicker">Audio / WAV</span>
          <h3 id="sharing-tts-title">TTS Models</h3>
          <p>${connected ? 'Отдельный OpenAI-compatible endpoint: модели речи не попадают в chat completions.' : 'TTS-модели появятся после запуска локального API.'}</p>
        </div>
        <span>${connected ? ttsModels.length : '—'}</span>
      </header>
      ${renderTtsModels(ttsModels, connected, status?.ttsError)}
      <div class="sharing-tts-actions">
        <label for="sharing-tts-model-select">TTS model
          <select id="sharing-tts-model-select" aria-label="TTS модель Monarch Sharing" ${ttsModels.length ? '' : 'disabled'}>
            ${ttsModels.map((modelId) => `<option value="${escapeHtml(modelId)}" ${modelId === ui.ttsModel ? 'selected' : ''}>${escapeHtml(modelId)}</option>`).join('')}
          </select>
        </label>
        <button class="sharing-inline-button" type="button" data-sharing-copy="tts-snippet" ${ttsModels.length ? '' : 'disabled'}>Скопировать TTS пример</button>
      </div>
      <small class="sharing-tts-endpoint">${escapeHtml(connection.endpoints?.audioSpeech || `${connection.baseUrl}/audio/speech`)}</small>
    </section>

    <div class="sharing-feedback ${ui.feedbackKind === 'error' ? 'is-error' : ''}" role="status" ${ui.feedback ? '' : 'hidden'}>
      ${escapeHtml(ui.feedback)}
    </div>
  `;
}

export async function loadSharingStatus() {
  ui.busy = true;
  ui.error = '';
  ui.feedback = '';
  renderSharingPane();
  try {
    ui.status = await requestSharingStatus();
    ui.loaded = true;
  } catch (error) {
    ui.loaded = true;
    ui.error = readErrorMessage(error);
    ui.status = {
      connected: false,
      connection: DEFAULT_CONNECTION,
      models: [],
      ttsModels: [],
      error: ui.error,
    };
  } finally {
    ui.busy = false;
    renderSharingPane();
  }
}

async function handleSharingClick(event) {
  const actionButton = event.target.closest('[data-sharing-action]');
  if (actionButton) {
    const action = actionButton.getAttribute('data-sharing-action');
    if (action === 'refresh') await loadSharingStatus();
    if (action === 'start') await startSharingBackend();
    if (action === 'copy-token') await copySharingToken();
    return;
  }

  const presetButton = event.target.closest('[data-sharing-preset]');
  if (presetButton) {
    ui.preset = presetButton.getAttribute('data-sharing-preset') || 'fields';
    ui.feedback = '';
    storeValue(PRESET_KEY, ui.preset);
    renderSharingPane();
    return;
  }

  const modelButton = event.target.closest('[data-sharing-model]');
  if (modelButton) {
    ui.model = modelButton.getAttribute('data-sharing-model') || 'monarch-auto';
    ui.feedback = '';
    storeValue(MODEL_KEY, ui.model);
    renderSharingPane();
    return;
  }

  const ttsModelButton = event.target.closest('[data-sharing-tts-model]');
  if (ttsModelButton) {
    ui.ttsModel = ttsModelButton.getAttribute('data-sharing-tts-model') || 'qwen3-tts-0.6b-base';
    ui.feedback = '';
    storeValue(TTS_MODEL_KEY, ui.ttsModel);
    renderSharingPane();
    return;
  }

  const copyButton = event.target.closest('[data-sharing-copy]');
  if (!copyButton) return;
  const connection = ui.status?.connection || DEFAULT_CONNECTION;
  const value = copyButton.getAttribute('data-sharing-copy') === 'base-url'
    ? connection.baseUrl
    : copyButton.getAttribute('data-sharing-copy') === 'environment'
      ? buildEnvironmentSetup(connection)
      : copyButton.getAttribute('data-sharing-copy') === 'tts-snippet'
        ? buildTtsSnippet(connection, ui.ttsModel)
      : buildSnippet(ui.preset, connection, ui.model);
  try {
    await copyText(value);
    setFeedback('Скопировано. Можно вставлять в приложение.');
  } catch (error) {
    setFeedback(readErrorMessage(error), 'error');
  }
}

function handleSharingChange(event) {
  if (event.target?.id === 'sharing-model-select') {
    ui.model = event.target.value || 'monarch-auto';
    ui.feedback = '';
    storeValue(MODEL_KEY, ui.model);
    renderSharingPane();
    return;
  }
  if (event.target?.id !== 'sharing-tts-model-select') return;
  ui.ttsModel = event.target.value || 'qwen3-tts-0.6b-base';
  ui.feedback = '';
  storeValue(TTS_MODEL_KEY, ui.ttsModel);
  renderSharingPane();
}

async function startSharingBackend() {
  ui.starting = true;
  ui.error = '';
  setFeedback('Запускаю локальный runtime…');
  try {
    await executeConfirmedCapability('oscar', 'oscar.backend.start', {}, 'ui:sharing');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(attempt === 0 ? 250 : 650);
      const status = await requestSharingStatus();
      ui.status = status;
      ui.loaded = true;
      if (status.connected) {
        setFeedback('Monarch Sharing запущен и готов к подключениям.');
        return;
      }
    }
    throw new Error('Backend запущен, но Sharing API пока не ответил. Нажми «Проверить» через несколько секунд.');
  } catch (error) {
    ui.error = readErrorMessage(error);
    setFeedback(ui.error, 'error');
  } finally {
    ui.starting = false;
    renderSharingPane();
  }
}

async function copySharingToken() {
  if (!window.monarchDesktop?.copySharingToken) {
    setFeedback('Безопасное копирование API key доступно в Monarch Desktop.', 'error');
    return;
  }
  try {
    const result = await window.monarchDesktop.copySharingToken();
    if (result?.ok !== true) {
      throw new Error(result?.error === 'token-missing' || result?.error === 'token-empty'
        ? 'API key ещё не создан. Сначала запусти Sharing API.'
        : 'Monarch Desktop не разрешил копирование ключа.');
    }
    setFeedback('API key скопирован безопасно: значение не показывалось в интерфейсе.');
  } catch (error) {
    setFeedback(readErrorMessage(error), 'error');
  }
}

async function requestSharingStatus() {
  const payload = await executeCapability('sharing', 'sharing.status', {}, 'ui:sharing', false);
  const result = payload.result || payload;
  const status = result.output?.status;
  if (!status || typeof status !== 'object') {
    throw new Error(result.summary || result.error || 'Monarch Sharing не вернул состояние API.');
  }
  return status;
}

function renderCopyField(label, value, key, actionLabel) {
  return `
    <div class="sharing-field-row">
      <div class="sharing-field-copy">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
      <button class="sharing-inline-button" type="button" data-sharing-copy="${escapeHtml(key)}">${escapeHtml(actionLabel)}</button>
    </div>
  `;
}

function renderPresetButton(id, label) {
  const selected = ui.preset === id;
  return `<button type="button" role="tab" data-sharing-preset="${id}" aria-selected="${selected}" aria-pressed="${selected}">${label}</button>`;
}

function renderModelOptions(modelOptions) {
  const superFast = modelOptions.filter((modelId) => SUPER_FAST_MODEL_IDS.has(modelId));
  const monarch = modelOptions.filter((modelId) => !SUPER_FAST_MODEL_IDS.has(modelId));
  return [
    monarch.length ? `<optgroup label="Monarch profiles">${renderModelOptionList(monarch)}</optgroup>` : '',
    superFast.length ? `<optgroup label="Super Fast — Qwen">${renderModelOptionList(superFast)}</optgroup>` : '',
  ].join('');
}

function renderModelOptionList(models) {
  return models.map((modelId) => `<option value="${escapeHtml(modelId)}" ${modelId === ui.model ? 'selected' : ''}>${escapeHtml(modelId)}</option>`).join('');
}

function renderModels(models, connected) {
  if (!connected) {
    return '<div class="sharing-empty-models">Запусти API — Monarch проверит runtime и покажет доступные model IDs.</div>';
  }
  if (!models.length) {
    return '<div class="sharing-empty-models">API отвечает, но локальные текстовые модели не найдены.</div>';
  }
  const superFast = models.filter((modelId) => SUPER_FAST_MODEL_IDS.has(modelId));
  const monarch = models.filter((modelId) => !SUPER_FAST_MODEL_IDS.has(modelId));
  return [
    superFast.length ? renderModelGroup('Super Fast', 'Qwen — быстрые локальные chat-модели.', superFast) : '',
    monarch.length ? renderModelGroup('Monarch Profiles', 'Основные профили общего Oscar runtime.', monarch) : '',
  ].join('');
}

function renderModelGroup(title, detail, models) {
  return `
    <section class="sharing-model-group" aria-label="${escapeHtml(title)}">
      <header><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></header>
      <div class="sharing-model-rail">
        ${models.map((modelId) => {
          const [label, description] = KNOWN_MODELS[modelId] || [modelId, 'Локальный OpenAI-compatible профиль.'];
          return `
            <button type="button" data-sharing-model="${escapeHtml(modelId)}" class="${modelId === ui.model ? 'is-selected' : ''}" aria-pressed="${modelId === ui.model}">
              <span><strong>${escapeHtml(label)}</strong><code>${escapeHtml(modelId)}</code></span>
              <small>${escapeHtml(description)}</small>
            </button>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderTtsModels(models, connected, ttsError) {
  if (!connected) {
    return '<div class="sharing-empty-models">Запусти API — Monarch проверит установленные Qwen3-TTS checkpoints.</div>';
  }
  if (!models.length) {
    return `<div class="sharing-empty-models">${escapeHtml(ttsError || 'Qwen3-TTS models пока недоступны в локальном runtime.')}</div>`;
  }
  return `
    <div class="sharing-tts-rail">
      ${models.map((modelId) => {
        const [label, description] = KNOWN_TTS_MODELS[modelId] || [modelId, 'Локальная Qwen TTS модель.'];
        return `
          <button type="button" data-sharing-tts-model="${escapeHtml(modelId)}" class="${modelId === ui.ttsModel ? 'is-selected' : ''}" aria-pressed="${modelId === ui.ttsModel}">
            <span><strong>${escapeHtml(label)}</strong><code>${escapeHtml(modelId)}</code></span>
            <small>${escapeHtml(description)}</small>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function buildSnippet(preset, connection, model) {
  const baseUrl = connection.baseUrl || DEFAULT_CONNECTION.baseUrl;
  const tokenPath = connection.authentication?.tokenPath || DEFAULT_CONNECTION.authentication.tokenPath;
  if (preset === 'python') {
    return `from pathlib import Path\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="${baseUrl}",\n    api_key=Path(r"${tokenPath}").read_text(encoding="utf-8").strip(),\n)\n\nresponse = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "Привет из моего приложения"}],\n)\nprint(response.choices[0].message.content)`;
  }
  if (preset === 'node') {
    return `import OpenAI from "openai";\nimport { readFileSync } from "node:fs";\n\nconst client = new OpenAI({\n  baseURL: "${baseUrl}",\n  apiKey: readFileSync("${escapeJavaScriptString(tokenPath)}", "utf8").trim(),\n});\n\nconst response = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "Привет из моего приложения" }],\n});\nconsole.log(response.choices[0].message.content);`;
  }
  if (preset === 'powershell') {
    return `$token = (Get-Content -Raw '${escapePowerShellString(tokenPath)}').Trim()\n$body = @{\n  model = '${escapePowerShellString(model)}'\n  messages = @(@{ role = 'user'; content = 'Привет из моего приложения' })\n} | ConvertTo-Json -Depth 5\n\nInvoke-RestMethod -Method Post \`\n  -Uri '${escapePowerShellString(connection.endpoints?.chatCompletions || `${baseUrl}/chat/completions`)}' \`\n  -Headers @{ Authorization = "Bearer $token" } \`\n  -ContentType 'application/json' \`\n  -Body $body`;
  }
  return `Base URL   ${baseUrl}\nAPI key    кнопка «Скопировать ключ»\nModel      ${model}\nEndpoint   ${connection.endpoints?.chatCompletions || `${baseUrl}/chat/completions`}`;
}

function buildTtsSnippet(connection, model) {
  const baseUrl = connection.baseUrl || DEFAULT_CONNECTION.baseUrl;
  const tokenPath = connection.authentication?.tokenPath || DEFAULT_CONNECTION.authentication.tokenPath;
  const endpoint = connection.endpoints?.audioSpeech || `${baseUrl}/audio/speech`;
  const voice = model === 'qwen3-tts-0.6b-custom' ? 'Ryan' : 'oscar';
  const extra = model === 'qwen3-tts-1.7b-voice-design'
    ? '{"language": "ru-RU", "instructions": "Тёплый, естественный русский голос"}'
    : '{"language": "ru-RU"}';
  return `from pathlib import Path\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="${baseUrl}",\n    api_key=Path(r"${tokenPath}").read_text(encoding="utf-8").strip(),\n)\n\nresponse = client.audio.speech.create(\n    model="${model}",\n    voice="${voice}",\n    input="Привет! Это локальный голос Monarch.",\n    response_format="wav",\n    extra_body=${extra},\n)\nresponse.write_to_file("monarch-speech.wav")\n# POST ${endpoint}`;
}

function buildEnvironmentSetup(connection) {
  const tokenPath = connection.authentication?.tokenPath || DEFAULT_CONNECTION.authentication.tokenPath;
  return `$env:OPENAI_BASE_URL='${escapePowerShellString(connection.baseUrl || DEFAULT_CONNECTION.baseUrl)}'\n$env:OPENAI_API_KEY=(Get-Content -Raw '${escapePowerShellString(tokenPath)}').Trim()`;
}

function uniqueModels(models) {
  const values = ['monarch-auto', ...models.filter((value) => typeof value === 'string' && value.trim())];
  return [...new Set(values)];
}

function friendlyOfflineMessage(error) {
  if (!error) return 'Локальный endpoint пока недоступен.';
  if (/fetch failed|refused|abort|timed? ?out|unavailable/i.test(error)) {
    return 'Локальный endpoint пока недоступен. Запусти API — облако для этого не требуется.';
  }
  return error;
}

function pluralizeModels(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'модель';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'модели';
  return 'моделей';
}

function setFeedback(message, kind = 'success') {
  ui.feedback = message;
  ui.feedbackKind = kind;
  renderSharingPane();
}

async function copyText(value) {
  if (window.monarchDesktop?.copyText) {
    const copied = await window.monarchDesktop.copyText(value);
    if (copied) return;
  }
  if (navigator.clipboard?.writeText) {
    let timeoutId = 0;
    try {
      await Promise.race([
        navigator.clipboard.writeText(value),
        new Promise((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error('Clipboard API timeout')), 900);
        }),
      ]);
      return;
    } catch {
      // The browser preview can block Clipboard API. Use the local synchronous fallback below.
    } finally {
      window.clearTimeout(timeoutId);
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Не удалось скопировать текст.');
}

function readStoredValue(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value && (!allowed || allowed.includes(value)) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storeValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Local preferences are optional.
  }
}

function escapeJavaScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
