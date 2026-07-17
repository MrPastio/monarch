import { classifyVoiceModeCommand, type VoiceModeActionId } from './voice-mode';

export interface VoiceScriptedResult {
  text: string;
  actionId: VoiceModeActionId;
  lane: 'scripted';
  model: 'none';
  performed: boolean;
  status: 'completed' | 'clarification' | 'unsupported';
}

export class VoiceScriptedError extends Error {
  readonly code: string;
  readonly actionId: VoiceModeActionId | undefined;

  constructor(code: string, message: string, actionId?: VoiceModeActionId) {
    super(message);
    this.name = 'VoiceScriptedError';
    this.code = code;
    this.actionId = actionId;
  }
}

/** Reclassifies raw text server-side and executes only model-free handlers. */
export function executeVoiceModeScripted(
  text: string,
  now: Date = new Date(Date.now()),
  timeZone: string | undefined = resolveSystemTimeZone(),
): VoiceScriptedResult {
  const candidate = classifyVoiceModeCommand(typeof text === 'string' ? text : '');
  if (candidate.lane !== 'scripted' || candidate.usesLlm || candidate.modelRoute !== 'none') {
    throw new VoiceScriptedError(
      'voice-scripted-route-rejected',
      'Voice request is not eligible for the deterministic scripted lane.',
      candidate.actionId,
    );
  }

  switch (candidate.actionId) {
  case 'listen.continue':
    return scriptedResult(candidate.slots.acknowledgement || 'Слушаю.', candidate.actionId);
  case 'math.calculate': {
    const value = Number(candidate.slots.result);
    if (!Number.isFinite(value)) {
      throw new VoiceScriptedError(
        'voice-scripted-handler-unavailable',
        'Не удалось безопасно вычислить выражение.',
        candidate.actionId,
      );
    }
    return scriptedResult(`Получается ${formatLocalNumber(value)}.`, candidate.actionId);
  }
  case 'time.query':
    return scriptedResult(`Сейчас ${formatLocalTime(now, timeZone)}.`, candidate.actionId);
  case 'weather.query':
    return scriptedResult('Для какого города показать погоду?', candidate.actionId, 'clarification');
  case 'web.search':
    return scriptedResult('Что именно найти в интернете?', candidate.actionId, 'clarification');
  case 'workspace.create':
    return scriptedResult('Создание файлов голосом пока не подключено. Скажи имя файла в текстовом чате.', candidate.actionId, 'unsupported');
  case 'workspace.delete':
    return scriptedResult('Удаление файлов голосом пока не подключено. Выполни эту команду в текстовом чате с подтверждением.', candidate.actionId, 'unsupported');
  case 'device.volume':
    return scriptedResult('Управление громкостью доступно только через системный Windows-исполнитель.', candidate.actionId, 'unsupported');
  case 'device.volume.status':
    return scriptedResult('Проверка громкости доступна только через системный Windows-исполнитель.', candidate.actionId, 'unsupported');
  case 'device.volume.clarification':
    return scriptedResult(
      'Не понял точный уровень громкости. Скажи полностью, например: «установи громкость на 50 процентов».',
      candidate.actionId,
      'clarification',
    );
  case 'device.brightness':
    return scriptedResult('Управление яркостью доступно только через системный Windows-исполнитель.', candidate.actionId, 'unsupported');
  case 'device.brightness.status':
    return scriptedResult('Проверка яркости доступна только через системный Windows-исполнитель.', candidate.actionId, 'unsupported');
  case 'device.brightness.clarification':
    return scriptedResult(
      'Не понял точную яркость. Скажи полностью, например: «установи яркость на 50 процентов».',
      candidate.actionId,
      'clarification',
    );
  case 'device.control.unsupported':
    return scriptedResult('Эта системная команда голосом пока не подключена. Я ничего не менял.', candidate.actionId, 'unsupported');
  case 'device.app.open':
    return scriptedResult('Запуск приложения требует системный Device-исполнитель. Я ничего не открывал.', candidate.actionId, 'unsupported');
  case 'device.browser.open':
    return scriptedResult('Открытие браузера требует системный Device-исполнитель. Я ничего не открывал.', candidate.actionId, 'unsupported');
  case 'device.media.open':
    return scriptedResult('Открытие медиа голосом пока не подключено. Я ничего не открывал.', candidate.actionId, 'unsupported');
  default:
    throw new VoiceScriptedError(
      'voice-scripted-route-rejected',
      'Voice request is not eligible for the deterministic scripted lane.',
      candidate.actionId,
    );
  }
}

function scriptedResult(
  text: string,
  actionId: VoiceModeActionId,
  status: VoiceScriptedResult['status'] = 'completed',
): VoiceScriptedResult {
  return {
    text,
    actionId,
    lane: 'scripted',
    model: 'none',
    performed: status === 'completed',
    status,
  };
}

export function formatLocalTime(now: Date, timeZone: string | undefined = resolveSystemTimeZone()): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
}

/** Node/ICU maps the active Windows zone (for example FLE Standard Time) to IANA. */
export function resolveSystemTimeZone(): string | undefined {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof timeZone === 'string' && timeZone.trim() ? timeZone : undefined;
}

function formatLocalNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 8,
  }).format(value);
}
