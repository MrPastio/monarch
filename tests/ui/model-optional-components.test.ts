import { describe, expect, it } from 'vitest';
import {
  missingOptionalComponents,
  renderOptionalComponentNote,
} from '../../src/ui/public/modules/model-components.js';

function component(label: string, phase: string, expectedBytes = 0) {
  return { label, phase, expectedBytes };
}

describe('optional model components', () => {
  const pro = {
    installed: true,
    complete: false,
    components: [
      component('Qwen3.8 27B Pro', 'ready', 18_973_870_432),
      component('Qwen3.8 27B Pro MTP', 'idle', 1_680_271_648),
      component('Qwen3.8 27B Pro Vision', 'idle', 629_247_008),
    ],
  };

  it('does not count a missing extra as a missing model', () => {
    // Pro ships a 19 GB text model plus speculative-decoding and vision
    // extras. With all three folded into one "complete" flag, an installed,
    // working Pro was offered as a download.
    expect(missingOptionalComponents(pro).map(item => item.label))
      .toEqual(['Qwen3.8 27B Pro MTP', 'Qwen3.8 27B Pro Vision']);
  });

  it('reports nothing extra for a fully installed model', () => {
    expect(missingOptionalComponents({ ...pro, complete: true,
      components: pro.components.map(item => ({ ...item, phase: 'ready' })) })).toEqual([]);
  });

  it('says nothing about extras while the model itself is absent', () => {
    // There the plain "download" offer is the correct one.
    expect(missingOptionalComponents({ ...pro, installed: false })).toEqual([]);
    expect(missingOptionalComponents(null)).toEqual([]);
  });

  it('names what is missing and what it costs instead of just saying "download"', () => {
    const note = renderOptionalComponentNote(missingOptionalComponents(pro));
    expect(note).toContain('Модель установлена и работает');
    expect(note).toContain('Qwen3.8 27B Pro MTP');
    expect(note).toContain('2.15 ГБ');
    expect(renderOptionalComponentNote([])).toBe('');
  });
});
