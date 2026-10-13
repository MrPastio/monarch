// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderRamFit } from '../../src/ui/public/modules/model-manager.js';

describe('Models page memory fit', () => {
  it('says the model fits and draws its share of this computer memory', () => {
    const html = renderRamFit(8, 32);
    expect(html).toContain('data-fit="ok"');
    expect(html).toContain('--share:0.250');
    expect(html).toContain('Нужно около 8 ГБ памяти, у тебя 32 ГБ — хватает');
  });

  it('names the missing memory instead of hiding it', () => {
    const html = renderRamFit(30, 15.6);
    expect(html).toContain('data-fit="short"');
    expect(html).toContain('--share:1.000');
    expect(html).toContain('у тебя 15,6 ГБ — не хватает 15 ГБ, будет медленнее');
  });

  it('renders nothing without trustworthy numbers', () => {
    expect(renderRamFit(undefined, 32)).toBe('');
    expect(renderRamFit(8, Number.NaN)).toBe('');
  });
});
