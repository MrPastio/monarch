// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initAstraMaxSetup } from '../../src/ui/public/modules/astra-max-setup.js';
import { MAX_CLOUD_PROVIDERS, cloudRole } from '../../src/agent-v3/max-cloud-catalog';
const el = (id: string) => document.getElementById(id) as any;
const providers = MAX_CLOUD_PROVIDERS.map(p => ({ id: p.id, name: p.name, mark: p.mark, model: p.model,
  role: p.id === 'groq' ? 'max-gpt-oss-120b' : cloudRole(p.id, p.model), state: 'not-configured', keysUrl: p.keys, termsUrl: p.terms, privacyUrl: p.privacy }));
let configure: ReturnType<typeof vi.fn>, mode: any, memoryDecision = 'declined', memoryPosts: any[] = [];
beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.showPopover = function () { this.setAttribute('data-test-open', 'true'); };
  HTMLElement.prototype.hidePopover = function () { this.removeAttribute('data-test-open'); };
  const source = readFileSync('src/ui/public/index.html', 'utf8');
  document.body.innerHTML = '<button id="oscar-model-dropdown-btn"></button><button data-oscar-source="local">Local</button><button data-astra-max-open>MAX</button>'
    + source.match(/<dialog class="max-memory-dialog" id="max-memory-consent-dialog"[\s\S]*?<\/dialog>/)![0]
    + source.match(/<dialog id="max-connection-dialog"[\s\S]*?<\/dialog>/)![0]
    + source.match(/<section class="settings-group settings-feature max-settings-panel"[\s\S]*?<\/section>/)![0];
  el('max-connection-dialog').showModal = function () { this.open = true; };
  el('max-connection-dialog').close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  el('max-memory-consent-dialog').showModal = function () { this.open = true; };
  el('max-memory-consent-dialog').close = function (value?: string) { this.open = false; if (value !== undefined) this.returnValue = value; this.dispatchEvent(new Event('close')); };
  memoryDecision = 'declined'; memoryPosts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); memoryPosts.push(body); memoryDecision = body.decision; }
    return new Response(JSON.stringify({ ok: true, decision: memoryDecision, version: 'max-memory-v1' }), { headers: { 'Content-Type': 'application/json' } });
  }));
  configure = vi.fn(async (input: any) => ({ ok: true, available: true, providers: providers.map(p => ({ ...p, state: p.id === input.providerId ? 'ready' : 'not-configured' })) }));
  (window as any).monarchDesktop = { astraMax: { providers: async () => ({ available: true, providers }), configureProvider: configure } };
  mode = initAstraMaxSetup();
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function edit() {
  await vi.waitFor(() => expect(document.querySelectorAll('.max-provider-card')).toHaveLength(12));
  (document.querySelectorAll('.max-provider-card')[1]!.querySelector('button') as HTMLButtonElement).click();
}
const maxEntry = () => document.querySelector('[data-astra-max-open]') as HTMLButtonElement;
function enterKey() { el('astra-max-key').value = 'synthetic-not-a-real-key-12345'; el('astra-max-key').dispatchEvent(new Event('input', { bubbles: true })); }
it('connects on one screen, requires all consent and turns MAX on with the bound role', async () => {
  await edit();
  expect(document.querySelector('#astra-max-setup-dialog')).toBeNull();
  // The connection sheet lives outside Settings so the chat can open it directly.
  expect(el('astra-max-setup-form').closest('[data-settings-panel="max"]')).toBeNull();
  expect(el('astra-max-setup-form').closest('dialog')).toBe(el('max-connection-dialog'));
  expect(el('astra-max-connect').disabled).toBe(true); enterKey();
  expect(el('astra-max-setup-form').querySelector('[data-max-consent-step]')!.hasAttribute('hidden')).toBe(false);
  for (const id of ['astra-max-cloud-check', 'astra-max-context-check']) { el(id).checked = true; el(id).dispatchEvent(new Event('change', { bubbles: true })); }
  el('astra-max-setup-form').dispatchEvent(new Event('submit', { cancelable: true })); expect(configure).not.toHaveBeenCalled();
  el('astra-max-terms-check').checked = true; el('astra-max-terms-check').dispatchEvent(new Event('change', { bubbles: true }));
  el('astra-max-setup-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(el('astra-max-setup-form').hidden).toBe(true));
  expect(configure).toHaveBeenCalledTimes(1); expect(el('astra-max-key').value).toBe('');
  await vi.waitFor(() => expect(mode.selected()?.role).toBe('max-cloud:openai:gpt-4.1'));
  expect(JSON.stringify(localStorage)).not.toContain('synthetic');
});
it('the MAX button opens the connection sheet in the chat: pick a service, go back, close clears the key and consents', async () => {
  await vi.waitFor(() => expect(document.querySelectorAll('.max-provider-card')).toHaveLength(12));
  maxEntry().click();
  expect(el('max-connection-dialog').open).toBe(true);
  expect(el('astra-max-setup-form').dataset.step).toBe('pick');
  expect(document.querySelectorAll('.max-pick-choice')).toHaveLength(12);
  (document.querySelector('[data-pick="openai"]') as HTMLButtonElement).click();
  expect(el('astra-max-setup-form').dataset.step).toBe('key');
  enterKey(); el('astra-max-cloud-check').checked = true;
  el('astra-max-back').click();
  expect(el('astra-max-setup-form').dataset.step).toBe('pick'); expect(el('astra-max-key').value).toBe('');
  (document.querySelector('[data-pick="openai"]') as HTMLButtonElement).click(); enterKey(); el('astra-max-cloud-check').checked = true;
  el('max-editor-close').click(); expect(el('astra-max-key').value).toBe(''); expect(el('astra-max-cloud-check').checked).toBe(false);
});
it('failed check stays editable, clears the key and does not mark a provider connected', async () => {
  configure.mockResolvedValue({ ok: false, detail: 'Ключ не подходит' }); await edit(); enterKey();
  for (const id of ['astra-max-cloud-check', 'astra-max-context-check', 'astra-max-terms-check']) el(id).checked = true;
  el('astra-max-terms-check').dispatchEvent(new Event('change', { bubbles: true }));
  el('astra-max-setup-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(el('astra-max-setup-form').getAttribute('aria-busy')).toBe('false'));
  expect(document.querySelector('[data-astra-max-feedback]')!.textContent).toBe('Ключ не подходит');
  expect(el('astra-max-key').value).toBe(''); expect(mode.selected()).toBeNull(); expect((document.querySelector('[data-astra-max-open]') as HTMLElement).dataset.state).toBe('not-configured');
});

it('Escape dismisses the modal, clears the secret and returns focus to the service', async () => {
  await edit(); enterKey();
  expect(el('max-connection-dialog').open).toBe(true);
  el('max-connection-dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(el('max-connection-dialog').open).toBe(false);
  expect(el('astra-max-key').value).toBe('');
  expect(document.activeElement?.closest('[data-provider]')?.getAttribute('data-provider')).toBe('openai');
});

it('shows a model selector immediately and selects the exact returned model without typing', async () => {
  (window as any).monarchDesktop.astraMax.listProviderModels = vi.fn(async () => ({ ok: true, models: [{ id: 'GPT-Example', label: 'Example Model' }] }));
  await edit(); expect(el('max-provider-model').tagName).toBe('SELECT');
  expect(el('max-provider-model').closest('details')).toBeNull();
  enterKey(); el('max-models-load').click();
  await vi.waitFor(() => expect(el('max-provider-model').value).toBe('GPT-Example'));
  expect(el('max-provider-model').textContent).toBe('Example Model');
});
it('ignores a model response after closing the editor', async () => {
  let resolve: any;
  (window as any).monarchDesktop.astraMax.listProviderModels = () => new Promise(r => { resolve = r; });
  await edit(); enterKey(); el('max-models-load').click(); el('max-editor-close').click();
  resolve({ ok: true, models: [{ id: 'stale-model', label: 'Stale' }] }); await Promise.resolve();
  expect(el('max-connection-dialog').open).toBe(false); expect(el('astra-max-key').value).toBe('');
  expect(el('max-provider-model').value).not.toBe('stale-model');
});

it('searches and chooses a model with the keyboard; Escape closes just the model list', async () => {
  await edit();
  el('max-provider-model').add(new Option('Second model', 'second-model'));
  el('max-model-trigger').click();
  const search = document.querySelector('.max-model-popup input') as HTMLInputElement;
  search.value = 'Second'; search.dispatchEvent(new Event('input'));
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(el('max-provider-model').value).toBe('second-model');
  expect(el('max-model-trigger').textContent).toContain('Second model');
  el('max-model-trigger').click(); search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(el('max-model-trigger').getAttribute('aria-expanded')).toBe('false');
  expect(el('max-connection-dialog').open).toBe(true);
});

function cardButton(id: string, label: string) {
  return [...document.querySelectorAll(`[data-provider="${id}"] button`)].find(node => node.textContent === label) as HTMLButtonElement;
}
async function readyProvider(id: string, selectedProviderId = id) {
  const connected = providers.map(item => item.id === id ? { ...item, state: 'ready' } : item);
  (window as any).monarchDesktop.astraMax.providers = async () => ({ available: true, providers: connected, selectedProviderId });
  window.dispatchEvent(new CustomEvent('monarch:settings-selection', { detail: { tab: 'max' } }));
  await vi.waitFor(() => expect(document.querySelector(`[data-provider="${id}"] .max-provider-model`)).toBeTruthy());
}

it('changes a connected model without asking for the key again', async () => {
  const stored = vi.fn(async () => ({ ok: true, models: [{ id: 'gpt-4.1', label: 'GPT 4.1' }, { id: 'gpt-4.1-mini', label: 'GPT 4.1 mini' }] }));
  const update = vi.fn(async (input: any) => ({ ok: true, available: true, selectedProviderId: 'openai',
    providers: providers.map(item => item.id === input.providerId
      ? { ...item, state: 'ready', model: input.modelId, role: cloudRole(item.id, input.modelId) } : item) }));
  (window as any).monarchDesktop.astraMax.listStoredProviderModels = stored;
  (window as any).monarchDesktop.astraMax.updateProviderModel = update;
  await readyProvider('openai');
  maxEntry().click();
  await vi.waitFor(() => expect(mode.selected()?.role).toBe('max-cloud:openai:gpt-4.1'));
  cardButton('openai', 'Сменить модель').click();
  await vi.waitFor(() => expect(el('max-connection-dialog').open).toBe(true));
  expect(el('astra-max-setup-form').dataset.mode).toBe('model');
  expect(el('astra-max-key').value).toBe('');
  expect(el('astra-max-key').closest('label')?.hidden).toBe(true);
  expect(el('max-model-save').hidden).toBe(false);
  await vi.waitFor(() => expect(el('max-provider-model').options).toHaveLength(2));
  expect(stored).toHaveBeenCalledWith('openai');
  el('max-provider-model').value = 'gpt-4.1-mini';
  el('max-provider-model').dispatchEvent(new Event('change', { bubbles: true }));
  el('max-model-save').click();
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0][0]).toEqual({ providerId: 'openai', modelId: 'gpt-4.1-mini' });
  expect(JSON.stringify(update.mock.calls[0][0])).not.toMatch(/apiKey|acknowledgements|synthetic/iu);
  expect(el('max-connection-dialog').open).toBe(false);
  expect(document.querySelector('[data-provider="openai"] .max-provider-model')?.textContent).toBe('gpt-4.1-mini');
  expect(mode.selected().role).toBe('max-cloud:openai:gpt-4.1-mini');
});

it('keeps the previous model when a stored change fails', async () => {
  (window as any).monarchDesktop.astraMax.listStoredProviderModels = vi.fn(async () => ({ ok: true, models: [{ id: 'gpt-4.1', label: 'GPT 4.1' }, { id: 'gpt-4.1-mini', label: 'GPT 4.1 mini' }] }));
  (window as any).monarchDesktop.astraMax.updateProviderModel = vi.fn(async () => ({ ok: false, detail: 'Эта модель пока не ответила в нужном формате. Выбери другую модель из списка.' }));
  await readyProvider('openai');
  cardButton('openai', 'Сменить модель').click();
  await vi.waitFor(() => expect(el('max-provider-model').querySelector('option[value="gpt-4.1-mini"]')).toBeTruthy());
  el('max-provider-model').value = 'gpt-4.1-mini';
  el('max-provider-model').dispatchEvent(new Event('change', { bubbles: true }));
  el('max-model-save').click();
  await vi.waitFor(() => expect(document.querySelector('[data-astra-max-feedback]')!.textContent).toContain('не ответила'));
  expect(el('max-connection-dialog').open).toBe(true);
  expect(el('astra-max-key').value).toBe('');
  expect(document.querySelector('[data-provider="openai"] .max-provider-model')?.textContent).toBe('gpt-4.1');
});

it('does not offer Groq model changes', async () => {
  await readyProvider('groq');
  expect(document.querySelector('[data-provider="groq"] .max-provider-model')?.textContent).toBe('GPT OSS 120B');
  expect(cardButton('groq', 'Сменить модель')).toBeUndefined();
  expect(cardButton('groq', 'Настроить ключ')).toBeTruthy();
});

it('asks once per service before MAX may see memory, and sends it only after a confirmed grant', async () => {
  memoryDecision = 'undecided';
  await readyProvider('deepseek');
  maxEntry().click();
  await vi.waitFor(() => expect(el('max-memory-consent-dialog').open).toBe(true));
  expect(el('max-memory-consent-dialog').textContent).toContain('DeepSeek');
  expect(el('max-memory-consent-confirm').disabled).toBe(true);
  expect(mode.selected()).toBeNull();
  el('max-memory-consent-check').checked = true; el('max-memory-consent-check').dispatchEvent(new Event('change'));
  expect(el('max-memory-consent-confirm').disabled).toBe(false);
  el('max-memory-consent-dialog').close('granted');
  await vi.waitFor(() => expect(mode.selected()?.providerId).toBe('deepseek'));
  expect(memoryPosts).toEqual([{ providerId: 'deepseek', decision: 'granted', confirmed: true, version: 'max-memory-v1' }]);
  // Already answered: switching MAX off and on does not ask again.
  (document.querySelector('[data-oscar-source="local"]') as HTMLButtonElement).click();
  expect(mode.selected()).toBeNull();
  maxEntry().click();
  await vi.waitFor(() => expect(mode.selected()?.providerId).toBe('deepseek'));
  expect(memoryPosts).toHaveLength(1);
});
it('dismissing the memory question records nothing and still turns MAX on without memory', async () => {
  memoryDecision = 'undecided';
  await readyProvider('deepseek');
  maxEntry().click();
  await vi.waitFor(() => expect(el('max-memory-consent-dialog').open).toBe(true));
  el('max-memory-consent-dialog').close('');
  await vi.waitFor(() => expect(mode.selected()?.providerId).toBe('deepseek'));
  expect(memoryPosts).toEqual([]);
});
