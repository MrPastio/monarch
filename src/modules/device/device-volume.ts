import { spawn } from 'node:child_process';
import path from 'node:path';

const VOLUME_TIMEOUT_MS = 8_000;

export type VoiceVolumeAction =
  | { action: 'get' }
  | { action: 'set'; value: number }
  | { action: 'change'; delta: number }
  | { action: 'mute' }
  | { action: 'unmute' };

export type VoiceVolumeIntentKind = 'none' | 'action' | 'status' | 'clarification';

export interface VoiceVolumeIntent {
  kind: VoiceVolumeIntentKind;
  normalizedText: string;
  action?: VoiceVolumeAction;
  slots: Record<string, string>;
}

export interface VoiceVolumeState {
  ok: true;
  action: VoiceVolumeAction['action'];
  before: number;
  beforeMuted: boolean;
  level: number;
  muted: boolean;
}

export interface VoiceVolumeResult {
  text: string;
  actionId: 'device.volume' | 'device.volume.status';
  lane: 'scripted';
  model: 'none';
  performed: true;
  status: 'completed';
  verified: true;
  level: number;
  muted: boolean;
}

export function isVoiceVolumeStatusQuery(value: string): boolean {
  return classifyVoiceVolumeIntent(value).kind === 'status';
}

export class VoiceVolumeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'VoiceVolumeError';
    this.code = code;
  }
}

export function parseVoiceVolumeAction(value: string): VoiceVolumeAction | null {
  return classifyVoiceVolumeIntent(value).action ?? null;
}

/**
 * Extracts a volume-domain intent before model routing. Mutating actions are
 * returned only when both the operation and its required slots are explicit;
 * incomplete volume commands fail into a model-free clarification.
 */
