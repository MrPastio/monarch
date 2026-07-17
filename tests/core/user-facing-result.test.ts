import { describe, expect, it } from 'vitest';
import {
  createUserFacingFailure,
  withUserFacingExecutionResult,
  withUserFacingIntentResult,
} from '../../src/core';

describe('user-facing execution failures', () => {
  it('keeps diagnostics internal while exposing a stable safe message', () => {
    const result = withUserFacingExecutionResult({
      ok: false,
      error: 'capability-execution-failed',
      summary: 'Traceback: secret path C:\\Users\\anton\\token.txt',
    });

    expect(result.summary).toContain('Traceback');
    expect(result.userFacing).toEqual({
      code: 'capability-execution-failed',
      message: 'Monarch столкнулся с внутренней ошибкой. Подробности сохранены в локальном журнале.',
    });
  });

  it('extracts only validation field names instead of raw validator output', () => {
    const failure = createUserFacingFailure({
      ok: false,
      error: 'invalid-input',
      summary: 'input.path contains C:\\private',
      metadata: {
        validation: {
          errors: ['input.path must be a string', 'input.content is required'],
        },
      },
    });

    expect(failure.fields).toEqual(['path', 'content']);
    expect(failure.message).not.toContain('C:\\private');
  });

  it('does not mislabel an Oscar chat contract mismatch as a missing object or path', () => {
    const failure = createUserFacingFailure({
      ok: false,
      error: 'invalid-input',
      summary: 'Invalid input for oscar.chat.stream: input.research_mode is not allowed',
    });

    expect(failure.message).toContain('текст запроса менять не нужно');
    expect(failure.message).not.toContain('объект или путь');
  });

  it('replaces resolver diagnostics in clarification summaries', () => {
    const result = withUserFacingIntentResult({
      ok: false,
      intentId: 'intent-1',
      status: 'failed',
      summary: 'TODO Top candidate resolver missing required input',
      execution: {
        ok: false,
        error: 'clarification-required',
        summary: 'TODO Top candidate resolver missing required input',
      },
    });

    expect(result.summary).toBe('Нужно короткое уточнение перед выполнением действия.');
    expect(result.execution?.userFacing?.code).toBe('clarification-required');
  });
});
