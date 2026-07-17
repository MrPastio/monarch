import { describe, expect, it } from 'vitest';
import {
  advanceSnake,
  directionForKey,
  findFreeBug,
  registerRapidClick,
} from '../../src/ui/public/modules/oscar-snake-game.js';

describe('Oscar snake easter egg', () => {
  it('requires sixteen consecutive rapid clicks and resets after a slow gap', () => {
    let clicks: number[] = [];
    for (let index = 0; index < 15; index += 1) {
      const result = registerRapidClick(clicks, index * 300);
      clicks = result.clicks;
      expect(result.unlocked).toBe(false);
    }

    expect(registerRapidClick(clicks, 15 * 300).unlocked).toBe(true);
    expect(registerRapidClick(clicks, 15 * 300 + 751).clicks).toEqual([15 * 300 + 751]);
  });

  it('maps WASD and arrows without allowing a direct reverse', () => {
    expect(directionForKey('w', 'right')).toBe('up');
    expect(directionForKey('ArrowDown', 'up')).toBe('up');
    expect(directionForKey('a', 'up')).toBe('left');
    expect(directionForKey('x', 'left')).toBe('left');
  });

  it('grows when Oscar catches a bug and detects walls and its own body', () => {
    const snake = [{ x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }];
    const caught = advanceSnake(snake, 'right', { x: 4, y: 3 }, 8);
    expect(caught).toMatchObject({ ate: true, collided: false });
    expect(caught.snake).toHaveLength(4);

    expect(advanceSnake([{ x: 0, y: 0 }], 'left', null, 8).collided).toBe(true);
    expect(advanceSnake(
      [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 1, y: 2 }, { x: 1, y: 1 }],
      'left',
      null,
      8,
    ).collided).toBe(true);
  });

  it('spawns bugs only on free board cells', () => {
    const snake = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    expect(findFreeBug(snake, 2, () => 0)).toEqual({ x: 1, y: 1 });
    expect(findFreeBug([...snake, { x: 1, y: 1 }], 2, () => 0.5)).toBeNull();
  });
});
