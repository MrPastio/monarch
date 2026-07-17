import type {
  MonarchExecutionResult,
  MonarchIntentResult,
  MonarchUserFacingFailure,
} from './contracts';

export function withUserFacingExecutionResult(
  result: MonarchExecutionResult
): MonarchExecutionResult {
  if (result.ok || result.userFacing) {
    return result;
  }
  return {
    ...result,
    userFacing: createUserFacingFailure(result),
  };
}

export function withUserFacingIntentResult(
  result: MonarchIntentResult
): MonarchIntentResult {
  if (!result.execution) {
    return result;
  }
  const execution = withUserFacingExecutionResult(result.execution);
  return execution === result.execution ? result : {
    ...result,
    execution,
    summary: execution.userFacing?.message || result.summary,
  };
}

export function createUserFacingFailure(
  result: MonarchExecutionResult
): MonarchUserFacingFailure {
  const code = normalizeFailureCode(result.error);
  const fields = readValidationFields(result);
  const failure: MonarchUserFacingFailure = {
    code,
    message: userFacingMessage(code, result.summary),
  };
  if (fields.length > 0) {
    failure.fields = fields;
  }
  return failure;
}

function userFacingMessage(code: string, summary: string): string {
  switch (code) {
  case 'clarification-required':
    return isSafeClarification(summary)
      ? summary.trim()
      : 'Нужно короткое уточнение перед выполнением действия.';
  case 'confirmation-required':
    return 'Нужно твоё разовое подтверждение перед выполнением этого действия.';
  case 'permission-denied':
    return 'Monarch не разрешил это действие в текущем режиме доступа.';
  case 'invalid-input':
    if (/\boscar\.chat\.(?:local|stream|route)\b/i.test(summary)) {
      return 'Oscar получил несовместимый формат запроса. Перезапусти локальный runtime Oscar и повтори — текст запроса менять не нужно.';
    }
    return 'Не удалось проверить параметры действия. Уточни объект или путь.';
  case 'file-not-found':
  case 'source-not-found':
  case 'not-found':
    return 'Файл или папка не найдены.';
  case 'file-exists':
  case 'target-exists':
    return 'Целевой файл или папка уже существуют.';
  case 'filesystem-policy-blocked':
  case 'protected-path':
  case 'protected-child-path':
  case 'outside-workspace':
  case 'read-only-local-root':
    return 'Доступ к этому пути заблокирован политикой файловой системы Monarch.';
  case 'oscar-backend-unavailable':
    return 'Локальный backend Oscar сейчас недоступен. Проверь его статус и повтори запрос.';
  case 'capability-execution-failed':
  case 'internal-error':
    return 'Monarch столкнулся с внутренней ошибкой. Подробности сохранены в локальном журнале.';
  default:
    if (code.startsWith('missing-') || code.endsWith('-incomplete')) {
      return 'Нужно уточнить недостающие параметры действия.';
    }
    if (code.startsWith('unsupported-') || code === 'capability-not-found' || code === 'module-not-found') {
      return 'Это действие сейчас не поддерживается текущей конфигурацией Monarch.';
    }
    return 'Не удалось выполнить действие. Подробности сохранены в локальном журнале.';
  }
}

function readValidationFields(result: MonarchExecutionResult): string[] {
  const validation = result.metadata?.validation;
  if (!validation || typeof validation !== 'object') {
    return [];
  }
  const errors = (validation as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  const fields = errors.flatMap((error) => {
    const match = typeof error === 'string' ? error.match(/\binput\.([A-Za-z0-9_]+)/) : null;
    return match?.[1] ? [match[1]] : [];
  });
  return Array.from(new Set(fields)).slice(0, 8);
}

function normalizeFailureCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : 'internal-error';
}

function isSafeClarification(summary: string): boolean {
  const value = String(summary || '').trim();
  return /^Нужно уточнение\b/i.test(value)
    && !/(?:TODO|Top candidate|stack|traceback|resolver|missing required input)/i.test(value);
}
