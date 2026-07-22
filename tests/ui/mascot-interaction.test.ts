import { describe, expect, it } from 'vitest';
import {
  clampMascotLayout,
  createDefaultMascotLayout,
  hasSentOscarMessage,
} from '../../src/ui/public/modules/mascot-controller.js';

describe('Oscar mascot interaction layout', () => {
  it('starts as a mini companion above the lower-right composer area', () => {
    const layout = createDefaultMascotLayout({ width: 1920, height: 960 });
    expect(layout.x).toBeGreaterThan(1700);
    expect(layout.y).toBeLessThan(720);
    expect(layout.size).toBe(104);
  });

  it('keeps dragged and resized mascot geometry inside the viewport', () => {
    expect(clampMascotLayout(
      { x: 990, y: -80, size: 500 },
      { width: 800, height: 600 },
    )).toEqual({ x: 472, y: 8, size: 320 });
  });

  it('uses a compact lower-right starting point on mobile', () => {
    expect(createDefaultMascotLayout({ width: 390, height: 844 })).toMatchObject({
      x: 284,
      size: 88,
    });
  });

  it('activates the mini-mascot only after a user message exists', () => {
    expect(hasSentOscarMessage([])).toBe(false);
    expect(hasSentOscarMessage([{ role: 'assistant', content: 'Привет' }])).toBe(false);
    expect(hasSentOscarMessage([{ role: 'user', content: 'Привет' }])).toBe(true);
  });
});
