import { describe, expect, it, vi } from 'vitest';
import { createAstraProductBridge } from '../../src/ui/public/modules/astra-product-bridge.js';

function setup(href = 'http://127.0.0.1:4317/') {
  const state = { href };
  const location = { get href() { return state.href; } };
  const history = { state: null, replaceState: vi.fn((_state, _unused, next) => { state.href = String(next); }) };
  const host = { pickTarget: vi.fn(async value => value), pickWindow: vi.fn(async value => value),
    issueComputerAction: vi.fn(async () => ({ status: 'proposed', plan: { selectionId: 'computer_action_plan_' + 'a'.repeat(32) } })),
    windowSelections: vi.fn(async () => []), computerActionPlans: vi.fn(async () => []) };
  const desktop = { getAppInfo: vi.fn(async () => ({ astra: { pilot: true } })), astraPilot: host };
  return { state, location, history, host, desktop } as any;
}

describe('Astra exact product-pilot renderer bridge', () => {
  it('binds native selections to the current ordinary conversation without changing another conversation', async () => {
    const s = setup(), bridge = await createAstraProductBridge(s.desktop, s.location, s.history);
    const first = await bridge!.forConversation('ordinary_chat_1');
    const second = await bridge!.forConversation('ordinary_chat_2');
    await first!.pickTarget({ version: 1, requestId: 'pick_1', access: 'observe' });
    await second!.pickTarget({ version: 1, requestId: 'pick_2', access: 'observe' });
    expect(s.host.pickTarget.mock.calls.map((args: any[]) => args[0].conversationId)).toEqual(['ordinary_chat_1', 'ordinary_chat_2']);
    expect(() => first!.windowSelections({ version: 1, kind: 'list', source: { conversationId: 'ordinary_chat_2' } })).toThrow('rejected');
    await expect(bridge!.forConversation('../other')).rejects.toThrow('identity');
    expect((await bridge!.bootstrap()).conversationId).toBe('astra_product_pilot');
  });
  it('is absent by default and exposes one fixed opaque pilot conversation only when admitted', async () => {
    const disabled = setup(); disabled.desktop.getAppInfo.mockResolvedValue({ astra: { pilot: false } });
    await expect(createAstraProductBridge(disabled.desktop, disabled.location, disabled.history)).resolves.toBeNull();
    const s = setup(), bridge = await createAstraProductBridge(s.desktop, s.location, s.history);
    expect(bridge!.maxPreview).toBe(false);
    await expect(bridge!.bootstrap()).resolves.toMatchObject({ deployment: 'isolated-validation', conversationId: 'astra_product_pilot',
      surface: { state: 'idle' }, computerObservation: true, computerActions: true,
      computerSource: { conversationId: 'astra_product_pilot' } });
    await bridge!.pickWindow({ version: 1, requestId: 'pick_1', source: { conversationId: 'astra_product_pilot' } });
    expect(s.host.pickWindow).toHaveBeenCalledWith({ version: 1, requestId: 'pick_1', conversationId: 'astra_product_pilot' });
  });

  it('carries only the admitted MAX preview bit into the Astra composer owner', async () => {
    const s = setup(); s.desktop.getAppInfo.mockResolvedValue({ astra: { pilot: true, maxPreview: true } });
    const bridge = await createAstraProductBridge(s.desktop, s.location, s.history);
    expect(bridge!.maxPreview).toBe(true);
    expect(JSON.stringify(bridge)).not.toMatch(/token|endpoint|digest|credential/iu);
  });

  it('persists only pending/Turn pointers in the URL and rejects conflicting or stale state', async () => {
    const s = setup(), bridge = await createAstraProductBridge(s.desktop, s.location, s.history);
    await bridge!.savePending('request_1'); expect((await bridge!.bootstrap()).surface).toEqual({ state: 'pending', requestId: 'request_1' });
    await expect(bridge!.clearPending('other')).rejects.toThrow('changed');
    const turn = 'oscar_turn_' + 'b'.repeat(32); await bridge!.saveLinked(turn);
    expect((await bridge!.bootstrap()).surface).toEqual({ state: 'linked', turnId: turn });
    await expect(bridge!.clearPending('request_1')).rejects.toThrow('changed');
    expect(s.state.href).not.toMatch(/host|token|path/u);
    const conflict = setup(`http://127.0.0.1:4317/?astraPendingRequestId=request_1&astraTurnId=${turn}`);
    const conflictingBridge = await createAstraProductBridge(conflict.desktop, conflict.location, conflict.history);
    await expect(conflictingBridge!.bootstrap()).rejects.toThrow('conflict');
  });

  it('strips renderer source wrappers and unwraps only a proposed action plan', async () => {
    const s = setup(), bridge = await createAstraProductBridge(s.desktop, s.location, s.history);
    await bridge!.windowSelections({ version: 1, kind: 'list', source: { conversationId: 'astra_product_pilot' } });
    expect(s.host.windowSelections).toHaveBeenCalledWith({ version: 1, conversationId: 'astra_product_pilot', kind: 'list' });
    await bridge!.computerActionPlans({ version: 1, kind: 'revoke', selectionId: 'computer_action_plan_' + 'c'.repeat(32),
      source: { conversationId: 'astra_product_pilot' } });
    expect(s.host.computerActionPlans.mock.calls[0]![0]).not.toHaveProperty('source');
    await expect(bridge!.issueComputerAction({ version: 1, requestId: 'action_1', taskId: 'task_1', action: { kind: 'close' },
      source: { conversationId: 'astra_product_pilot' } })).resolves.toEqual({ selectionId: 'computer_action_plan_' + 'a'.repeat(32) });
  });
});
