import { escapeHtml } from './utils.js';

const pages = new WeakMap();

export function resetCollectionPage(element) {
  if (element) pages.delete(element);
}

export function collectionPage(element, items, pageSize = 6) {
  const total = Math.max(1, Math.ceil(items.length / pageSize));
  const index = Math.min(pages.get(element) || 0, total - 1);
  if (element) pages.set(element, index);
  return { items: items.slice(index * pageSize, (index + 1) * pageSize), index, total, pageSize };
}

/** Paging keeps every item reachable; it never changes the collection or action IDs. */
export function renderPagedList(element, items, renderer, emptyText, options = {}) {
  if (!element) return;
  const page = collectionPage(element, items, options.pageSize || 6);
  const controls = page.total > 1 ? `<nav class="collection-pager" aria-label="Страницы списка">
    <button type="button" data-collection-step="-1" ${page.index === 0 ? 'disabled' : ''} aria-label="Предыдущая страница">←</button>
    <span role="status">${page.index * page.pageSize + 1}–${Math.min(items.length, (page.index + 1) * page.pageSize)} из ${items.length}</span>
    <button type="button" data-collection-step="1" ${page.index + 1 === page.total ? 'disabled' : ''} aria-label="Следующая страница">→</button>
  </nav>` : '';
  element.innerHTML = (items.length ? page.items.map(renderer).join('') : `<div class="security-list-empty">${escapeHtml(emptyText)}</div>`) + controls;
  for (const button of element.querySelectorAll('[data-collection-step]')) {
    button.addEventListener('click', () => {
      const step = Number(button.dataset.collectionStep);
      pages.set(element, Math.max(0, Math.min(page.total - 1, page.index + step)));
      if (options.onPage) options.onPage();
      else renderPagedList(element, items, renderer, emptyText, options);
      const next = element.querySelector(`[data-collection-step="${step}"]:not(:disabled)`)
        || element.querySelector('[data-collection-step]:not(:disabled)');
      next?.focus({ preventScroll: true });
      options.onRender?.();
    });
  }
}
