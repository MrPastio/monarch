import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { paginateExistingList, sectionSwitcher, initCompactLayout } from '../../src/ui/public/modules/compact-layout.js';
import { renderPagedList, resetCollectionPage } from '../../src/ui/public/modules/collection-pages.js';

let dom: JSDOM;
let dispose = () => {};
beforeEach(() => {
  dom = new JSDOM('<main><div id="list"></div></main>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
});
afterEach(() => { dispose(); dom.window.close(); vi.unstubAllGlobals(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it('retains all records, original listeners and values across pages and clamps after replacement', async () => {
  const root = document.querySelector('#list')!;
  root.innerHTML = Array.from({ length: 31 }, (_, i) => `<button>${i}</button>`).join('');
  const last = root.lastElementChild!;
  const clicked = vi.fn(); last.addEventListener('click', clicked);
  dispose = paginateExistingList(root);
  const nav = root.nextElementSibling!;
  const visible = () => [...root.children].filter(node => !node.classList.contains('collection-page-hidden'));
  const seen = new Set<string>();
  for (let p = 0; p < 6; p++) {
    visible().forEach(node => seen.add(node.textContent!));
    if (p < 5) (nav.lastElementChild as HTMLElement).click();
  }
  expect(seen.size).toBe(31);
  expect(visible()).toEqual([last]);
  (last as HTMLElement).click(); expect(clicked).toHaveBeenCalledOnce();
  root.innerHTML = '<button>replacement</button>'; await tick();
  expect(visible()).toHaveLength(1); expect((nav as HTMLElement).hidden).toBe(true);
});

it('renders all collection pages and keeps action IDs exact', () => {
  const root = document.querySelector('#list')!;
  const records = Array.from({ length: 19 }, (_, i) => `id-${i}`);
  renderPagedList(root, records, id => `<button data-id="${id}">${id}</button>`, 'empty');
  const seen: string[] = [];
  do {
    seen.push(...[...root.querySelectorAll('[data-id]')].map(node => node.getAttribute('data-id')!));
    const next = root.querySelector<HTMLButtonElement>('[data-collection-step="1"]:not(:disabled)');
    if (!next) break;
    next.click();
  } while (true);
  expect(seen).toEqual(records);
  resetCollectionPage(root);
  renderPagedList(root, records, id => `<span>${id}</span>`, 'empty');
  expect(root.firstElementChild?.textContent).toBe('id-0');
  renderPagedList(root, [], String, '<unsafe>');
  expect(root.querySelector('unsafe')).toBeNull();
  expect(root.textContent).toBe('<unsafe>');
});

it('keeps form controls and reveals the correct section for validation and PIN navigation', () => {
  const root = document.querySelector('#list')!;
  root.innerHTML = '<form><section id="a"><input value="draft"></section><section id="b"><input required></section><button type="submit">Save</button></form>';
  const form = root.firstElementChild!;
  const input = form.querySelector('input')!;
  sectionSwitcher(form, [['One', '#a'], ['Two', '#b']], 'Preferences');
  const panels = [...form.querySelectorAll<HTMLElement>('.compact-section-panel')];
  expect(panels.map(p => p.hidden)).toEqual([false, true]);
  form.querySelector('#b input')!.dispatchEvent(new dom.window.Event('invalid'));
  expect(panels.map(p => p.hidden)).toEqual([true, false]);
  input.dispatchEvent(new dom.window.Event('monarch:reveal', { bubbles: true }));
  expect(panels.map(p => p.hidden)).toEqual([false, true]);
  expect(form.querySelector('input')).toBe(input); expect(input.value).toBe('draft');
  expect(form.querySelector('button[type="submit"]')).not.toBeNull();
});

it('handles dynamically replaced catalogs without duplicate pagers or observing its own updates forever', async () => {
  dispose = initCompactLayout();
  const main = document.querySelector('main')!;
  main.innerHTML = '<div class="models-card-grid">' + '<article>Model</article>'.repeat(20) + '</div>';
  await tick();
  expect(main.querySelectorAll('.collection-pager')).toHaveLength(1);
  expect(main.querySelectorAll('.collection-page-hidden')).toHaveLength(14);
  main.innerHTML = '<div class="models-card-grid"><article>New</article></div>';
  await tick(); await tick();
  expect(main.querySelectorAll('.collection-pager')).toHaveLength(1);
  expect(main.querySelectorAll('.collection-page-hidden')).toHaveLength(0);
});
