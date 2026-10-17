// Coder screen skeleton. The controller fills it; nothing here decides anything.
const ICON = {
  plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>',
  folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>',
  search: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="4.8"/><path d="m12.6 12.6 3.4 3.4"/></svg>',
  changes: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4v8M6 15.5v.5M14 4.5V5M14 8v8"/><circle cx="6" cy="13.8" r="1.6"/><circle cx="14" cy="6.6" r="1.6"/></svg>',
  files: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5h5.2L15 7.3v9.2H6z"/><path d="M11 3.5v4h4"/></svg>',
  memory: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="3" width="10" height="14" rx="2.2"/><path d="M8 3v6l2-1.4L12 9V3M8 13h4"/></svg>',
  more: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="1.2"/><circle cx="10" cy="10" r="1.2"/><circle cx="15" cy="10" r="1.2"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"/></svg>',
  send: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9"/></svg>',
  stop: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5"/></svg>',
  rail: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="13" height="12" rx="2"/><path d="M8 4v12"/></svg>',
};

export function mountCoderView(root) {
  root.classList.add('cdr');
  root.dataset.state = 'loading';
  root.innerHTML = `
    <aside class="cdr-rail" data-cdr="rail" aria-label="Проект и разговоры">
      <div class="cdr-project">
        <button class="cdr-project-button" type="button" data-cdr="project-button" aria-haspopup="menu" aria-expanded="false">
          <span class="cdr-project-glyph" aria-hidden="true">${ICON.folder}</span>
          <span class="cdr-project-text"><strong data-cdr="project-name">Проект</strong><small data-cdr="project-path"></small></span>
          <span class="cdr-chevron" aria-hidden="true">${ICON.chevron}</span>
        </button>
        <div class="cdr-menu cdr-project-menu" data-cdr="project-menu" role="menu" hidden>
          <span class="cdr-menu-label">Проекты</span>
          <div data-cdr="project-list" class="cdr-menu-list"></div>
          <hr>
          <button type="button" role="menuitem" data-cdr="project-import">${ICON.folder}<span>Открыть папку…</span></button>
          <button type="button" role="menuitem" data-cdr="project-create">${ICON.plus}<span>Новый проект…</span></button>
        </div>
      </div>
      <button class="cdr-new" type="button" data-cdr="new-session">${ICON.plus}<span>Новый разговор</span><kbd>Ctrl N</kbd></button>
      <label class="cdr-search">${ICON.search}<span class="cdr-sr">Найти разговор</span>
        <input type="search" data-cdr="session-search" placeholder="Найти разговор" autocomplete="off"></label>
      <nav class="cdr-sessions" data-cdr="sessions" aria-label="Разговоры в проекте"></nav>
      <footer class="cdr-rail-foot" data-cdr="rail-foot"></footer>
    </aside>

    <main class="cdr-main" data-cdr="main">
      <header class="cdr-head">
        <button class="cdr-icon-button cdr-rail-toggle" type="button" data-cdr="rail-toggle" aria-label="Показать разговоры" aria-expanded="true">${ICON.rail}</button>
        <div class="cdr-head-title"><strong data-cdr="session-title">Новый разговор</strong><span class="cdr-state" data-cdr="state" role="status"></span></div>
        <div class="cdr-head-actions">
          <button class="cdr-chip-button" type="button" data-cdr="open-changes" aria-expanded="false">${ICON.changes}<span>Изменения</span><b data-cdr="changes-count" hidden></b></button>
          <button class="cdr-chip-button" type="button" data-cdr="open-files" aria-expanded="false">${ICON.files}<span>Файлы</span></button>
          <button class="cdr-chip-button" type="button" data-cdr="open-memory" aria-expanded="false" title="Что Coder знает о проекте">${ICON.memory}<span>Память</span></button>
          <div class="cdr-more">
            <button class="cdr-icon-button" type="button" data-cdr="more" aria-label="Ещё" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
            <div class="cdr-menu cdr-more-menu" data-cdr="more-menu" role="menu" hidden>
              <button type="button" role="menuitem" data-cdr="safe-move">Перенести разговор в Safe</button>
              <button type="button" role="menuitem" data-cdr="session-delete">Удалить разговор</button>
            </div>
          </div>
        </div>
      </header>
      <p class="cdr-banner" data-cdr="banner" role="alert" hidden></p>
      <div class="cdr-scroll" data-cdr="scroll">
        <div class="cdr-thread" data-cdr="thread" role="log" aria-live="polite" aria-relevant="additions text"></div>
      </div>
      <form class="cdr-composer" data-cdr="composer" autocomplete="off">
        <div class="cdr-composer-box">
          <textarea data-cdr="input" rows="1" data-composer-type-to-focus placeholder="Опиши задачу для проекта" aria-label="Задача для Coder"></textarea>
          <div class="cdr-composer-bar">
            <div class="cdr-model">
              <button class="cdr-model-button" type="button" data-cdr="model-button" aria-haspopup="listbox" aria-expanded="false">
                <span class="cdr-model-kind" data-cdr="model-kind"></span><span data-cdr="model-label">Модель</span>${ICON.chevron}
              </button>
              <div class="cdr-menu cdr-model-menu" data-cdr="model-menu" role="listbox" aria-label="Модель для задачи" hidden></div>
            </div>
            <span class="cdr-composer-hint" data-cdr="hint">Enter — отправить · Shift Enter — новая строка</span>
            <button class="cdr-send" type="submit" data-cdr="send" aria-label="Отправить">${ICON.send}</button>
            <button class="cdr-stop" type="button" data-cdr="stop" aria-label="Остановить" hidden>${ICON.stop}</button>
          </div>
        </div>
      </form>
    </main>

    <aside class="cdr-review" data-cdr="review" aria-label="Изменения и файлы" hidden>
      <header class="cdr-review-head">
        <div class="cdr-tabs" role="tablist" aria-label="Панель проекта">
          <button type="button" role="tab" data-cdr-tab="changes" aria-selected="true">Изменения</button>
          <button type="button" role="tab" data-cdr-tab="files" aria-selected="false">Файлы</button>
          <button type="button" role="tab" data-cdr-tab="memory" aria-selected="false">Память проекта</button>
        </div>
        <button class="cdr-icon-button" type="button" data-cdr="review-close" aria-label="Закрыть панель">${ICON.close}</button>
      </header>
      <div class="cdr-review-body" data-cdr="review-body"></div>
    </aside>
    <button class="cdr-scrim" type="button" data-cdr="scrim" aria-label="Закрыть панель" hidden></button>

    <section class="cdr-welcome" data-cdr="welcome" hidden>
      <div class="cdr-welcome-inner">
        <span class="cdr-kicker">Coder</span>
        <h1>Где будем работать?</h1>
        <p>Coder читает, пишет и запускает код только внутри выбранной папки. Каждое действие видно в разговоре.</p>
        <div class="cdr-welcome-choices">
          <button type="button" data-cdr="welcome-import"><span class="cdr-choice-icon">${ICON.folder}</span><strong>Открыть папку</strong><small>Продолжить существующий проект</small></button>
          <button type="button" data-cdr="welcome-create"><span class="cdr-choice-icon">${ICON.plus}</span><strong>Новый проект</strong><small>Чистая папка в рабочей области Coder</small></button>
        </div>
        <p class="cdr-inline-error" data-cdr="welcome-error" role="alert" hidden></p>
      </div>
    </section>

    <dialog class="cdr-dialog" data-cdr="create-dialog" aria-labelledby="cdr-create-title">
      <form method="dialog" data-cdr="create-form">
        <span class="cdr-kicker">Новый проект</span>
        <h2 id="cdr-create-title">Как назовём?</h2>
        <label><span>Название</span><input data-cdr="create-name" maxlength="80" placeholder="my-project" required></label>
        <p class="cdr-dialog-note">Папка появится в рабочей области Coder.</p>
        <p class="cdr-inline-error" data-cdr="create-error" role="alert" hidden></p>
        <footer><button type="button" data-cdr="create-cancel">Отмена</button><button type="submit" class="cdr-primary">Создать</button></footer>
      </form>
    </dialog>`;
  const nodes = {};
  for (const node of root.querySelectorAll('[data-cdr]')) nodes[node.dataset.cdr] = node;
  nodes.tabs = [...root.querySelectorAll('[data-cdr-tab]')];
  return nodes;
}

export const CODER_ICONS = ICON;
