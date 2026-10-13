let active = false;
function ask(message, initialValue, options = {}) {
  // A second action cannot silently queue a stale destructive confirmation.
  if (active) return Promise.resolve(initialValue === undefined ? false : null);
  active = true;
  return new Promise(resolve => {
    const previous = document.activeElement, dialog = document.createElement('dialog');
    dialog.className = 'monarch-question-dialog'; dialog.setAttribute('aria-labelledby', 'monarch-question-title'); dialog.setAttribute('aria-describedby', 'monarch-question-copy');
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h2'); title.id = 'monarch-question-title'; title.textContent = initialValue === undefined ? 'Подтверди действие' : 'Давай уточним';
    const copy = document.createElement('p'); copy.id = 'monarch-question-copy'; copy.textContent = String(message);
    const input = document.createElement('input'); input.type = 'text'; input.value = initialValue ?? ''; input.autocomplete = 'off'; input.maxLength = 4096; input.setAttribute('aria-label', String(message));
    if (options.secret) {
      input.type = 'password'; input.inputMode = 'numeric'; input.maxLength = 6; input.pattern = '[0-9]{6}'; input.required = true;
      title.textContent = 'Подтверди Security PIN';
    }
    const actions = document.createElement('div'); actions.className = 'monarch-question-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'claude-secondary-btn'; cancel.textContent = 'Отмена';
    const accept = document.createElement('button'); accept.type = 'submit'; accept.className = 'claude-primary-btn'; accept.textContent = initialValue === undefined ? 'Подтвердить' : 'Сохранить';
    actions.append(cancel, accept); form.append(title, copy); if (initialValue !== undefined) form.append(input); form.append(actions); dialog.append(form); document.body.append(dialog);
    let result = initialValue === undefined ? false : null;
    form.addEventListener('submit', event => { event.preventDefault(); result = initialValue === undefined ? true : input.value; dialog.close(); });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { input.value = ''; dialog.remove(); active = false; if (previous?.isConnected) previous.focus({ preventScroll: true }); resolve(result); }, { once: true });
    dialog.showModal(); (initialValue === undefined ? cancel : input).focus();
  });
}
export const confirmAction = message => ask(message);
export const promptValue = (message, initialValue = '') => ask(message, initialValue);
export const promptSecurityPin = message => ask(message, '', { secret: true });
