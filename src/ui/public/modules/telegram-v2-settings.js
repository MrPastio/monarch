import { reducedUiMotion } from './ui-motion.js';
import { controlTelegramV2, controlTelegram } from './api.js';
import { confirmAction } from './ui-dialogs.js';

export function initTelegramV2Settings() {
  const host = document.querySelector('#telegram-v2-settings');
  if (!host || host.dataset.initialized) return;
  host.dataset.initialized = 'true';
  let snapshot = null;
  let personalCloud = null;
  let view = 'home', busy = false, visibleNow = false, pairDeadline = 0, pairTimer = null;
  let refreshVersion = 0, animation = null;
  const reducedMotion = reducedUiMotion;
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) animation?.cancel(); });
  const $ = selector => host.querySelector(selector);
  const parents = { models: 'chats', 'cloud-connect': 'cloud', 'secretary-connect': 'secretary', rules: 'secretary' };
  const backLabels = { home: 'Все настройки Telegram', chats: 'Диалоги и ответы', cloud: 'Работа без ПК', secretary: 'Личный секретарь' };
  function clearSecrets() { host.querySelectorAll('input[type=password]').forEach(field => { field.value = ''; }); }
  function schedulePair() {
    clearTimeout(pairTimer);
    if (view !== 'pair' || !visibleNow || document.hidden) return;
    if (Date.now() >= pairDeadline) {
      $('[data-pair-link]').hidden = true; $('[data-pair-confirm]').hidden = true;
      $('[data-pair-command]').value = ''; $('[data-action="copy-pair-command"]').disabled = true;
      $('[data-candidate]').textContent = 'Время подключения истекло. Создай новую ссылку.'; return;
    }
    pairTimer = setTimeout(async () => {
      try { if (!busy) await refresh(); } catch { text('Не удалось проверить аккаунт. Повторим, пока действует ссылка.'); }
      schedulePair();
    }, 2500);
  }
  function show(next) {
    if (next === 'connect' && pairDeadline > Date.now() && $('[data-pair-link]').hasAttribute('href')) next = 'pair';
    const pane = $(`[data-v2-view="${next}"]`); if (!pane) return;
    const backwards = next === (parents[view] || 'home');
    clearSecrets(); animation?.cancel();
    host.querySelectorAll('[data-v2-view]').forEach(p => { p.hidden = p !== pane; });
    view = next; feedback.hidden = true;
    if (next === 'secretary-connect') $('[data-secretary-chats]').value = (snapshot?.secretary?.chats ?? []).join(', ');
    const back = $('.tg-toolbar .tg-back'); back.hidden = next === 'home'; back.dataset.view = parents[next] || 'home';
    back.textContent = `← ${backLabels[back.dataset.view]}`;
    $('.tg-brand').hidden = next !== 'home';
    if (!reducedMotion.matches) {
      animation = pane.animate([{ opacity: 0, transform: `translateX(${backwards ? -12 : 12}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    pane.querySelector('h2')?.focus({ preventScroll: true });
    schedulePair();
  }
  async function loadModels() {
    const value = await window.monarchDesktop?.astraMax?.providers();
    if (!Array.isArray(value?.providers)) throw Error('Открой Настройки → MAX и подключи сервис.');
    const selected = value.providers.find(p => p.id === value.selectedProviderId);
    $('[data-global-model]').textContent = selected?.state === 'ready' ? `${selected.name} · ${selected.model}` : 'Подключи провайдера в Настройки → MAX';
  }
  async function loadPersonalCloud() {
    personalCloud = null;
    $('[data-personal-cloud]').textContent = 'Ищем твоё облако Cloudflare…';
    const bridge = window.monarchDesktop?.telegram;
    if (!bridge?.inspectPersonalCloud) throw Error('Перезапусти Monarch, чтобы загрузить новое подключение облака.');
    const result = await bridge.inspectPersonalCloud();
    personalCloud = result;
    $('[data-personal-max]').textContent = result.max?.available ? (result.max.providerId === 'groq' ? 'Groq · GPT OSS 120B' : `${result.max.providerId} · ${result.max.modelId}`) : 'Сначала подключи сервис в Настройки → MAX';
    $('[data-personal-cloud]').textContent = result.choices?.length === 1 ? `Твоё облако: ${new URL(result.choices[0].endpoint).hostname}` : result.choices?.length ? 'Выбери своё облако ниже.' : 'Компонент Oscar не найден. Сначала разверни cloud/oscar-bot в своём Cloudflare.';
    const select = $('[data-cloud-choice]'); select.replaceChildren();
    for (const choice of result.choices ?? []) { const option = document.createElement('option'); option.value = choice.accountId; option.textContent = choice.endpoint; select.append(option); }
    $('[data-cloud-choice-field]').hidden = result.choices?.length <= 1;
  }
  async function createPair() {
    const result = await controlTelegramV2({ action: 'pair' });
    const url = new URL(result.url);
    if (url.origin !== 'https://t.me') throw Error('Не удалось получить ссылку Telegram.');
    const payload = url.searchParams.get('start');
    if (!/^v2_[A-Za-z0-9_-]{32}$/.test(payload ?? '')) throw Error('Не удалось получить команду привязки. Создай новую ссылку.');
    const link = $('[data-pair-link]'); link.href = url.href; link.hidden = false;
    $('[data-pair-command]').value = `/start ${payload}`; $('[data-action="copy-pair-command"]').disabled = false;
    pairDeadline = Math.min(result.expiresAt || Date.now() + 300000, Date.now() + 300000);
    show('pair'); await refresh(); schedulePair();
  }
  const feedback = host.querySelector('[data-feedback]');
  const text = value => { feedback.textContent = value; feedback.hidden = !value; };
  async function refresh() {
    const version = ++refreshVersion;
    const latest = await controlTelegramV2({ action: 'status' });
    if (version !== refreshVersion) return;
    snapshot = latest;
    const s = snapshot.settings;
    $('[data-telegram-max]').checked = snapshot.maxEnabled ?? Boolean(snapshot.modelRole);
    host.querySelector('[data-queue-mode]').value = s.queueMode;
    host.querySelector('[data-cloud-binding]').textContent = s.pairingEpoch ? `PAIRING_EPOCH для личного Worker: ${s.pairingEpoch}; OWNER_ID: ${s.ownerUserId}; BOT_ID: ${s.botId}` : 'Сначала привяжи основной бот.';
    const tasksHost = $('[data-pc-tasks]'); tasksHost.replaceChildren();
    const statuses = { 'waiting-pc': 'Ждёт компьютер', accepted: 'Проверка условий', running: 'Выполняется', succeeded: 'Готово', failed: 'Ошибка', cancelled: 'Отменено', expired: 'Истекло', partial: 'Выполнено частично' };
    const tasks = snapshot.cloud?.tasks ?? [];
    for (const task of tasks) {
      const row = document.createElement('p'); row.className = 'tg-task';
      row.textContent = `${statuses[task.status] || task.status} · ${task.deviceId}\n${task.text}\nДо ${new Date(task.expiresAt).toLocaleString('ru')}${task.error ? ` · ${task.error}` : ''}`; tasksHost.append(row);
    }
    if (!tasks.length) { const empty = document.createElement('p'); empty.className = 'tg-empty'; empty.textContent = 'Пока поручений нет. Оставь задачу в боте — она появится здесь.'; tasksHost.append(empty); }
    $('[data-action="queue-approve"]').disabled = !tasks.some(t => ['waiting-pc', 'accepted'].includes(t.status) && !t.turnId && !t.cancelRequested && t.expiresAt > Date.now());
    $('[data-task-count]').textContent = String(tasks.length);
    $('[data-state]').textContent = !s.enabled ? 'Не подключён' : s.paused ? 'На паузе' : 'Аккаунт привязан';
    $('[data-setup-callout]').hidden = s.enabled; $('[data-connected]').hidden = !s.enabled;
    $('[data-action="pause-toggle"]').textContent = s.paused ? 'Возобновить' : 'Приостановить';
    const bot = $('[data-open-bot]');
    bot.hidden = !/^[a-zA-Z0-9_]{5,32}$/.test(snapshot.bot?.username ?? '');
    if (!bot.hidden) bot.href = `https://t.me/${snapshot.bot.username}`;
    const candidate = snapshot.candidate && snapshot.candidate.expiresAt > Date.now() ? snapshot.candidate : null;
    $('[data-candidate]').textContent = candidate ? `Telegram ID: ${candidate.userId}. Подтверди, что это твой аккаунт.` : 'Ждём сообщения из Telegram…';
    $('[data-pair-confirm]').hidden = !candidate;
    $('[data-action="confirm-pair"]').disabled = !candidate;
    $('[data-grant]').textContent = snapshot.grant ? `${snapshot.grant.root} · до ${new Date(snapshot.grant.expiresAt).toLocaleTimeString('ru')}` : 'Доступ к файлам закрыт';
    $('[data-action="revoke-grant"]').disabled = !snapshot.grant;
    $('[data-files-summary]').textContent = snapshot.grant ? `Открыт до ${new Date(snapshot.grant.expiresAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : 'Доступ закрыт';
    $('[data-secretary-summary]').textContent = snapshot.secretary?.connected ? 'Подключён · готовит черновики' : snapshot.secretary?.enabled ? 'Нет связи с ботом' : 'Не подключён';
    $('[data-cloud-summary]').textContent = snapshot.cloud?.connected ? 'Компьютер связан с облаком' : 'Не подключено';
    $('[data-chats-summary]').textContent = `Диалогов: ${snapshot.conversations.length} · история и модель`;
    $('[data-model-summary]').textContent = snapshot.modelRole ? 'MAX разрешён' : 'Локальная';
    const list = $('[data-conversations]'); list.replaceChildren();
    if (!snapshot.conversations.length) { const empty = document.createElement('p'); empty.className = 'tg-empty'; empty.textContent = 'Создай первый диалог кнопкой «Новый чат» в боте.'; list.append(empty); }
    for (const c of snapshot.conversations) {
      const card = document.createElement('article'); card.className = 'tg-conversation';
      const title = document.createElement('h3'); title.textContent = c.title; card.append(title);
      for (const kind of ['local', 'cloud']) {
        const label = document.createElement('label'); label.className = 'tg-check';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        checkbox.checked = kind === 'local' ? c.localOnly : c.cloudEnabled;
        checkbox.disabled = kind === 'cloud' && c.localOnly;
        label.append(checkbox, document.createTextNode(kind === 'local' ? 'Только на этом устройстве' : 'Доступен без ПК'));
        checkbox.addEventListener('change', async () => {
          checkbox.disabled = true;
          try {
            if (kind === 'cloud' && checkbox.checked && !await confirmAction(`Разрешить копирование диалога «${c.title}» в твой Cloudflare? Облачная модель получит его содержимое для ответа.`)) { checkbox.checked = false; return; }
            const result = await controlTelegramV2(kind === 'local' ? { action: 'conversation', id: c.id, localOnly: checkbox.checked } : { action: 'cloud-dialog', id: c.id, enabled: checkbox.checked });
            await refresh();
            if (result.cloudConfirmed === false) text('На ПК доступ закрыт. Облако пока не подтвердило отзыв; запрос повторится после восстановления связи.');
          } catch (error) { checkbox.checked = !checkbox.checked; text(error.message); }
          finally { checkbox.disabled = kind === 'cloud' && c.localOnly; }
        }); card.append(label);
      } list.append(card);
    }
  }
  host.addEventListener('click', async event => {
    const navigation = event.target.closest('[data-view]');
    if (navigation && !busy) { show(navigation.dataset.view); if (view === 'models') loadModels().catch(error => text(error.message)); else if (view === 'cloud-connect') loadPersonalCloud().catch(error => { $('[data-personal-cloud]').textContent = error.message; }); else refresh().catch(error => text(error.message)); return; }
    const button = event.target.closest('[data-action]'); if (!button || button.disabled || busy) return;
    busy = true; button.disabled = true; host.setAttribute('aria-busy', 'true');
    host.querySelectorAll('[data-view]').forEach(b => { b.disabled = true; });
    try {
      const action = button.dataset.action;
      if (action === 'personal-cloud-refresh') { await loadPersonalCloud(); return; }
      if (action === 'personal-cloud-connect') {
        if (!snapshot?.settings.enabled || !$('[data-personal-cloud-consent]').checked) throw Error('Подтверди использование выбранного MAX и бота в твоём облаке.');
        const choice = personalCloud?.choices?.find(c => c.accountId === $('[data-cloud-choice]').value);
        if (!choice || !personalCloud?.max?.available) throw Error('Проверь Cloudflare и подключение в Настройки → MAX.');
        text('Подключаем облако и проверяем сохранённые настройки…');
        const cloudKeyField = $('[data-cloud-api-key]');
        const cloudApiKey = cloudKeyField?.value.trim() || '';
        try {
          await window.monarchDesktop.telegram.provisionPersonalCloud({ ...choice, expectedRole: personalCloud.max.role,
            ownerId: snapshot.settings.ownerUserId, pairingEpoch: snapshot.settings.pairingEpoch,
            consent: 'monarch.telegram.personal-cloud.2026-09-08.v1', ...(cloudApiKey ? { cloudApiKey } : {}) });
        } finally {
          if (cloudKeyField) cloudKeyField.value = '';
        }
        const switched = await controlTelegramV2({ action: 'transport-switch', mode: 'cloud' });
        if (switched?.verified !== true) throw Error('Настройки сохранены, но переключение бота пока не подтверждено. Повтори подключение.');
        await refresh(); show('cloud'); text('Облако подключено. Для нужных диалогов включи «Доступен без ПК». В облаке работает отдельный ключ MAX.'); return;
      }
      if (action === 'copy-pair-command') {
        if (Date.now() >= pairDeadline || !$('[data-pair-command]').value) throw Error('Ссылка истекла. Создай новую.');
        try { await navigator.clipboard.writeText($('[data-pair-command]').value); text('Команда скопирована. Отправь её целиком своему боту, затем вернись сюда.'); }
        catch { $('[data-pair-fallback]').open = true; $('[data-pair-command]').focus(); $('[data-pair-command]').select(); text('Не удалось скопировать автоматически. Нажми Ctrl+C и отправь выделенную команду боту.'); }
        return;
      }
      if (action === 'pick-folder') {
        if (!window.monarchDesktop?.pickCoderFolder) throw Error('Выбор папки доступен в приложении. Можно вставить путь вручную.');
        const folder = await window.monarchDesktop.pickCoderFolder('telegram'); if (folder) $('[data-root]').value = folder; return;
      }
      if (action === 'pair') { await createPair(); return; }
      if (action === 'pause-toggle') { await controlTelegramV2({ action: snapshot?.settings.paused ? 'resume' : 'pause' }); await refresh(); text(snapshot.settings.paused ? 'Работа приостановлена.' : 'Работа возобновлена.'); return; }
      if (action === 'load-models') { await loadModels(); text('Подключения обновлены.'); return; }
      if (action === 'model') {
        const enabled = $('[data-telegram-max]').checked;
        if (enabled && !await confirmAction('Разрешить единому подключению из настроек MAX обрабатывать сообщения и контекст тех тем Telegram, где ты его включишь? Запросы идут через сохранённое подключение на этом ПК и расходуют лимиты провайдера. Ключ не переносится в Cloudflare.', { title: 'MAX в Telegram' })) return;
        await controlTelegramV2({ action, consent: enabled }); await refresh(); text('Выбор сохранён. В боте открой Настройки этой темы.'); return;
      }
      if (action === 'stop-all') {
        const result = await controlTelegramV2({ action }); await refresh(); text(result.summary); return;
      }
      if (action.startsWith('transport-')) {
        await controlTelegramV2({ action: 'transport-switch', mode: action === 'transport-cloud' ? 'cloud' : 'polling' });
        await refresh(); text('Получатель обновлений проверен. Подключение запущено.'); return;
      }
      if (action === 'queue-mode') {
        const mode = host.querySelector('[data-queue-mode]').value;
        if (mode === 'scoped-auto' && !await confirmAction('Поручения смогут начинаться автоматически, пока действует выданный здесь доступ к рабочей папке. Разрешения Kernel сохраняются; расширение прав и внешняя отправка не разрешаются.', { title: 'Автозапуск очереди' })) return;
        await controlTelegramV2({ action, mode }); await refresh(); text('Режим очереди сохранён.'); return;
      }
      if (action === 'cloud-connect') {
        if (!window.monarchDesktop?.telegram || !snapshot?.settings.enabled || !host.querySelector('[data-cloud-consent]').checked) throw Error('Сначала привяжи бота и подтверди облачную обработку.');
        const tokenField = host.querySelector('[data-device-token]'); const deviceToken = tokenField.value.trim(); tokenField.value = '';
        const webhookField = host.querySelector('[data-webhook-secret]'); const webhookSecret = webhookField.value.trim(); webhookField.value = '';
        await window.monarchDesktop.telegram.configureCloud({ endpoint: host.querySelector('[data-cloud-url]').value.trim(), deviceToken,
          webhookSecret,
          ownerId: snapshot.settings.ownerUserId,
          deviceId: host.querySelector('[data-device-id]').value.trim(), pairingEpoch: snapshot.settings.pairingEpoch, enabled: true,
          consent: 'monarch.telegram.personal-cloud.2026-09-08.v1' });
        const switched = await controlTelegramV2({ action: 'transport-switch', mode: 'cloud' });
        if (switched?.verified !== true) throw Error('Облачный маршрут пока не подтверждён. Проверь подключение.');
        await refresh(); show('cloud'); text('Облачный маршрут включён. Доступность MAX зависит от его отдельной настройки в Cloudflare.'); return;
      }
      if (action === 'queue-approve') {
        const pending = (snapshot?.cloud?.tasks ?? []).filter(t => ['waiting-pc', 'accepted'].includes(t.status) && !t.turnId && !t.cancelRequested && t.expiresAt > Date.now());
        if (!pending.length) throw Error('Ожидающих поручений нет.');
        if (!await confirmAction(pending.map(t => `${t.deviceId} · тема ${t.threadId}, сообщение ${t.messageId}\n${t.text}\nДо ${new Date(t.expiresAt).toLocaleString('ru')}`).join('\n\n'), { title: 'Запустить эти поручения на ПК?' })) return;
        const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
        const items = await Promise.all(pending.map(async t => ({ id: t.id, revision: t.revision, digest: await digest(t.text),
          // Order matches the portable DeferredPcTask approval contract.
          proposalDigest: await digest(JSON.stringify([t.version, t.id, t.deviceId, t.pairingEpoch, t.revision, t.text,
            t.chatId, t.threadId, t.messageId, t.createdAt, t.expiresAt])) })));
        await controlTelegramV2({ action, items }); await refresh(); text('Этот список подтверждён. Запуск проверит актуальность задач и разрешений.'); return;
      }
      if (action === 'configure-token' || action === 'configure-secretary') {
        const bridge = window.monarchDesktop?.telegram;
        if (!bridge) throw Error('Защищённое подключение доступно в приложении Monarch.');
        if (action === 'configure-token' && snapshot?.settings.enabled) throw Error('Сначала отзови действующую привязку в разделе «Подключение».');
        const field = $(action === 'configure-token' ? '[data-bot-token]' : '[data-secretary-token]');
        const token = field.value.trim(); field.value = '';
        if (!token) throw Error('Вставь ключ бота из BotFather.');
        const result = await bridge.configure({ role: action === 'configure-token' ? 'main' : 'secretary', token });
        if (action === 'configure-secretary') { text(`Бот @${result.username} проверен. Теперь выбери переписки.`); return; }
        text('Ключ проверен. Подключаем бота…');
        await controlTelegram('stop');
        const started = await controlTelegram('start');
        if (started?.ok === false) throw Error(started.summary || 'Не удалось подключить бота.');
        await createPair(); return;
      }
      if (action === 'status') { await refresh(); text('Состояние обновлено.'); return; }
      if (action === 'secretary-rule' || action === 'secretary-rule-remove') {
        const chatId = Number(host.querySelector('[data-rule-chat]').value); const template = host.querySelector('[data-rule-text]').value;
        const ttlMs = Number(host.querySelector('[data-rule-hours]').value) * 3_600_000;
        if (action === 'secretary-rule' && !await confirmAction(`Получатель: ${chatId}\n\n${template}\n\nСрок: ${ttlMs / 3_600_000} ч. Не чаще раза в час, до 3 ответов в сутки.`, { title: 'Разрешить этот автоответ?' })) return;
        await controlTelegramV2({ action, chatId, template, ttlMs }); text(action === 'secretary-rule' ? 'Правило включено.' : 'Правило отозвано.'); return;
      }
      if (action === 'secretary-pause') { await controlTelegramV2({ action }); await refresh(); text('Секретарь приостановлен. Выбранные переписки сохранены.'); return; }
      if (action === 'secretary-enable') {
        const chats = host.querySelector('[data-secretary-chats]').value.split(',').map(x => x.trim()).filter(Boolean).map(Number);
        await controlTelegramV2({ action: 'secretary-configure', chats, enabled: action === 'secretary-enable' });
        await refresh(); show('secretary'); text('Секретарь включён. Ответы отправляются кнопкой в карточке. Отдельно разрешённые автоответы продолжат действовать.'); return;
      }
      if (action === 'revoke' && !await confirmAction('Отвязать Telegram? Старые кнопки и удалённый доступ перестанут работать. История сохранится.')) return;
      let input = { action };
      if (action === 'confirm-pair') {
        const candidate = snapshot?.candidate;
        if (!candidate) throw Error('Сначала открой ссылку своим Telegram-аккаунтом.');
        if (candidate.expiresAt <= Date.now()) throw Error('Запрос привязки истёк. Создай новую ссылку.');
        input = { ...input, userId: candidate.userId, chatId: candidate.chatId, historyEnabled: true };
      }
      if (action === 'grant') {
        const root = host.querySelector('[data-root]').value.trim();
        const capabilities = ['workspace.files.read', 'workspace.files.list', 'workspace.files.search'];
        if (host.querySelector('[data-create]').checked) capabilities.push('workspace.files.write', 'workspace.files.mkdir');
        if (!await confirmAction(`Открыть на 30 минут доступ к папке ${root}? Разрешены чтение${capabilities.length > 3 ? ' и создание новых файлов без перезаписи' : ''}.`, { title: 'Временный доступ с телефона' })) return;
        input = { ...input, root, capabilities, ttlMs: 30 * 60_000 };
      }
      await controlTelegramV2(input);
      await refresh();
      if (action === 'confirm-pair' || action === 'revoke') {
        pairDeadline = 0; $('[data-pair-command]').value = ''; $('[data-pair-link]').removeAttribute('href');
        show('home');
      }
      text(action === 'confirm-pair' ? 'Готово — Оскар подключён. Открой бота и начни диалог.' : action === 'revoke' ? 'Telegram отвязан. История сохранена.' : 'Готово.');
    } catch (error) { text(error.message || 'Не удалось выполнить действие.'); }
    finally {
      busy = false; button.disabled = false; host.removeAttribute('aria-busy');
      host.querySelectorAll('[data-view]').forEach(b => { b.disabled = false; });
      schedulePair();
    }
  });
  window.addEventListener('monarch:max-selection-changed', () => { if (visibleNow) { refresh().catch(error => text(error.message)); if (view === 'models') loadModels().catch(error => text(error.message)); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearSecrets(); schedulePair(); });
  const visible = new IntersectionObserver(entries => {
    visibleNow = entries.some(entry => entry.isIntersecting);
    if (!visibleNow) { clearSecrets(); schedulePair(); return; }
    refresh().catch(error => text(error.message || 'Не удалось проверить подключение.'));
    if (view === 'models') loadModels().catch(error => text(error.message));
    schedulePair();
  });
  visible.observe(host);
}
