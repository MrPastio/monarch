import { mountAstraDesktopPane } from './astra-desktop-pane.js';

/** Existing Oscar DOM, SAME Astra source/card controller. No conversation/history,
 * Safe/model/voice/web service is discovered here. The explicit native host owns
 * the current conversation and opaque pending/Turn pointer. Not default activation. */
export async function mountOscarAstraComposer(elements, bridge, maxMode = null) {
  const { oscarSection: section, oscarThread: thread, oscarComposer: form,
    oscarInput: input, oscarSend: submit, oscarStop: stop } = elements;
  if (!section || !thread || !form || !input || !submit || !stop || !section.contains(thread) || !section.contains(form))
    throw Error('Не найдена поверхность Oscar для Astra.');
  const controls = [...section.querySelectorAll('button, input, select, textarea, details')];
  const saved = controls.map(element => ({ element, hidden: element.hidden, disabled: element.disabled }));
  const maxEntry = bridge.maxPreview === true ? section.querySelector('[data-astra-max-open]') : null;
  const maxEntryHome = maxEntry ? { parent: maxEntry.parentNode, next: maxEntry.nextSibling } : null;
  const sourceText = input.value;
  const stopLabel = stop.getAttribute('aria-label'), stopTitle = stop.getAttribute('title');
  // Legacy actions are not wired in this cohort; do not present inert Safe,
  // model, history or voice controls as usable features.
  for (const element of controls) { if (element !== input) element.hidden = true; if ('disabled' in element) element.disabled = true; }
  section.classList.add('astra-oscar-host'); thread.classList.remove('is-empty'); thread.replaceChildren();
  input.value = sourceText; input.hidden = false; submit.hidden = false;
  stop.setAttribute('aria-label', 'Остановить задачу Astra'); stop.title = 'Остановить задачу Astra';
  let pane;
  try {
    pane = await mountAstraDesktopPane(thread, bridge, { composer: { form, input, submit, stop }, maxMode });
  } catch (error) {
    const failure = document.createElement('p'); failure.className = 'astra-error'; failure.setAttribute('role', 'alert');
    failure.textContent = 'Astra не подключена: ' + (error.message || String(error)); thread.append(failure);
    // No fallback or implicit restoration of legacy submit after failed bootstrap.
    throw error;
  }
  let maxDock = null;
  if (maxEntry && maxEntryHome?.parent) {
    maxDock = document.createElement('div'); maxDock.className = 'astra-max-pilot-dock';
    maxEntry.classList.add('astra-max-pilot-entry'); maxEntry.hidden = false; maxEntry.disabled = false;
    maxDock.append(maxEntry); form.prepend(maxDock);
  }
  return { dispose() {
    if (maxEntry && maxEntryHome?.parent) {
      maxEntry.classList.remove('astra-max-pilot-entry');
      maxEntryHome.parent.insertBefore(maxEntry,
        maxEntryHome.next?.parentNode === maxEntryHome.parent ? maxEntryHome.next : null);
    }
    maxDock?.remove(); pane.dispose(); section.classList.remove('astra-oscar-host');
    if (stopLabel === null) stop.removeAttribute('aria-label'); else stop.setAttribute('aria-label', stopLabel);
    if (stopTitle === null) stop.removeAttribute('title'); else stop.setAttribute('title', stopTitle);
    for (const { element, hidden, disabled } of saved) { element.hidden = hidden; if ('disabled' in element) element.disabled = disabled; }
  } };
}
