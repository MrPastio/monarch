import { describe, expect, it } from 'vitest';
import {
  computerWindowMatchesQuery,
  rankComputerWindowQueryMatches,
} from '../../src/modules/computer/window-query';

const window = (title: string, processName: string, ref: string) => ({
  windowRef: ref,
  processId: 1,
  processName,
  title,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  minimized: false,
  foreground: false,
});

describe('Computer Use window query matcher', () => {
  it('matches a Cyrillic phonetic application name without a product alias', () => {
    const target = window('Logitech\u00a0G\u00a0HUB', 'lghub', 'hwnd:0000000000000042');
    expect(computerWindowMatchesQuery(target, 'логитеч хаб')).toBe(true);
    expect(rankComputerWindowQueryMatches([
      window('Telegram', 'Telegram', 'hwnd:0000000000000041'),
      target,
    ], 'логитеч хаб').map((entry) => entry.window.windowRef)).toEqual([
      'hwnd:0000000000000042',
    ]);
  });

  it('keeps multiple matching windows visible so the runtime can fail closed on ambiguity', () => {
    expect(rankComputerWindowQueryMatches([
      window('Project - Figma', 'Figma', 'hwnd:0000000000000041'),
      window('Drafts - Figma', 'Figma', 'hwnd:0000000000000042'),
    ], 'figma')).toHaveLength(2);
  });

  it('matches a localized Calculator title hosted by ApplicationFrameHost', () => {
    const target = window('Калькулятор', 'ApplicationFrameHost', 'hwnd:0000000000000042');
    expect(computerWindowMatchesQuery(target, 'calculator')).toBe(true);
    expect(rankComputerWindowQueryMatches([target], 'calculator')).toHaveLength(1);
  });
});
