import { describe, expect, it } from 'vitest';
import {
  coderAvailableModels, coderChangedFiles, coderChecks, coderEvidenceNote, coderPatchRows, coderRunState, coderSessions, coderSteps,
// @ts-expect-error Browser presentation module is deliberately plain JS.
} from '../../src/ui/public/modules/coder-thread.js';

const root = 'E:\\Work\\demo';
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'coder_run_a', sessionId: 'coder_session_a', projectId: 'p', projectRoot: root, prompt: 'Сделай hello.py',
  status: 'completed', createdAt: '2026-10-02T09:00:00.000Z', updatedAt: '2026-10-02T09:01:00.000Z',
  summary: { tests: [] }, events: [], ...overrides,
});

describe('Coder conversation model', () => {
  it('turns the journal into narrated steps with project-relative targets and receipts', () => {
    const steps = coderSteps(run({ events: [
      { id: 'e1', kind: 'assistant', title: 'План следующего шага', detail: 'Файла нет, создам его.' },
      { id: 'e2', kind: 'tool-start', capabilityId: 'coder.files.write', detail: 'Создаю hello.py.' },
      { id: 'e3', kind: 'tool-result', capabilityId: 'coder.files.write', ok: true, detail: 'ok',
        output: { path: `${root}\\hello.py` } },
      { id: 'e4', kind: 'tool-start', capabilityId: 'coder.command.run', detail: 'Запускаю.' },
      { id: 'e5', kind: 'tool-result', capabilityId: 'coder.command.run', ok: false, error: 'exit 1',
        output: { executable: 'python', args: ['hello.py'], exitCode: 1 } },
      { id: 'e6', kind: 'tool-start', capabilityId: 'coder.files.read', detail: 'Astra V3 dispatched a project-bound Kernel capability.' },
    ] }));
    expect(steps.map((step: { label: string; target: string; state: string }) => [step.label, step.target, step.state])).toEqual([
      ['Записал', 'hello.py', 'done'],
      ['Команда завершилась с ошибкой', 'python hello.py', 'failed'],
      ['Читаю файл', '', 'running'],
    ]);
    expect(steps[0].note).toBe('Создаю hello.py.');
    expect(steps[0].thought).toBe('Файла нет, создам его.');
    expect(steps[1].exitCode).toBe(1);
    expect(steps[2].note).toBe('');
  });

  it('groups runs into conversations, newest first, and marks the ones that need the person', () => {
    const sessions = coderSessions([
      run(),
      run({ id: 'coder_run_b', createdAt: '2026-10-02T09:05:00.000Z', updatedAt: '2026-10-02T09:06:00.000Z',
        prompt: 'Продолжи', agentQuestion: { id: 'q' }, status: 'running' }),
      run({ id: 'coder_run_c', sessionId: undefined, prompt: 'Старая задача', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    expect(sessions.map((session: { id: string }) => session.id)).toEqual(['coder_session_a', 'coder_run_c']);
    expect(sessions[0]).toMatchObject({ title: 'Сделай hello.py', active: true, attention: true });
    expect(sessions[0].runs.map((entry: { id: string }) => entry.id)).toEqual(['coder_run_a', 'coder_run_b']);
  });

  it('never shows a missing or failed check as passed', () => {
    expect(coderChecks(run())).toEqual([]);
    expect(coderChecks(run({ summary: { tests: ['PASS: npm test', 'FAIL: tsc'] } })))
      .toEqual([{ ok: true, command: 'npm test' }, { ok: false, command: 'tsc' }]);
  });

  it('lists only files a receipt shows were changed', () => {
    const changed = coderChangedFiles(run({ events: [
      { id: '1', kind: 'tool-start', capabilityId: 'coder.files.patch' },
      { id: '2', kind: 'tool-result', capabilityId: 'coder.files.patch', ok: true, output: { path: `${root}\\src\\a.ts` } },
      { id: '3', kind: 'tool-start', capabilityId: 'coder.files.write' },
      { id: '4', kind: 'tool-result', capabilityId: 'coder.files.write', ok: false, output: { path: `${root}\\b.ts` } },
      { id: '5', kind: 'tool-start', capabilityId: 'coder.files.read' },
      { id: '6', kind: 'tool-result', capabilityId: 'coder.files.read', ok: true, output: { path: `${root}\\c.ts` } },
    ] }));
    expect(changed).toEqual(['src/a.ts']);
  });

  it('keeps accepted work busy through approvals, questions, Stop and disconnects', () => {
    expect(coderRunState(null, { submitting: true })).toMatchObject({ busy: true, stage: 'starting' });
    expect(coderRunState(run({ status: 'running', agentApproval: { id: 'a' } }))).toMatchObject({ busy: true, stage: 'approval' });
    expect(coderRunState(run({ status: 'running', agentQuestion: { id: 'q' } }))).toMatchObject({ busy: true, stage: 'question' });
    expect(coderRunState(run({ status: 'running', cancelled: true }))).toMatchObject({ busy: true, stage: 'stopping' });
    expect(coderRunState(run({ status: 'running' }), { disconnected: true })).toMatchObject({ busy: true, stage: 'disconnected' });
    expect(coderRunState(run({ status: 'failed' }))).toMatchObject({ busy: false, stage: 'failed' });
  });

  it('offers the host catalog plus the exact selected MAX role, MAX first', () => {
    const role = 'max-cloud:openrouter:SomeOwner/NewModel-v9:free';
    expect(coderAvailableModels({ models: [{ id: 'gemma4-balanced', label: 'Gemma', source: 'local' }], maxConfigured: true },
      { id: 'openrouter', name: 'OpenRouter', state: 'ready', role, model: 'SomeOwner/NewModel-v9:free' }))
      .toEqual([{ id: role, label: 'SomeOwner/NewModel-v9:free', provider: 'OpenRouter', source: 'max' },
        { id: 'gemma4-balanced', label: 'Gemma', source: 'local' }]);
    expect(coderAvailableModels({ models: [], maxConfigured: false }, { state: 'ready', role })).toEqual([]);
    expect(coderAvailableModels({ models: [], maxConfigured: true }, { state: 'failed', role })).toEqual([]);
  });

  it('offers every ready MAX service in the given order, not only the selected one', () => {
    const openai = { id: 'openai', name: 'OpenAI', state: 'ready', role: 'max-cloud:openai:gpt-6-luna', model: 'gpt-6-luna' };
    const openrouter = { id: 'openrouter', name: 'OpenRouter', state: 'ready', role: 'max-cloud:openrouter:stealth/space-bunny-alpha', model: 'stealth/space-bunny-alpha' };
    const broken = { id: 'deepseek', name: 'DeepSeek', state: 'failed', role: 'max-cloud:deepseek:deepseek-chat', model: 'deepseek-chat' };
    expect(coderAvailableModels({ models: [{ id: 'gemma4-balanced', label: 'Gemma', source: 'local' }], maxConfigured: true },
      [openai, broken, openrouter, openai]).map(model => model.id))
      .toEqual(['max-cloud:openai:gpt-6-luna', 'max-cloud:openrouter:stealth/space-bunny-alpha', 'gemma4-balanced']);
  });

  it('reads a unified git patch into numbered diff rows', () => {
    const rows = coderPatchRows([
      'diff --git a/hello.py b/hello.py', 'index 1..2 100644', '--- a/hello.py', '+++ b/hello.py',
      '@@ -1,2 +1,2 @@ def main():', ' print("a")', '-print("b")', '+print("c")',
    ].join('\n'));
    expect(rows).toEqual([
      { type: 'hunk', text: 'def main():' },
      { type: 'same', text: 'print("a")', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'print("b")', oldNo: 2 },
      { type: 'add', text: 'print("c")', newNo: 2 },
    ]);
  });
});

describe('Coder answer backed by what actually happened', () => {
  it('says plainly when a completed answer stands on no action', () => {
    expect(coderEvidenceNote(run({ answer: 'Файл создан.', completionEvidence: 'none' })))
      .toBe('Coder ничего не делал в проекте: это только ответ модели, изменений нет.');
    expect(coderEvidenceNote(run({ completionEvidence: 'failed' }))).toMatch(/не удались/u);
    expect(coderEvidenceNote(run({ completionEvidence: 'mixed' }))).toMatch(/^Часть действий/u);
  });
  it('stays quiet for a backed answer, a running task and an older run without the field', () => {
    expect(coderEvidenceNote(run({ completionEvidence: 'succeeded' }))).toBe('');
    expect(coderEvidenceNote(run({ status: 'running', completionEvidence: 'none' }))).toBe('');
    expect(coderEvidenceNote(run())).toBe('');
  });
});
