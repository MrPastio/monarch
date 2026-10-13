// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readOscarTaskReport, renderOscarTaskReport } from '../../src/ui/public/modules/oscar-task-report.js';
import { escapeHtml, syncThreadDOM } from '../../src/ui/public/modules/utils.js';

describe('finished task report', () => {
  it('reads the last terminal projection and drops unknown states', () => {
    const report = readOscarTaskReport([
      { type: 'agent.progress', payload: { taskReport: [{ title: 'old', state: 'done' }] } },
      { type: 'agent.progress', payload: { taskReport: [{ title: 'Создал файл', state: 'done' }, { title: 'x', state: 'hacked' }] } },
    ]);
    expect(report).toEqual([{ title: 'Создал файл', state: 'done' }]);
  });

  it('renders a collapsed summary with counts per outcome', () => {
    const html = renderOscarTaskReport([
      { title: 'Создал файл', state: 'done' },
      { title: 'Ты разрешил: Удалить файлы', state: 'approved' },
      { title: 'Не удалось записать', state: 'denied' },
    ], escapeHtml);
    expect(html).toContain('<details class="oscar-task-report">');
    expect(html).toContain('сделано 1 · разрешил ты 1 · запрещено 1');
    expect(html).not.toContain('Ты разрешил: Удалить');
    expect(renderOscarTaskReport([], escapeHtml)).toBe('');
  });

  it('keeps a details block the person opened across thread re-renders', () => {
    const thread = document.createElement('div');
    const markup = '<div><details class="oscar-task-report"><summary>Итог</summary><ol><li>a</li></ol></details></div>';
    syncThreadDOM(thread, markup);
    const details = thread.querySelector('details')!;
    details.open = true;
    syncThreadDOM(thread, markup);
    expect(thread.querySelector('details')!.open).toBe(true);
  });

  it('still applies a markup change of intent, like reasoning closing after the answer', () => {
    const thread = document.createElement('div');
    syncThreadDOM(thread, '<div><details open><summary>r</summary></details></div>');
    syncThreadDOM(thread, '<div><details><summary>r</summary></details></div>');
    expect(thread.querySelector('details')!.open).toBe(false);
  });
});
