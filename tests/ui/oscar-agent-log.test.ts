// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { groupOscarAgentSteps, renderOscarMessage } from '../../src/ui/public/modules/utils.js';

const pending = (steps: unknown[]) => renderOscarMessage({
  id: 'm1', role: 'assistant', content: '', pending: true, streamPhase: 'tool',
  streamEvents: [{ kind: 'agent-tool', label: 'x', activity: { operation: 'read', steps, stepNumber: 4 } }],
});

describe('agent work log', () => {
  it('starts a segment at each new note and keeps the actions under it', () => {
    const segments = groupOscarAgentSteps([
      { title: 'Прочитал файл «a.ts»', state: 'done', note: 'Смотрю, как устроен провайдер.' },
      { title: 'Прочитал файл «b.ts»', state: 'done', note: 'Смотрю, как устроен провайдер.' },
      { title: 'Выполнил команду', state: 'done' },
      { title: 'Правлю файл «a.ts»', state: 'active', note: 'Нашёл причину. Теперь правлю провайдер.', thought: 'Формат зависит от модели.' },
    ]);
    expect(segments.map(segment => [segment.note, segment.steps.length])).toEqual([
      ['Смотрю, как устроен провайдер.', 3],
      ['Нашёл причину. Теперь правлю провайдер.', 1],
    ]);
    expect(segments[1]!.thought).toBe('Формат зависит от модели.');
  });

  it('narrates in the model words, folds many actions into one line and opens only the running reasoning', () => {
    const html = pending([
      { title: 'Прочитал файл «a.ts»', state: 'done', note: 'Смотрю <b>провайдер</b>.', thought: 'Старое рассуждение.' },
      { title: 'Прочитал файл «b.ts»', state: 'done' },
      { title: 'Выполнил команду', state: 'failed' },
      { title: 'Правлю файл «a.ts»', state: 'active', note: 'Нашёл причину.', thought: 'Новое рассуждение.' },
    ]);
    const root = document.createElement('div');
    root.innerHTML = html;
    const notes = [...root.querySelectorAll('.oscar-agent-note')].map(node => node.textContent);
    expect(notes).toEqual(['Смотрю <b>провайдер</b>.', 'Нашёл причину.']);
    const group = root.querySelector('.oscar-agent-action-group')!;
    expect(group.querySelector('summary')!.textContent).toContain('и ещё 2 · не получилось 1');
    expect(group.querySelectorAll('.oscar-agent-action-group__list .oscar-agent-action')).toHaveLength(3);
    const thoughts = [...root.querySelectorAll<HTMLDetailsElement>('.oscar-agent-thought')];
    expect(thoughts.map(node => node.open)).toEqual([false, true]);
    expect(root.querySelector('[aria-current="step"]')!.textContent).toContain('Правлю файл «a.ts»');
    expect(root.querySelector('.oscar-agent-log__foot')!.textContent).toContain('шаг 4');
  });

  it('shows no reasoning block when the model gave none (local models)', () => {
    const root = document.createElement('div');
    root.innerHTML = pending([{ title: 'Смотрю папку', state: 'active', note: 'Ищу, где лежит проект.' }]);
    expect(root.querySelector('.oscar-agent-thought')).toBeNull();
    expect(root.querySelector('.oscar-agent-note')!.textContent).toBe('Ищу, где лежит проект.');
  });
});
