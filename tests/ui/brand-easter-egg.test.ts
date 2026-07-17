import { describe, expect, it } from 'vitest';
import {
  advanceMonarchBrandClick,
  MONARCH_BRAND_CLICKS_PER_STAGE,
  MONARCH_BRAND_STAGES,
} from '../../src/ui/public/modules/brand-easter-egg.js';

describe('Monarch brand easter egg', () => {
  it('changes the name only on each fifth click', () => {
    let state = { stageIndex: 0, clickCount: 0 };
    for (let click = 1; click < MONARCH_BRAND_CLICKS_PER_STAGE; click += 1) {
      state = advanceMonarchBrandClick(state);
      expect(state).toMatchObject({ stageIndex: 0, clickCount: click, changed: false });
    }

    expect(advanceMonarchBrandClick(state)).toEqual({ stageIndex: 1, clickCount: 0, changed: true });
  });

  it('cycles through every requested label and returns to Monarch after 35 clicks', () => {
    let state = { stageIndex: 0, clickCount: 0 };
    const changedLabels: string[] = [];
    for (let click = 0; click < MONARCH_BRAND_STAGES.length * MONARCH_BRAND_CLICKS_PER_STAGE; click += 1) {
      state = advanceMonarchBrandClick(state);
      if (state.changed) changedLabels.push(MONARCH_BRAND_STAGES[state.stageIndex]);
    }

    expect(changedLabels).toEqual(['Mark', 'F1 Core', 'Astra', 'Зачем?', 'Уже все', 'Хватит', 'Monarch']);
    expect(state).toMatchObject({ stageIndex: 0, clickCount: 0 });
  });
});
