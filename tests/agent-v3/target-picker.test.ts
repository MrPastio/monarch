import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, realpath, rm, mkdir, symlink, link } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraTargetSelectionStore } from '../../src/app/astra-target-selection-store';
import { AstraTargetPicker, type AstraPickerRequest, type AstraPickerSource } from '../../src/app/astra-target-picker';
// @ts-expect-error Existing Electron .mjs modules are deliberately not TypeScript source.
import { createAstraTargetDialog, registerAstraTargetPickerIpc } from '../../desktop/electron/astra-target-dialog.mjs';

const roots: string[] = [], journals: AstraJournal[] = [];
const actor = { id: 'sha256:' + 'd'.repeat(64), source: 'desktop' as const };
const request = (access: AstraPickerRequest['access'] = 'observe'): AstraPickerRequest => ({ version: 1, requestId: 'pick_request', access });
async function setup() {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-target-picker-'))); roots.push(root);
  await writeFile(path.join(root, '.fixture-marker'), 'astra-v3-target-picker-only', { flag: 'wx' });
  await writeFile(path.join(root, 'Другой вход.txt'), 'owned synthetic bytes', { flag: 'wx' });
  const journal = new AstraJournal(path.join(root, 'selection.sqlite')); journals.push(journal);
  const store = new AstraTargetSelectionStore({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: 'picker', journal });
  const source: AstraPickerSource = { actor: { ...actor }, conversationId: 'conversation', epoch: 'page_1' };
  const choose = vi.fn(async (): Promise<string | null> => path.join(root, 'Другой вход.txt'));
  const options = { deployment: 'isolated-validation' as const, canonicalRoot: root, store, currentSource: () => source, choose,
    ttlMs: 60000, maxReadBytes: 4096, maxCreateBytes: 4096, timeoutMs: 1000 };
  return { root, journal, store, source, choose, options, picker: new AstraTargetPicker(options), caller: vi.fn() };
}
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(await realpath('.test-tmp'));
    expect(path.basename(root).startsWith('astra-v3-target-picker-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-v3-target-picker-only');
    await rm(root, { recursive: true, force: false });
  }
});
describe('trusted target producer and native dialog boundary', () => {
  it('issues a real selected path; exact replay after producer restart does not reopen or renew', async () => {
    const s = await setup(), selected = await s.picker.pick(request(), s.caller), budget = s.journal.capacity();
    expect(selected).toMatchObject({ status: 'selected', selection: { targets: [{ targetId: 'picked', label: 'Другой вход.txt', access: 'observe' }] } });
    expect(JSON.stringify(selected)).not.toContain(s.root); expect(s.choose).toHaveBeenCalledOnce();
    expect(await new AstraTargetPicker(s.options).pick(request(), s.caller)).toEqual(selected);
    expect(s.choose).toHaveBeenCalledOnce(); expect(s.journal.capacity()).toEqual(budget);
    await expect(s.picker.pick(request('exclusive-create'), s.caller)).rejects.toThrow('request-conflict');
    if (selected.status !== 'selected') throw Error('selection');
    s.store.revoke(selected.selection.selectionId, s.source);
    await expect(s.picker.pick(request(), s.caller)).rejects.toThrow('selection-unavailable'); expect(s.choose).toHaveBeenCalledOnce();
  });
  it.each(['actor', 'conversationId', 'epoch'] as const)('rejects a changed %s while native dialog is open', async field => {
    const s = await setup(), budget = s.journal.capacity();
    s.choose.mockImplementationOnce(async () => { if (field === 'actor') s.source.actor.id = 'sha256:' + 'e'.repeat(64); else s.source[field] = 'other';
      return path.join(s.root, 'Другой вход.txt'); });
    await expect(s.picker.pick(request(), s.caller)).rejects.toThrow('source-changed'); expect(s.journal.capacity()).toEqual(budget);
  });
  it('rechecks caller after dialog and refuses untrusted caller before opening it', async () => {
    const s = await setup();
    await expect(s.picker.pick(request(), () => { throw Error('foreign-window'); })).rejects.toThrow('foreign-window'); expect(s.choose).not.toHaveBeenCalled();
    let trusted = true; s.choose.mockImplementationOnce(async () => { trusted = false; return path.join(s.root, 'Другой вход.txt'); });
    await expect(s.picker.pick(request(), () => { if (!trusted) throw Error('navigated-frame'); })).rejects.toThrow('navigated-frame');
    expect(s.store.list(s.source)).toEqual([]);
  });
  it.each(['path', 'actor', 'root', 'confirmed', 'maxBytes'])('does not accept renderer-supplied %s', async key => {
    const s = await setup(); await expect(s.picker.pick({ ...request(), [key]: 'untrusted' }, s.caller)).rejects.toThrow('request');
    expect(s.choose).not.toHaveBeenCalled(); expect(s.store.list(s.source)).toEqual([]);
  });
  it('coalesces exact concurrent picks and refuses another request while modal is open', async () => {
    const s = await setup(); let release!: (path: string) => void;
    s.choose.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = s.picker.pick(request(), s.caller), second = s.picker.pick(request(), s.caller);
    await expect(s.picker.pick({ ...request(), requestId: 'another' }, s.caller)).rejects.toThrow('busy');
    release(path.join(s.root, 'Другой вход.txt')); expect(await first).toEqual(await second); expect(s.choose).toHaveBeenCalledOnce();
    expect(s.store.list(s.source)).toHaveLength(1);
  });
  it('cancel does not issue a selection or reserve storage', async () => {
    const s = await setup(), budget = s.journal.capacity(); s.choose.mockResolvedValueOnce(null);
    expect(await s.picker.pick(request(), s.caller)).toEqual({ status: 'cancelled' }); expect(s.journal.capacity()).toEqual(budget);
  });
  it('accepts only a new create leaf, without creating the file or accepting overwrite', async () => {
    const s = await setup(); s.choose.mockResolvedValueOnce(path.join(s.root, 'Новый файл.txt'));
    expect(await s.picker.pick(request('exclusive-create'), s.caller)).toMatchObject({ status: 'selected' });
    await expect(readFile(path.join(s.root, 'Новый файл.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(s.picker.pick({ ...request('exclusive-create'), requestId: 'existing' }, s.caller)).rejects.toThrow('target-not-readable-or-exists');
    s.choose.mockResolvedValueOnce(path.join(s.root, 'nested', 'new.txt'));
    await expect(s.picker.pick({ ...request('exclusive-create'), requestId: 'nested' }, s.caller)).rejects.toThrow('create-leaf-required');
  });
  it.each(['outside', 'ADS', 'device', 'directory'] as const)('refuses %s selection before issuing anything', async kind => {
    const s = await setup(); const chosen = kind === 'outside' ? path.join(path.dirname(s.root), 'not-in-scope.txt')
      : kind === 'ADS' ? path.join(s.root, 'Другой вход.txt:secret') : kind === 'device' ? path.join(s.root, 'CON.txt') : s.root;
    s.choose.mockResolvedValueOnce(chosen); await expect(s.picker.pick(request(), s.caller)).rejects.toThrow(); expect(s.store.list(s.source)).toEqual([]);
  });
  it('rejects junction traversal and hard links; all test links stay within marked fixture', async () => {
    const s = await setup(); await mkdir(path.join(s.root, 'real')); await writeFile(path.join(s.root, 'real', 'leaf.txt'), 'owned', { flag: 'wx' });
    await symlink(path.join(s.root, 'real'), path.join(s.root, 'redirect'), 'junction');
    s.choose.mockResolvedValueOnce(path.join(s.root, 'redirect', 'leaf.txt'));
    await expect(s.picker.pick(request(), s.caller)).rejects.toThrow('reparse-path');
    await link(path.join(s.root, 'Другой вход.txt'), path.join(s.root, 'alias.txt')); s.choose.mockResolvedValueOnce(path.join(s.root, 'alias.txt'));
    await expect(s.picker.pick(request(), s.caller)).rejects.toThrow('target-not-readable-or-exists'); expect(s.store.list(s.source)).toEqual([]);
  });
  it('rejects a producer validating against another root', async () => {
    const s = await setup(); expect(() => new AstraTargetPicker({ ...s.options, canonicalRoot: path.dirname(s.root) })).toThrow('producer-root');
  });
  it('native adapter uses exact parent, suppresses recent-list additions and checks window after modal', async () => {
    const s = await setup(), window = {}, assertWindow = vi.fn();
    const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [path.join(s.root, 'Другой вход.txt')] })),
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: path.join(s.root, 'new.txt') })) };
    const choose = createAstraTargetDialog({ deployment: 'isolated-validation', dialog, window, assertWindow });
    expect(await choose('observe', s.root)).toBe(path.join(s.root, 'Другой вход.txt'));
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(window, expect.objectContaining({ defaultPath: s.root, properties: ['openFile', 'dontAddToRecent'] }));
    expect(assertWindow).toHaveBeenCalledTimes(2); expect(await choose('exclusive-create', s.root)).toBe(path.join(s.root, 'new.txt'));
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(window, expect.objectContaining({ properties: ['dontAddToRecent'] }));
    let handler!: (event: unknown, request: unknown) => Promise<unknown>;
    const ipcMain = { handle: vi.fn((_key, fn) => { handler = fn; }), removeHandler: vi.fn() };
    const frame = { url: 'http://127.0.0.1:12345/' }, contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
    const sender = { sender: contents, senderFrame: frame }, assertTrustedRenderer = vi.fn();
    const dispose = registerAstraTargetPickerIpc({ deployment: 'isolated-validation', ipcMain, picker: new AstraTargetPicker({ ...s.options, choose }),
      window: { webContents: contents, isDestroyed: () => false }, origin: 'http://127.0.0.1:12345', assertTrustedRenderer });
    await expect(handler({}, request())).rejects.toThrow('untrusted-frame');
    await expect(handler({ sender: contents, senderFrame: { url: frame.url } }, request())).rejects.toThrow('untrusted-frame');
    expect(await handler(sender, request())).toMatchObject({ status: 'selected' }); dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('monarch:astra-pick-target');
    await expect(handler(sender, request())).rejects.toThrow('untrusted-frame');
  });
  it('same-URL navigation while picker is open invalidates IPC; listener is released', async () => {
    const s = await setup(), frame = { url: 'http://127.0.0.1:12345/' };
    const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
    s.choose.mockImplementationOnce(async () => { contents.emit('did-start-navigation', { isMainFrame: true }); return path.join(s.root, 'Другой вход.txt'); });
    let handler!: (event: unknown, request: unknown) => Promise<unknown>;
    const ipcMain = { handle: (_key: string, fn: typeof handler) => { handler = fn; }, removeHandler: vi.fn() };
    registerAstraTargetPickerIpc({ deployment: 'isolated-validation', ipcMain, picker: s.picker, window: { webContents: contents, isDestroyed: () => false },
      origin: 'http://127.0.0.1:12345', assertTrustedRenderer: () => {} });
    await expect(handler({ sender: contents, senderFrame: frame }, request())).rejects.toThrow('untrusted-frame');
    expect(contents.listenerCount('did-start-navigation')).toBe(0); expect(s.store.list(s.source)).toEqual([]);
  });
});
