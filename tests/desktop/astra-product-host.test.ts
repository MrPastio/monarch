import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { acquireAstraProductRendererGuard, issueAstraProductComputerAction,
  controlAstraProductComputerActions, controlAstraProductWindows,
  pickAstraProductTarget, pickAstraProductWindow, pickAstraTelegramTarget } from '../../desktop/electron/astra-product-host.mjs';
import { ASTRA_RUNTIME_PILOT_MODE, ASTRA_TELEGRAM_PILOT_MODE } from '../../desktop/electron/astra-pilot-policy.mjs';

const selection = { selectionId: 'selection_' + 'a'.repeat(32), expiresAt: Date.now() + 60_000,
  targets: [{ targetId: 'picked', label: 'selected.txt', access: 'observe', maxBytes: 65_536 }] };
function setup(overrides: Record<string, unknown> = {}) {
  const assertRenderer = vi.fn(), fetchImpl = vi.fn(async () => ({ status: 201, text: async () => JSON.stringify({ ok: true, selection }) }));
  return { mode: ASTRA_RUNTIME_PILOT_MODE, request: { version: 1, conversationId: 'chat', requestId: 'pick_1', access: 'observe' },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['D:\\Owned\\selected.txt'] })),
      showSaveDialog: vi.fn() }, window: {}, runtimeUrl: 'http://127.0.0.1:4317', defaultDirectory: 'D:\\Owned',
    desktopAttestationToken: 'desktop-' + 'x'.repeat(40), hostToken: 'host-' + 'y'.repeat(40), fetchImpl, assertRenderer,
    ...overrides } as any;
}