export function classifyVoiceVolumeIntent(value: string): VoiceVolumeIntent {
  const source = String(value || '');
  const text = normalizeVolumeText(source);
  if (!text) return volumeIntent('none', text);

  const namedDomain = /(?:^|\s)(?:громкост\p{L}*|звук\p{L}*|volume)(?=\s|$)/u.test(text);
  const relativeWord = /(?:^|\s)(?:громче|тише|louder|quieter)(?=\s|$)/u.test(text);
  const speechDirection = /(?:^|\s)(?:говори|скажи|читай|произнеси|speak|read)(?=\s|$)/u.test(text);
  const implicitRelativeDomain = relativeWord && !speechDirection;
  if (!namedDomain && !implicitRelativeDomain) return volumeIntent('none', text);

  const hasSetVerb = /(?:^|\s)(?:поставь|поставьте|поставить|установи|установите|установить|сделай|сделайте|сделать|выставь|выставьте|выставить|задай|задайте|задать|измени|измените|изменить|верни|верните|вернуть|set)(?=\s|$)/u.test(text);
  const raises = /(?:^|\s)(?:увеличь|увеличьте|увеличить|повысь|повысьте|повысить|подними|поднимите|поднять|добавь|добавьте|добавить|громче|raise|increase|louder)(?=\s|$)/u.test(text);
  const lowers = /(?:^|\s)(?:уменьши|уменьшите|уменьшить|понизь|понизьте|понизить|опусти|опустите|опустить|убавь|убавьте|убавить|тише|lower|decrease|quieter)(?=\s|$)/u.test(text);
  const unmutes = /(?:^|\s)(?:включи|включите|включить|разблокируй|разблокируйте|разблокировать|unmute)(?=\s|$)/u.test(text);
  const mutes = /(?:^|\s)(?:выключи|выключите|выключить|отключи|отключите|отключить|убери|уберите|убрать|mute)(?=\s|$)/u.test(text)
    || /(?:^|\s)без\s+звука(?=\s|$)/u.test(text);
  const hasCommand = hasSetVerb || raises || lowers || unmutes || mutes;
  const looksInformational = /(?:^|\s)(?:почему|зачем|как\s+работает|что\s+такое|от\s+чего|влияет)(?=\s|$)/u.test(text);
  const nonActionContext = /(?:^|\s)(?:сколько\s+врем\p{L}*|что\s+будет\s+если|стоит\s+ли|надо\s+ли|как\s+(?:поставить|установить|изменить|увеличить|уменьшить|включить|выключить))(?=\s|$)/u.test(text);
  const commandNegated = /(?:^|\s)не(?:\s+надо|\s+нужно)?\s+(?:поставь|установи|сделай|выставь|задай|измени|верни|увеличь|повысь|подними|добавь|уменьши|понизь|опусти|убавь|включи|выключи|отключи|убери|разблокируй|set|raise|lower|increase|decrease|mute|unmute)(?=\s|$)/u.test(text);
  if (looksInformational || nonActionContext) return volumeIntent('none', text);
  if (commandNegated) {
    return volumeIntent('clarification', text, undefined, {
      intent: 'clarification',
      missing: 'affirmative-command',
    });
  }
  const looksLikeStatus = !looksInformational && (
    /(?:^|\s)(?:у\s+меня|сейчас|какая|какой|сколько|покажи|показать|скажи|узнай|узнать|проверь|проверить|стоит|установлена|установлен|выставлена|выставлен)(?=\s|$)/u.test(text)
    || /^(?:громкост\p{L}*|звук\p{L}*|volume)$/u.test(text)
    || (/[?？]/u.test(source) && !/(?:^|\s)(?:почему|зачем|как|что\s+такое)(?=\s|$)/u.test(text))
  );

  // Only this bounded, high-confidence context may repair number homophones
  // produced by local STT (for example Russian "сто" -> "стол").
  const normalizedText = namedDomain && hasSetVerb
    ? normalizeVolumeNumericHomophones(text)
    : text;
  const amount = readRussianPercentage(normalizedText);
  const maximum = /(?:^|\s)(?:максимум|максимальной|максимальную|полную|сто\s+процентов)(?=\s|$)/u.test(normalizedText);
  const minimum = /(?:^|\s)(?:минимум|минимальной|минимальную|нулевую|ноль\s+процентов)(?=\s|$)/u.test(normalizedText);
  const corrected = normalizedText !== text ? 'numeric-homophone' : undefined;
  const ellipticalSet = !hasCommand && !looksLikeStatus && (
    /^(?:громкост\p{L}*|звук\p{L}*|volume)\s+на\s+(?:100|[1-9]?\d|максимум|минимум|полную|нулевую)(?:\s*(?:%|процент\p{L}*))?$/u.test(normalizedText)
    || /^(?:громкост\p{L}*|звук\p{L}*|volume)\s+на\s+(?:ноль|сто)(?:\s+процент\p{L}*)?$/u.test(normalizedText)
  );

  if ((raises || lowers) && !(raises && lowers)) {
    const delta = (amount ?? 10) * (raises ? 1 : -1);
    return volumeIntent('action', normalizedText, { action: 'change', delta }, {
      operation: 'change',
      delta: String(delta),
    });
  }

  if ((hasSetVerb || ellipticalSet) && (maximum || minimum || amount !== null)) {
    const value = maximum ? 100 : minimum ? 0 : amount!;
    return volumeIntent('action', normalizedText, { action: 'set', value }, {
      operation: 'set',
      value: String(value),
      ...(corrected ? { sttNormalization: corrected } : {}),
    });
  }

  // Combining mute/unmute with an absolute level is not a single unambiguous
  // operation in the Windows capability, so ask instead of choosing silently.
  if ((mutes || unmutes) && !(mutes && unmutes) && amount === null && !maximum && !minimum) {
    const action = mutes ? 'mute' : 'unmute';
    return volumeIntent('action', normalizedText, { action }, { operation: action });
  }

  if (!hasCommand && looksLikeStatus) {
    return volumeIntent('status', normalizedText, undefined, { operation: 'get' });
  }

  if (hasCommand || amount !== null || maximum || minimum) {
    return volumeIntent('clarification', normalizedText, undefined, {
      intent: 'clarification',
      missing: hasCommand ? 'operation-or-level' : 'command',
    });
  }

  return volumeIntent('none', normalizedText);
}

function normalizeVolumeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVolumeNumericHomophones(text: string): string {
  return text
    .replace(/(^|\s)на\s+стол(?:\s+процент\p{L}*)?(?:\s+пожалуйста)?$/u, '$1на сто процентов')
    .replace(/(^|\s)на\s+нол(?:\s+процент\p{L}*)?(?:\s+пожалуйста)?$/u, '$1на ноль процентов');
}

function volumeIntent(
  kind: VoiceVolumeIntentKind,
  normalizedText: string,
  action?: VoiceVolumeAction,
  slots: Record<string, string> = {},
): VoiceVolumeIntent {
  return {
    kind,
    normalizedText,
    ...(action ? { action } : {}),
    slots: kind === 'none' ? slots : { domain: 'volume', ...slots },
  };
}

export async function executeVoiceVolumeAction(
  value: string,
  run: (action: VoiceVolumeAction) => Promise<VoiceVolumeState> = runWindowsVolumeAction,
): Promise<VoiceVolumeResult> {
  const action = parseVoiceVolumeAction(value);
  if (!action) {
    throw new VoiceVolumeError(
      'voice-volume-command-ambiguous',
      'Не понял точный уровень. Скажи, например: «громкость на 50 процентов», «громче» или «выключи звук».',
    );
  }

  return executeSystemVolumeAction(action, run);
}

export async function executeSystemVolumeAction(
  action: VoiceVolumeAction,
  run: (action: VoiceVolumeAction) => Promise<VoiceVolumeState> = runWindowsVolumeAction,
): Promise<VoiceVolumeResult> {

  const state = await run(action);
  assertVerifiedVolumeAction(action, state);
  return {
    text: state.muted
      ? 'Звук выключен.'
      : action.action === 'unmute'
        ? `Звук включен, громкость ${state.level}%.`
        : `Громкость установлена на ${state.level}%.`,
    actionId: 'device.volume',
    lane: 'scripted',
    model: 'none',
    performed: true,
    status: 'completed',
    verified: true,
    level: state.level,
    muted: state.muted,
  };
}

export async function executeVoiceVolumeStatus(
  run: (action: VoiceVolumeAction) => Promise<VoiceVolumeState> = runWindowsVolumeAction,
): Promise<VoiceVolumeResult> {
  const state = await run({ action: 'get' });
  assertVerifiedVolumeAction({ action: 'get' }, state);
  return {
    text: state.muted
      ? `Звук выключен. Уровень громкости ${state.level}%.`
      : `Сейчас громкость ${state.level}%.`,
    actionId: 'device.volume.status',
    lane: 'scripted',
    model: 'none',
    performed: true,
    status: 'completed',
    verified: true,
    level: state.level,
    muted: state.muted,
  };
}

