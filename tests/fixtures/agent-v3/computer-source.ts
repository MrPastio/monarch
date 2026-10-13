/** Synthetic native metadata only. No OS discovery, screenshots, input or model. */
import path from 'node:path';
import { ComputerModule, type ComputerNativeProvider } from '../../../src/modules/computer';
export function syntheticComputerSource(root: string) {
  const window = { windowRef: 'hwnd:0000000000000042', processId: 42, processInstanceId: 'process:' + '4'.repeat(64),
    processName: 'AstraFixture', title: 'Astra synthetic window <not HTML>',
    minimized: false, foreground: false, bounds: { x: 0, y: 0, width: 400, height: 300 } };
  let captures = 0, listings = 0, inputs = 0;
  const provider: ComputerNativeProvider = {
    status: async () => ({ available: true, provider: 'synthetic-no-desktop' }),
    listWindows: async () => { listings++; return [structuredClone(window)]; },
    act: async () => { inputs++; throw Error('native-input-forbidden'); },
    observe: async (ref, screenshotPath, _signal, selection) => {
      if (ref !== window.windowRef) throw Error('synthetic-target-mismatch'); captures++;
      return { observedAt: new Date().toISOString(), ...(selection ? { selectionBinding: selection } : {}), window: structuredClone(window),
        screenshot: { path: screenshotPath, sha256: 'a'.repeat(64), perceptualHash: 'a'.repeat(16), width: 400, height: 300, captureMethod: 'synthetic', occlusionSafe: true },
        stateFingerprint: 'synthetic', focusedElementId: null, truncated: false,
        elements: [{ elementId: 'owned_editor', automationId: 'qa', className: 'Edit', controlType: 'Edit', name: 'Owned editor',
          value: 'ASTRA_OSCAR_WINDOW_42 <script>not executable</script>', password: false, enabled: true, offscreen: false,
          focused: false, focusable: true, patterns: ['value'], bounds: { x: 0, y: 0, width: 200, height: 100 } }] };
    },
  };
  const module = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'computer-runtime'), observationRoot: path.join(root, 'observations'),
    controlStatePath: path.join(root, 'computer-control.json'), nativeProvider: provider,
    visionAnalyzer: { analyze: async () => { throw Error('vision-forbidden'); } } });
  return { module, provider, window, counts: () => ({ captures, listings, inputs }) };
}
export type SyntheticComputerSource = ReturnType<typeof syntheticComputerSource>;
