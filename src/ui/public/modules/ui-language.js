// Presentation only: never modify receipts, model output, paths or permissions.
export function plainActivity(phase = '', operation = '') {
  const key = `${phase} ${operation}`.toLowerCase().replaceAll('research-', '');
  if (/error|failed|blocked/.test(key)) return 'Нужно внимание';
  if (/cancel|stop/.test(key)) return 'Останавливается';
  if (/approval|permission|confirm/.test(key)) return 'Ждёт разрешения';
  if (/input-required|waiting-for-user/.test(key)) return 'Ждёт твоего ответа';
  // Agent step operations (the runtime's live step, not a model reply).
  const step = String(operation || '').toLowerCase();
  if (step === 'think') return 'Думает';
  if (step === 'write') return 'Записывает';
  if (step === 'execute') return 'Выполняет команду';
  if (step === 'act') return 'Работает';
  if (/search/.test(key)) return 'Ищет';
  if (/read|inspect/.test(key)) return 'Изучает';
  if (/verify|reflect|check/.test(key)) return 'Проверяет';
  if (/copy/.test(key)) return 'Копирует';
  if (/move/.test(key)) return 'Перемещает';
  if (/delete|trash/.test(key)) return 'Удаляет';
  if (/create|draft/.test(key)) return 'Готовит документ';
  if (/open/.test(key)) return 'Открывает';
  if (/control|click|scroll|type|key/.test(key)) return 'Работает';
  if (/answer|write|synthesize|finalize|revise/.test(key)) return 'Готовит ответ';
  if (/execute|running|task|tool|act/.test(key)) return 'Работает';
  return 'Думает';
}

export function containsTechnicalCopy(value) {
  return /\b(?:runtime|kernel|backend|endpoint|sha-?256|turn coordinator|agent runtime|inference|token|tokens)\b|токен|инференс/iu.test(String(value || ''));
}
