import { describe, expect, it, vi } from 'vitest';
import {
  isUnclaimedPrintableKey,
  routePrintableKeyToComposer,
} from '../../src/ui/public/modules/composer-type-to-focus.js';

function fixture(options: {
  value?: string;
  selectionStart?: number;
  selectionEnd?: number;
  targetSelector?: string | null;
  blockingSurface?: boolean;
  visible?: boolean;
} = {}) {
  const inputEvents: any[] = [];
  const input: any = {
    value: options.value || '',
    selectionStart: options.selectionStart ?? (options.value || '').length,
    selectionEnd: options.selectionEnd ?? options.selectionStart ?? (options.value || '').length,
    disabled: false,
    readOnly: false,
    focus: vi.fn(),
    closest: vi.fn(() => null),
    getClientRects: vi.fn(() => options.visible === false ? [] : [{}]),
    setRangeText(text: string, start: number, end: number) {
      this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`;
      this.selectionStart = start + text.length;
      this.selectionEnd = this.selectionStart;
    },
    dispatchEvent: vi.fn((event: any) => inputEvents.push(event)),
  };
  const target = {
    closest: vi.fn((selector: string) => selector.includes(String(options.targetSelector)) && options.targetSelector
      ? { selector: options.targetSelector }
      : null),
  };
  const documentObject: any = {
    querySelector: vi.fn(() => options.blockingSurface ? {} : null),
    querySelectorAll: vi.fn(() => [input]),
    defaultView: {
      getComputedStyle: vi.fn(() => ({ display: 'block', visibility: 'visible' })),
      InputEvent: class {
        type: string;
        data: string;
        inputType: string;
        bubbles: boolean;
        constructor(type: string, init: any) {
          this.type = type;
          this.data = init.data;
          this.inputType = init.inputType;
          this.bubbles = init.bubbles;
        }
      },
      Event: class {},
    },
  };
  const event: any = {
    key: 'П',
    target,
    defaultPrevented: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  };
  return { documentObject, event, input, inputEvents };
}

describe('composer type-to-focus', () => {
  it('focuses the visible composer and preserves the first printable character', () => {
    const { documentObject, event, input, inputEvents } = fixture();

    expect(routePrintableKeyToComposer(event, documentObject)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(input.value).toBe('П');
    expect(inputEvents[0]).toMatchObject({ type: 'input', data: 'П', inputType: 'insertText' });
  });

  it('inserts at the retained selection instead of forcing the caret to the end', () => {
    const { documentObject, event, input } = fixture({
      value: 'тест',
      selectionStart: 1,
      selectionEnd: 3,
    });
    event.key = 'X';

    expect(routePrintableKeyToComposer(event, documentObject)).toBe(true);
    expect(input.value).toBe('тXт');
    expect(input.selectionStart).toBe(2);
  });

  it.each([
    { label: 'existing text input', patch: { targetSelector: 'input' } },
    { label: 'open modal', patch: { blockingSurface: true } },
    { label: 'hidden composer', patch: { visible: false } },
  ])('does not steal typing from $label', ({ patch }) => {
    const { documentObject, event, input } = fixture(patch);

    expect(routePrintableKeyToComposer(event, documentObject)).toBe(false);
    expect(input.focus).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves shortcuts, composition and non-printable keys alone', () => {
    expect(isUnclaimedPrintableKey({ key: 'a', ctrlKey: true })).toBe(false);
    expect(isUnclaimedPrintableKey({ key: 'Enter' })).toBe(false);
    expect(isUnclaimedPrintableKey({ key: 'а', isComposing: true })).toBe(false);
    expect(isUnclaimedPrintableKey({ key: 'а' })).toBe(true);
  });

  it('keeps Space on a focused button as button activation', () => {
    const { documentObject, event, input } = fixture({ targetSelector: 'button' });
    event.key = ' ';

    expect(routePrintableKeyToComposer(event, documentObject)).toBe(false);
    expect(input.focus).not.toHaveBeenCalled();
  });
});