describe('Astra product native target host', () => {
  it('binds the caller to the exact main frame and invalidates same-URL navigation', () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const frame = { url: 'http://127.0.0.1:4317/chat' }; Object.assign(contents, { mainFrame: frame });
    const window = { isDestroyed: () => false, webContents: contents }, event = { sender: contents, senderFrame: frame };
    const trusted = vi.fn(), guard = acquireAstraProductRendererGuard({ window, runtimeUrl: 'http://127.0.0.1:4317',
      event, assertTrustedRenderer: trusted });
    guard.assert(); expect(trusted).toHaveBeenCalledTimes(2);
    contents.emit('did-start-navigation'); expect(() => guard.assert()).toThrow('untrusted-renderer');
    guard.dispose(); expect(contents.listenerCount('did-start-navigation')).toBe(0);
  });

  it('sends the raw path only to the authenticated runtime and returns only a descriptor', async () => {
    const input = setup(), result = await pickAstraProductTarget(input);
    expect(result).toEqual({ status: 'selected', selection });
    expect(input.assertRenderer).toHaveBeenCalledTimes(4);
    const [url, request] = input.fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4317/api/astra/v3/host/target-selections');
    expect(request.headers).toMatchObject({ 'x-monarch-desktop-attestation': input.desktopAttestationToken,
      'x-monarch-astra-host-token': input.hostToken });
    expect(JSON.parse(request.body)).toMatchObject({ selectedPaths: ['D:\\Owned\\selected.txt'] });
    expect(JSON.stringify(result)).not.toContain('D:\\Owned');
  });

  it('sends up to eight native-selected read paths as one host-owned selection', async () => {
    const filePaths = Array.from({ length: 8 }, (_, index) => `D:\\Owned\\file-${index}.txt`);
    const multiSelection = { ...selection, targets: filePaths.map((_, index) => ({
      targetId: `picked_${index}`, label: `file-${index}.txt`, access: 'observe', maxBytes: 65_536,
    })) };
    const input = setup({
      dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false,
        filePaths })), showSaveDialog: vi.fn() },
      fetchImpl: vi.fn(async () => ({ status: 201,
        text: async () => JSON.stringify({ ok: true, selection: multiSelection }) })),
    });
    await expect(pickAstraProductTarget(input)).resolves.toEqual({ status: 'selected', selection: multiSelection });
    expect(input.dialog.showOpenDialog.mock.calls[0]![1].properties).toContain('multiSelections');
    expect(JSON.parse(input.fetchImpl.mock.calls[0]![1].body)).toMatchObject({
      selectedPaths: filePaths, access: 'observe',
    });
    expect(JSON.stringify(multiSelection)).not.toContain('D:\\Owned');
  });

  it('keeps exclusive create on the single save-path contract', async () => {
    const createSelection = { ...selection, targets: [
      { targetId: 'picked', label: 'new.txt', access: 'exclusive-create', maxBytes: 16_384 },
    ] };
    const input = setup({ request: { version: 1, conversationId: 'chat', requestId: 'create_1', access: 'exclusive-create' },
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'D:\\Owned\\new.txt' })) },
      fetchImpl: vi.fn(async () => ({ status: 201,
        text: async () => JSON.stringify({ ok: true, selection: createSelection }) })) });
    await expect(pickAstraProductTarget(input)).resolves.toEqual({ status: 'selected', selection: createSelection });
    expect(JSON.parse(input.fetchImpl.mock.calls[0]![1].body)).toEqual({ ...input.request, selectedPath: 'D:\\Owned\\new.txt' });
    expect(input.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('does no runtime call on cancellation and rejects non-exact inputs', async () => {
    const cancelled = setup({ dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })), showSaveDialog: vi.fn() } });
    await expect(pickAstraProductTarget(cancelled)).resolves.toEqual({ status: 'cancelled' });
    expect(cancelled.fetchImpl).not.toHaveBeenCalled();
    await expect(pickAstraProductTarget(setup({ mode: null }))).rejects.toThrow('unavailable');
    await expect(pickAstraProductTarget(setup({ request: { version: 1, conversationId: 'chat', requestId: 'pick_1',
      access: 'observe', selectedPath: 'D:\\attacker' } }))).rejects.toThrow('request');
    const duplicate = setup({ dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false,
      filePaths: ['D:\\Owned\\same.txt', 'd:\\owned\\same.txt'] })), showSaveDialog: vi.fn() } });
    await expect(pickAstraProductTarget(duplicate)).rejects.toThrow('selected-path');
    expect(duplicate.fetchImpl).not.toHaveBeenCalled();
    const ninth = setup({ dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false,
      filePaths: Array.from({ length: 9 }, (_, index) => `D:\\Owned\\file-${index}.txt`) })), showSaveDialog: vi.fn() } });
    await expect(pickAstraProductTarget(ninth)).rejects.toThrow('file-count');
    expect(ninth.fetchImpl).not.toHaveBeenCalled();
  });

  it('returns only an actor-bound Telegram alias after explicit native selection', async () => {
    const alias = { targetAlias: 'astra_remote_alias_' + 'e'.repeat(32), expiresAt: Date.now() + 60_000,
      authority: 'read-only', authorizesCreate: false, authorizesComputer: false };
    const input = setup({ telegramMode: ASTRA_TELEGRAM_PILOT_MODE,
      request: { version: 1, chatId: -1001, userId: 2002, requestId: 'telegram_pick_1', ttlMs: 60_000 },
      fetchImpl: vi.fn(async () => ({ status: 201, text: async () => JSON.stringify({ ok: true, alias }) })) });
    await expect(pickAstraTelegramTarget(input)).resolves.toEqual({ status: 'selected', alias });
    const [url, request] = input.fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('/api/astra/v3/host/telegram-target-aliases');
    expect(JSON.parse(request.body)).toEqual({ ...input.request, selectedPath: 'D:\\Owned\\selected.txt' });
    expect(JSON.stringify(alias)).not.toContain('D:\\Owned');
    await expect(pickAstraTelegramTarget(setup({ telegramMode: null, request: input.request })))
      .rejects.toThrow('telegram-unavailable');
  });

  it('fails closed on renderer change, runtime error or an absolute-path response leak', async () => {
    const changed = setup(); changed.assertRenderer.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw Error('navigated'); });
    await expect(pickAstraProductTarget(changed)).rejects.toThrow('navigated'); expect(changed.fetchImpl).not.toHaveBeenCalled();
    const rejected = setup({ fetchImpl: vi.fn(async () => ({ status: 403, text: async () => JSON.stringify({ ok: false }) })) });
    await expect(pickAstraProductTarget(rejected)).rejects.toThrow('runtime-rejected');
    const leaked = setup({ fetchImpl: vi.fn(async () => ({ status: 201, text: async () => JSON.stringify({ ok: true,
      selection: { ...selection, selectedPath: 'D:\\leak' } }) })) });
    await expect(pickAstraProductTarget(leaked)).rejects.toThrow('runtime-rejected');
  });

  it('selects a Computer candidate by index without receiving or returning native identity', async () => {
    const candidateSet = { candidateSetId: 'window_candidates_' + 'b'.repeat(32), expiresAt: Date.now() + 60_000,
      candidates: [{ index: 0, title: 'Owned target', processName: 'OwnedFixture' }] };
    const windowSelection = { selectionId: 'window_selection_' + 'c'.repeat(32), title: 'Owned target', processName: 'OwnedFixture',
      expiresAt: Date.now() + 120_000, authority: 'observe', authorizesInput: false };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ status: 200, text: async () => JSON.stringify({ ok: true, candidates: candidateSet }) })
      .mockResolvedValueOnce({ status: 201, text: async () => JSON.stringify({ ok: true, selection: windowSelection }) });
    const input = setup({ request: { version: 1, conversationId: 'chat', requestId: 'window_1' }, fetchImpl,
      dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) } });
    const result = await pickAstraProductWindow(input); expect(result).toEqual({ status: 'selected', selection: windowSelection });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/api/astra/v3/host/window-candidates');
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('/api/astra/v3/host/window-selections');
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).toEqual({ version: 1, conversationId: 'chat', requestId: 'window_1',
      candidateSetId: candidateSet.candidateSetId, index: 0 });
    expect(JSON.stringify(result)).not.toMatch(/hwnd|processId|processInstanceId|candidateSet/u);
  });

  it('does not issue a Computer selection after cancel and rejects native fields crossing the process boundary', async () => {
    const candidateSet = { candidateSetId: 'window_candidates_' + 'b'.repeat(32), expiresAt: Date.now() + 60_000,
      candidates: [{ index: 0, title: 'Owned target', processName: 'OwnedFixture' }] };
    const cancelled = setup({ request: { version: 1, conversationId: 'chat', requestId: 'window_2' },
      fetchImpl: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, candidates: candidateSet }) })),
      dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) } });
    await expect(pickAstraProductWindow(cancelled)).resolves.toEqual({ status: 'cancelled' });
    expect(cancelled.fetchImpl).toHaveBeenCalledTimes(1);
    const leaked = setup({ request: { version: 1, conversationId: 'chat', requestId: 'window_3' },
      fetchImpl: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ ok: true,
        candidates: { ...candidateSet, candidates: [{ ...candidateSet.candidates[0], windowRef: 'hwnd:0000000000000042' }] } }) })),
      dialog: { showMessageBox: vi.fn() } });
    await expect(pickAstraProductWindow(leaked)).rejects.toThrow('candidate-response');
  });

  it('issues only an approval-required semantic Computer plan without native identity', async () => {
    const plan = { selectionId: 'computer_action_plan_' + 'd'.repeat(32), title: 'Owned target',
      summary: 'Заменить значение выбранного поля', expiresAt: Date.now() + 90_000, authority: 'approval-required', grantScope: 'none' };
    const fetchImpl = vi.fn(async () => ({ status: 201, text: async () => JSON.stringify({ ok: true, plan }) }));
    const request = { version: 1, conversationId: 'chat', requestId: 'action_1', taskId: 'task_1',
      action: { kind: 'type', elementId: 'editor', text: 'owned', textMode: 'replace' } };
    const input = setup({ request, fetchImpl });
    await expect(issueAstraProductComputerAction(input)).resolves.toEqual({ status: 'proposed', plan });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual(request);
    expect(JSON.stringify(plan)).not.toMatch(/hwnd|processId|processInstanceId|observation/u);
    const leaked = setup({ request, fetchImpl: vi.fn(async () => ({ status: 201, text: async () => JSON.stringify({ ok: true,
      plan: { ...plan, windowRef: 'hwnd:0000000000000042' } }) })) });
    await expect(issueAstraProductComputerAction(leaked)).rejects.toThrow('computer-action-response');
  });

  it('lists and revokes only opaque Computer catalogs through the authenticated host', async () => {
    const windowSelection = { selectionId: 'window_selection_' + 'c'.repeat(32), title: 'Owned target', processName: 'OwnedFixture',
      expiresAt: Date.now() + 120_000, authority: 'observe', authorizesInput: false };
    const plan = { selectionId: 'computer_action_plan_' + 'd'.repeat(32), title: 'Owned target', summary: 'Заменить значение выбранного поля',
      expiresAt: Date.now() + 90_000, authority: 'approval-required', grantScope: 'none' };
    const windows = setup({ request: { version: 1, conversationId: 'chat', kind: 'list' },
      fetchImpl: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, selections: [windowSelection] }) })) });
    await expect(controlAstraProductWindows(windows)).resolves.toEqual([windowSelection]);
    expect(String(windows.fetchImpl.mock.calls[0]![0])).toContain('/window-selections/control');
    const plans = setup({ request: { version: 1, conversationId: 'chat', kind: 'revoke', selectionId: plan.selectionId },
      fetchImpl: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, plans: [] }) })) });
    await expect(controlAstraProductComputerActions(plans)).resolves.toEqual([]);
    expect(JSON.parse(plans.fetchImpl.mock.calls[0]![1].body)).toEqual(plans.request);
    const leak = setup({ request: { version: 1, conversationId: 'chat', kind: 'list' }, fetchImpl: vi.fn(async () => ({ status: 200,
      text: async () => JSON.stringify({ ok: true, selections: [{ ...windowSelection, windowRef: 'hwnd:0000000000000042' }] }) })) });
    await expect(controlAstraProductWindows(leak)).rejects.toThrow('window-catalog-response');
  });
});