export async function runWindowsVolumeAction(action: VoiceVolumeAction): Promise<VoiceVolumeState> {
  if (process.platform !== 'win32') {
    throw new VoiceVolumeError('voice-volume-platform-unsupported', 'Изменение системной громкости доступно только в Monarch Desktop для Windows.');
  }
  const scriptPath = path.join(process.cwd(), 'tools', 'local-windows-volume.ps1');
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (error?: VoiceVolumeError, state?: VoiceVolumeState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(state!);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish(new VoiceVolumeError('voice-volume-timeout', 'Windows не подтвердил изменение громкости вовремя.'));
    }, VOLUME_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, 8_000); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, 8_000); });
    child.once('error', (error) => finish(new VoiceVolumeError('voice-volume-worker-failed', error.message)));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new VoiceVolumeError(
          'voice-volume-worker-failed',
          `Windows не смог изменить громкость: ${stderr.trim() || `exit ${code}`}`.slice(0, 500),
        ));
        return;
      }
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
        const parsed = JSON.parse(line) as Partial<VoiceVolumeState>;
        if (parsed.ok !== true
          || parsed.action !== action.action
          || !Number.isFinite(parsed.before)
          || typeof parsed.beforeMuted !== 'boolean'
          || !Number.isFinite(parsed.level)
          || typeof parsed.muted !== 'boolean') {
          throw new Error('invalid verified volume state');
        }
        finish(undefined, {
          ok: true,
          action: action.action,
          before: boundedPercent(parsed.before),
          beforeMuted: parsed.beforeMuted,
          level: boundedPercent(parsed.level),
          muted: parsed.muted,
        });
      } catch (error) {
        finish(new VoiceVolumeError(
          'voice-volume-result-invalid',
          `Windows вернул неподтверждённый результат громкости: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
    child.stdin.end(JSON.stringify(action), 'utf8');
  });
}

function assertVerifiedVolumeAction(action: VoiceVolumeAction, state: VoiceVolumeState): void {
  if (!state?.ok || !Number.isFinite(state.level) || typeof state.muted !== 'boolean') {
    throw new VoiceVolumeError('voice-volume-unverified', 'Windows не подтвердил новый уровень громкости.');
  }
  if (action.action === 'mute' && !state.muted) {
    throw new VoiceVolumeError('voice-volume-unverified', 'Windows не подтвердил отключение звука.');
  }
  if (action.action === 'unmute' && state.muted) {
    throw new VoiceVolumeError('voice-volume-unverified', 'Windows не подтвердил включение звука.');
  }
  if (action.action === 'set' && Math.abs(state.level - action.value) > 1) {
    throw new VoiceVolumeError(
      'voice-volume-unverified',
      `Windows оставил громкость на ${state.level}% вместо ${action.value}%.`,
    );
  }
  if (action.action === 'change' && action.delta > 0 && state.level <= state.before && state.before < 100) {
    throw new VoiceVolumeError('voice-volume-unverified', `Громкость не увеличилась и осталась на ${state.level}%.`);
  }
  if (action.action === 'change' && action.delta < 0 && state.level >= state.before && state.before > 0) {
    throw new VoiceVolumeError('voice-volume-unverified', `Громкость не уменьшилась и осталась на ${state.level}%.`);
  }
}

function readRussianPercentage(text: string): number | null {
  const numeric = text.match(/(?:^|\s)(100|[1-9]?\d)\s*%?(?=\s|$)/u);
  if (numeric) return boundedPercent(Number(numeric[1]));
  if (/(?:^|\s)половин\p{L}*(?=\s|$)/u.test(text)) return 50;

  const values: Record<string, number> = {
    ноль: 0,
    один: 1,
    одна: 1,
    два: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
    одиннадцать: 11,
    двенадцать: 12,
    тринадцать: 13,
    четырнадцать: 14,
    пятнадцать: 15,
    шестнадцать: 16,
    семнадцать: 17,
    восемнадцать: 18,
    девятнадцать: 19,
    двадцать: 20,
    тридцать: 30,
    сорок: 40,
    пятьдесят: 50,
    шестьдесят: 60,
    семьдесят: 70,
    восемьдесят: 80,
    девяносто: 90,
    сто: 100,
  };
  const tokens = text.split(' ');
  for (let index = 0; index < tokens.length; index += 1) {
    const first = values[tokens[index]!];
    if (first === undefined) continue;
    const second = values[tokens[index + 1]!] ?? 0;
    const combined = first >= 20 && first < 100 && second > 0 && second < 10 ? first + second : first;
    return boundedPercent(combined);
  }
  return null;
}

function boundedPercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function appendBounded(current: string, chunk: unknown, max: number): string {
  const next = `${current}${String(chunk ?? '')}`;
  return next.length <= max ? next : next.slice(-max);
}
