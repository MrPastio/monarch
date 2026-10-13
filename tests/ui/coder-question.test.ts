import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/ui/public/modules/coder-pane.js', 'utf8');

describe('Coder question without an extra click', () => {
  it('answers a pending question from the composer instead of refusing a second task', () => {
    const send = source.slice(source.indexOf('async function send()'), source.indexOf('async function stop('));
    const asking = send.indexOf('const asking = pendingQuestionRun();');
    expect(asking).toBeGreaterThan(-1);
    expect(asking).toBeLessThan(send.indexOf("setBanner('В проекте уже идёт задача."));
    expect(send).toContain('await answerQuestion(asking.id, ui.input.value)');
    expect(source).toContain("asking ? 'Ответь на вопрос Coder'");
    expect(source).toContain('ui.send.hidden = Boolean(active) && !asking;');
  });

  it('sends the card answer with Enter and keeps Shift+Enter for a new line', () => {
    expect(source).toMatch(/closest\?\.\('\[data-question-run\]'\)[\s\S]{0,200}event\.key === 'Enter' && !event\.shiftKey && !event\.isComposing\) \{ event\.preventDefault\(\); form\.requestSubmit\(\); \}/u);
  });

  it('keeps focus and caret in the answer across re-renders and focuses a new question once', () => {
    const render = source.slice(source.indexOf('function renderThread('), source.indexOf('function emptyState('));
    expect(render).toContain('restored.setSelectionRange(focused.start, focused.end)');
    expect(render).toContain('questionKey !== state.focusedQuestion');
    // Never steals focus from a field the person is typing in.
    expect(render).toContain('if (!typing && target && !target.disabled && !ui.root.hidden) target.focus({ preventScroll: true });');
  });
});
