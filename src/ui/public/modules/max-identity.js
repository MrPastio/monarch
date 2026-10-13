// A shared cloud glyph; decorative only. Availability is described separately.
export const maxNetworkVisual = `<span class="max-network" aria-hidden="true"><svg viewBox="0 0 120 120" fill="none">
  <path class="max-cloud-outline" d="M30 84C19 84 12 77 12 67c0-10 7-18 17-19 0-12 9-21 21-21 5 0 9 1 13 4 4-10 12-15 22-13 12 2 18 12 17 23 11 2 18 11 18 22 0 12-9 21-22 21Z" transform="translate(0 5) scale(.94)"/>
  <path class="max-cloud-bar max-cloud-bar-one" d="M43 73V62"/>
  <path class="max-cloud-bar max-cloud-bar-two" d="M59 73V49"/>
  <path class="max-cloud-bar max-cloud-bar-three" d="M75 73V57"/>
</svg></span>`;

export function renderMaxModeButton(button, selected, localLabel, maxLabel = '') {
  if (!button) return;
  const label = selected ? `MAX${maxLabel ? ' · ' + maxLabel : ''}` : localLabel;
  if (selected) {
    const current = button.querySelector('.max-mode-label');
    if (button.dataset.maxMode !== 'true' || !current) button.innerHTML = `${maxNetworkVisual}<span class="max-mode-label"></span>`;
    button.querySelector('.max-mode-label').textContent = label;
  } else if (button.textContent !== localLabel) button.textContent = localLabel;
  button.dataset.maxMode = String(selected);
  const accessible = selected ? `Модель: ${label} · обработка через интернет. Нажми, чтобы сменить` : `Модель: ${localLabel}. Нажми, чтобы сменить`;
  button.setAttribute('aria-label', accessible);
  button.title = accessible;
}
