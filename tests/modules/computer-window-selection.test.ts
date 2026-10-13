import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ComputerUseNativeBridge, validateComputerWindowSelection } from '../../src/modules/computer/native-bridge';

describe('Computer native selected-window binding transport', () => {
  const processInstanceId = `process:${'4'.repeat(64)}`;
  it.each([null, {}, { processId: 0, processInstanceId, title: 'QA' }, { processId: 42.5, processInstanceId, title: 'QA' },
    { processId: '42', processInstanceId, title: 'QA' }, { processId: 42, title: 'QA' },
    { processId: 42, processInstanceId: 'process:invalid', title: 'QA' }, { processId: 42, processInstanceId, title: '' },
    { processId: 42, processInstanceId, title: 'QA', fallback: true }])
  ('rejects malformed selection without normalization (%#)', value => {
    expect(() => validateComputerWindowSelection(value)).toThrow(expect.objectContaining({ code: 'window-selection-binding-invalid' }));
  });
  it('copies and freezes the exact title instead of rewriting the selected identity', () => {
    const source = { processId: 42, processInstanceId, title: ' Exact QA ' }, binding = validateComputerWindowSelection(source);
    source.title = 'changed'; expect(binding).toEqual({ processId: 42, processInstanceId, title: ' Exact QA ' }); expect(Object.isFrozen(binding)).toBe(true);
  });
  it('sends the binding to the native helper and preserves the legacy unbound request', async () => {
    const bridge = new ComputerUseNativeBridge({ monarchRoot: process.cwd(), runtimeRoot: path.join(process.env.TEMP!, 'native-selection-no-io'),
      prebuiltBinaryPath: path.join(process.env.TEMP!, 'no-prebuilt.exe') });
    const internals = bridge as unknown as { invoke(request: unknown, signal?: AbortSignal): Promise<unknown> };
    const invoke = vi.spyOn(internals, 'invoke').mockResolvedValue({});
    try {
      const target = path.join(process.env.TEMP!, 'not-created.png'), binding = { processId: 42, processInstanceId, title: 'Exact QA' };
      await bridge.observe('hwnd:42', target, undefined, binding);
      expect(invoke.mock.calls[0]![0]).toEqual({ command: 'observe', windowRef: 'hwnd:42', screenshotPath: path.resolve(target), selectionBinding: binding });
      await bridge.observe('hwnd:42', target);
      expect(invoke.mock.calls[1]![0]).toEqual({ command: 'observe', windowRef: 'hwnd:42', screenshotPath: path.resolve(target) });
      await bridge.inspectWindow('hwnd:42');
      expect(invoke.mock.calls[2]![0]).toEqual({ command: 'inspect-window', windowRef: 'hwnd:42' });
      await expect(bridge.inspectWindow('not-a-window')).rejects.toMatchObject({ code: 'window-ref-invalid' });
    } finally { invoke.mockRestore(); }
  });
});
