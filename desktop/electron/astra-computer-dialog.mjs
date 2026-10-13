/** Native host-owned window chooser. No HTML, renderer-supplied titles/handles,
 * foreground fallback or automatic selection. Cancel is always the default. */
export function createAstraComputerDialog({ deployment, dialog, window, assertWindow }) {
  if (deployment !== 'isolated-validation' || typeof dialog?.showMessageBox !== 'function' || !window || typeof assertWindow !== 'function')
    throw Error('astra-window-dialog:isolated-host-required');
  const label = text => String(text).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 512);
  return async (candidates, signal) => {
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 32) throw Error('astra-window-dialog:candidates');
    let index = 0;
    for (let interactions = 0; interactions < 64; interactions++) {
      assertWindow(); if (signal.aborted) return null;
      const item = candidates[index];
      const buttons = ['Наблюдать это окно', 'Отмена', ...(index > 0 ? ['Предыдущее'] : []), ...(index + 1 < candidates.length ? ['Следующее'] : [])];
      const response = await dialog.showMessageBox(window, { type: 'question', title: 'Astra V3 — выбор окна',
        message: `Окно ${index + 1} из ${candidates.length}: только наблюдение`,
        detail: `Приложение: ${label(item.processName)}\nPID: ${item.processId}\nОкно: ${item.windowRef}\nЗаголовок: ${label(item.title)}${item.title.length > 512 ? '…' : ''}\n\nЭто не разрешение на клики или ввод. Список ограничен 32 окнами.`,
        buttons, defaultId: 1, cancelId: 1, noLink: true, signal });
      assertWindow(); if (signal.aborted || response.response === 1) return null;
      if (!Number.isInteger(response.response) || response.response < 0 || response.response >= buttons.length) throw Error('astra-window-dialog:response');
      if (response.response === 0) return index;
      index += buttons[response.response] === 'Предыдущее' ? -1 : 1;
    }
    throw Error('astra-window-dialog:interaction-budget');
  };
}
