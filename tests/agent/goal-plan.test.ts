import { describe, expect, it } from 'vitest';
import {
  inferAgentBlockingInput,
  isNonExecutingMutationDiscussion,
  normalizeAgentGoal,
} from '../../src/agent/goal-normalizer';
import { createInitialAgentPlan, reviseAgentPlan } from '../../src/agent/plan-manager';

describe('agent goal and plan management', () => {
  it('keeps the original request and adds bounded verification defaults', () => {
    const goal = normalizeAgentGoal({ request: '  Build   a report  ' });
    expect(goal.originalRequest).toBe('Build a report');
    expect(goal.expectedOutputs).toHaveLength(1);
    expect(goal.expectedOutputs[0]?.description).toContain('Build a report');
    expect(goal.successCriteria).toHaveLength(1);
  });

  it('makes an inferred local effect a required part of every operational goal contract', () => {
    const fileGoal = normalizeAgentGoal({
      request: 'создай на рабочем столе текстовый файл с именем ромашка',
    });
    expect(fileGoal.expectedOutputs).toEqual([
      expect.objectContaining({ kind: 'artifact', required: true }),
    ]);

    const launchGoal = normalizeAgentGoal({
      request: 'запусти калькулятор',
      expectedOutputs: [{
        id: 'legacy_generic_answer',
        kind: 'answer',
        description: 'Return a verified answer.',
      }],
    });
    expect(launchGoal.expectedOutputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy_generic_answer', kind: 'answer' }),
      expect.objectContaining({ id: 'requested_state_change_effect', kind: 'state-change', required: true }),
    ]));

    for (const request of [
      'поставь громкость на 20%',
      'закрой браузер',
      'сделай скриншот',
      'создай папку на рабочем столе тест',
      'Update the file shown in the screenshot.',
    ]) {
      expect(normalizeAgentGoal({ request }).expectedOutputs).toContainEqual(
        expect.objectContaining({ kind: 'state-change', required: true }),
      );
    }
  });

  it('does not turn negated or explanatory mentions into a mutation goal', () => {
    for (const request of [
      'Do not create runtime/negated.txt.',
      'Explain how to create runtime/example.txt.',
      'Не удаляй этот файл.',
      'Расскажи, как открыть Telegram.',
    ]) {
      expect(isNonExecutingMutationDiscussion(request)).toBe(true);
      expect(normalizeAgentGoal({ request }).expectedOutputs.every((output) => (
        output.kind !== 'artifact' && output.kind !== 'state-change'
      ))).toBe(true);
    }
  });

  it('marks explicitly missing mutation content as a blocking input without inventing bytes', () => {
    expect(inferAgentBlockingInput(
      'Создай E:\\Agent-QA\\missing.txt и заполни его текстом, но сам текст я не указал.',
    )).toMatchObject({ kind: 'exact-content' });
    expect(inferAgentBlockingInput(
      'Create E:\\Agent-QA\\missing.txt with content that was not specified.',
    )).toMatchObject({ kind: 'exact-content' });
    expect(inferAgentBlockingInput(
      'Создай E:\\Agent-QA\\report.txt и напиши краткий отчёт о текущей задаче.',
    )).toBeNull();
  });

  it('preserves settled history when the model revises upcoming steps', () => {
    const plan = createInitialAgentPlan('Build report', '2026-01-01T00:00:00.000Z');
    const revised = reviseAgentPlan(plan, {
      kind: 'revise-plan', summary: 'Inspect then write', reason: 'Need evidence',
      steps: [
        { title: 'Inspect inputs', expectedEffect: 'Inputs understood' },
        { title: 'Write report', expectedEffect: 'Report exists' },
      ],
    }, '2026-01-01T00:01:00.000Z');
    expect(revised.revision).toBe(2);
    expect(revised.steps[0]?.status).toBe('skipped');
    expect(revised.steps.slice(-2).map((step) => step.status)).toEqual(['ready', 'proposed']);
  });
});
