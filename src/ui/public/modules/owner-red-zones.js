import { addOwnerRedZone, listOwnerRedZones, removeOwnerRedZone } from './api.js';
import { readErrorMessage } from './utils.js';

export function initOwnerRedZones() {
  const well = document.getElementById('red-zone-well');
  const list = document.getElementById('red-zone-list');
  const pick = document.getElementById('red-zone-pick');
  const feedback = document.getElementById('red-zone-feedback');
  if (!well || !list || !pick) return;

  const setFeedback = (text) => { if (feedback) feedback.textContent = text || ''; };
  const render = (zones) => {
    if (!zones.length) {
      list.innerHTML = '<p class="red-zone-empty">Пока пусто. Добавь папку, которую нельзя трогать.</p>';
      return;
    }
    list.replaceChildren(...zones.map((zone) => {
      const chip = document.createElement('article');
      chip.className = 'red-zone-chip';
      chip.dataset.id = zone.id;
      const copy = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = zone.label;
      const pathLine = document.createElement('small');
      pathLine.textContent = zone.path;
      pathLine.title = zone.path;
      copy.append(name, pathLine);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Открыть эту папку снова');
      remove.textContent = '×';
      remove.addEventListener('click', async () => {
        try {
          const result = await removeOwnerRedZone(zone.id);
          render(result.zones || []);
          setFeedback('Зона снята. Oscar снова может заходить сюда при полном доступе.');
        } catch (error) {
          setFeedback(readErrorMessage(error));
        }
      });
      chip.append(copy, remove);
      return chip;
    }));
  };

  const addPath = async (pathValue) => {
    const next = String(pathValue || '').trim();
    if (!next) return;
    try {
      const result = await addOwnerRedZone(next);
      render(result.zones || []);
      setFeedback(result.zone ? 'Закрыто: ' + result.zone.label : '');
    } catch (error) {
      setFeedback(readErrorMessage(error));
    }
  };

  well.addEventListener('click', () => pick.click());
  well.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick.click(); }
  });
  pick.addEventListener('click', async (event) => {
    event.stopPropagation();
    const picker = window.monarchDesktop?.pickRedZoneFolder;
    if (typeof picker !== 'function') {
      setFeedback('Выбор папки доступен в приложении Monarch.');
      return;
    }
    const selected = await picker();
    if (selected) await addPath(selected);
  });
  const heat = (on) => well.classList.toggle('is-hot', on);
  well.addEventListener('dragenter', (event) => { event.preventDefault(); heat(true); });
  well.addEventListener('dragover', (event) => { event.preventDefault(); heat(true); });
  well.addEventListener('dragleave', () => heat(false));
  well.addEventListener('drop', async (event) => {
    event.preventDefault();
    heat(false);
    const file = event.dataTransfer?.files?.[0];
    const dropped = file && typeof window.monarchDesktop?.pathForDroppedFile === 'function'
      ? window.monarchDesktop.pathForDroppedFile(file)
      : '';
    if (dropped) await addPath(dropped);
    else setFeedback('Перетащи папку из проводника.');
  });

  void listOwnerRedZones().then((payload) => {
    render(payload.zones || []);
  }).catch((error) => setFeedback(readErrorMessage(error)));
}
