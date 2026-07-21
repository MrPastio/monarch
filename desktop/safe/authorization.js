const bridge = window.monarchSafeAuthorization;
const cancelButton = document.querySelector('#authorization-cancel');
const confirmButton = document.querySelector('#authorization-confirm');

bridge?.onPrompt((prompt) => {
  document.body.dataset.tone = prompt.tone === 'primary' ? 'primary' : 'danger';
  document.querySelector('#authorization-title').textContent = prompt.title || 'Подтверждение';
  document.querySelector('#authorization-message').textContent = prompt.message || '';
  document.querySelector('#authorization-detail').textContent = prompt.detail || '';
  confirmButton.textContent = prompt.confirmLabel || 'Продолжить';
  confirmButton.className = prompt.tone === 'primary' ? 'primary' : 'danger';
  document.body.dataset.ready = 'true';
  confirmButton.focus();
});

function respond(confirmed) {
  cancelButton.disabled = true;
  confirmButton.disabled = true;
  bridge?.respond(confirmed === true);
}

cancelButton.addEventListener('click', () => respond(false));
confirmButton.addEventListener('click', () => respond(true));
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  respond(false);
});
