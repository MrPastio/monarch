// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { syncThreadDOM } from '../../src/ui/public/modules/utils.js';

const frame = (label: string) => `<div class="oscar-message assistant pending" data-message-id="m1"><span class="monarch-thinking-orb" data-orb-phase="write"><span class="monarch-thinking-orb__core"></span></span> ${label}</div>`;

describe('thread DOM sync', () => {
  it('keeps a design-layer decoration mounted into rendered markup across stream frames', () => {
    const thread = document.createElement('div');
    syncThreadDOM(thread, frame('Думает'));
    const orb = thread.querySelector('.monarch-thinking-orb')!;
    const loader = document.createElement('span');
    loader.className = 'pp-loader';
    loader.setAttribute('data-dom-decoration', '');
    orb.append(loader);

    syncThreadDOM(thread, frame('Ищет'));
    syncThreadDOM(thread, frame('Готовит ответ'));

    expect(thread.querySelector('.monarch-thinking-orb')).toBe(orb);
    expect(orb.querySelector(':scope > .pp-loader')).toBe(loader);
    expect(thread.textContent?.trim()).toBe('Готовит ответ');
  });

  it('still removes stale undecorated children', () => {
    const thread = document.createElement('div');
    syncThreadDOM(thread, frame('Думает'));
    thread.querySelector('.monarch-thinking-orb')!.append(document.createElement('i'));
    syncThreadDOM(thread, frame('Ищет'));
    expect(thread.querySelector('.monarch-thinking-orb i')).toBeNull();
  });
});
