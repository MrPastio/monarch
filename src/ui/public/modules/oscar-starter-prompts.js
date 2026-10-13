// Starter requests under the empty Oscar chat. A tap only fills the composer;
// the person still decides whether to send. Internet examples appear only
// while the Internet switch is on, so a suggestion never promises something
// the current settings will refuse.
const CHAT_PROMPTS = Object.freeze([
  { id: 'explain', text: 'Объясни простыми словами, как работает шифрование' },
  { id: 'simplify', text: 'Сократи этот текст до главного, сохранив смысл' },
  { id: 'translate', text: 'Переведи этот текст на английский, сохранив тон' },
  { id: 'proofread', text: 'Проверь текст на ошибки и предложи аккуратную правку' },
  { id: 'summarize', text: 'Сделай краткий конспект этого текста в пяти пунктах' },
  { id: 'checklist', text: 'Преврати эти заметки в понятный список задач' },
  { id: 'compare', text: 'Сравни эти два варианта в таблице: плюсы, минусы и различия' },
  { id: 'study-plan', text: 'Составь пошаговый план подготовки к собеседованию на две недели' },
  { id: 'email', text: 'Помоги написать вежливое письмо с просьбой перенести встречу' },
  { id: 'brainstorm', text: 'Придумай десять названий для проекта про обучение' },
  { id: 'code', text: 'Объясни, что делает этот фрагмент кода, и отметь возможные ошибки' },
  { id: 'image', text: 'Разбери приложенный скриншот ошибки и подскажи первые шаги' },
  { id: 'clarity', text: 'Сделай этот абзац яснее и короче, не меняя стиль' },
  { id: 'quiz', text: 'Составь пять вопросов по этому тексту, чтобы проверить, что я понял' },
  { id: 'presentation', text: 'Составь структуру короткой презентации на тему «...»' },
  { id: 'examples', text: 'Объясни идею на трёх простых примерах' },
]);

const WORKSPACE_PROMPTS = Object.freeze([
  { id: 'file', text: 'Создай в рабочей папке файл «План.txt» с планом на завтра' },
  { id: 'find', text: 'Найди в рабочей папке файлы, изменённые за последнюю неделю' },
  { id: 'find-phrase', text: 'Найди в файлах рабочей папки точное упоминание «...»' },
  { id: 'list-folder', text: 'Покажи файлы и папки в каталоге «...» рабочего пространства' },
  { id: 'read-file', text: 'Прочитай файл «README.md» и коротко перескажи его содержимое' },
  { id: 'find-markdown', text: 'Найди в Markdown-файлах рабочего пространства фразу «...»' },
  { id: 'create-folder', text: 'Создай в рабочем пространстве папку «Черновики»' },
  { id: 'append-notes', text: 'Добавь в конец файла «Заметки.md» раздел «Идеи» с этим списком: ...' },
  { id: 'copy-file', text: 'Скопируй файл «...» в папку «...»' },
  { id: 'move-file', text: 'Перемести файл «...» в папку «...»' },
  { id: 'rename-file', text: 'Переименуй файл «черновик.txt» в «план.txt»' },
  { id: 'replace-text', text: 'Замени в файле «...» фразу «...» на «...»' },
]);

const WEB_PROMPTS = Object.freeze([
  { id: 'web', text: 'Что важного произошло сегодня в мире технологий?' },
  { id: 'web-docs', text: 'Найди официальную документацию по «...» и дай ссылки' },
  { id: 'web-releases', text: 'Какие последние версии вышли у «...»? Проверь источники' },
  { id: 'web-compare', text: 'Сравни актуальные варианты «...» по нескольким источникам' },
  { id: 'web-facts', text: 'Проверь утверждение «...» и покажи источники за и против' },
  { id: 'web-changes', text: 'Кратко собери, что изменилось в «...» за последний месяц' },
  { id: 'web-guides', text: 'Найди несколько свежих инструкций по «...» и сравни их' },
  { id: 'web-news', text: 'Собери главные новости по теме «...» со ссылками на источники' },
]);

const BASE_PROMPTS = Object.freeze([...CHAT_PROMPTS, ...WORKSPACE_PROMPTS]);

export function oscarStarterPrompts({ webEnabled = false } = {}) {
  return webEnabled ? [...BASE_PROMPTS, ...WEB_PROMPTS] : [...BASE_PROMPTS];
}

export function selectOscarStarterPrompts({ webEnabled = false, previousIds = [], random = Math.random } = {}) {
  const excluded = new Set(previousIds);
  const selectedIds = new Set();
  const selected = [];
  const take = (group) => {
    let candidates = group.filter(prompt => !excluded.has(prompt.id) && !selectedIds.has(prompt.id));
    if (!candidates.length) candidates = group.filter(prompt => !selectedIds.has(prompt.id));
    if (!candidates.length) return;
    const prompt = candidates[randomIndex(candidates.length, random)];
    selectedIds.add(prompt.id);
    selected.push(prompt);
  };

  take(CHAT_PROMPTS);
  take(WORKSPACE_PROMPTS);
  if (webEnabled) {
    take(WEB_PROMPTS);
  } else {
    take(BASE_PROMPTS);
  }

  for (let index = selected.length - 1; index > 0; index -= 1) {
    const otherIndex = randomIndex(index + 1, random);
    [selected[index], selected[otherIndex]] = [selected[otherIndex], selected[index]];
  }
  return selected;
}

export function renderOscarStarterPrompts(prompts, escapeHtml) {
  if (!prompts.length) return '';
  return `<div class="oscar-starters" role="group" aria-label="Примеры запросов">${prompts.map(prompt => (
    `<button type="button" class="oscar-starter" data-oscar-starter="${escapeHtml(prompt.id)}">${escapeHtml(prompt.text)}</button>`
  )).join('')}</div>`;
}

export function findOscarStarterPrompt(id, prompts) {
  return prompts.find(prompt => prompt.id === id) || null;
}

function randomIndex(length, random) {
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(value, 0.999999999999)) : 0;
  return Math.floor(normalized * length);
}
