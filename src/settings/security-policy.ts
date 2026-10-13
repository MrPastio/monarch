import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renameWithWindowsRetrySync, writeDurableJson } from '../core/durable-json';

/** Monarch Security policy center (program stage 9). Every protection the
 * person can tune has one entry: ordered levels from the strictest to the
 * weakest, a safe default and plain-language consequences. Components read the
 * level here instead of keeping their own switches.
 *
 * Owner decision 2026-10-12: the person may weaken or strengthen any measure.
 * Only a person in the Desktop window changes it (the HTTP route requires the
 * Desktop attestation); weakening needs an explicit confirmation and every
 * change is logged without content. A control appears here only once it is
 * wired, so the Security window never shows a switch that does nothing. */

export interface SecurityPolicyLevel {
  id: string;
  title: string;
  description: string;
}

export interface SecurityPolicyControl {
  id: string;
  group: 'privacy' | 'network' | 'storage' | 'interface';
  /** Owner principle 2026-10-12: Monarch serves the person, who may tune
   * nearly everything; rarely needed settings live behind "Расширенные
   * параметры" so the ordinary window stays simple. */
  visibility: 'basic' | 'advanced';
  title: string;
  description: string;
  /** Strictest first. */
  levels: readonly SecurityPolicyLevel[];
  defaultLevel: string;
}

export const SECURITY_POLICY_CONTROLS: readonly SecurityPolicyControl[] = Object.freeze([
  {
    id: 'links.confirmOpen',
    group: 'interface',
    visibility: 'basic',
    title: 'Открытие ссылок из ответов',
    description: 'Ссылка из ответа модели может вести на сайт, который узнает о переходе и о том, что записано в самой ссылке.',
    levels: [
      { id: 'always', title: 'Спрашивать', description: 'Перед открытием в браузере Monarch показывает адрес сайта и ждёт подтверждения.' },
      { id: 'off', title: 'Открывать сразу', description: 'Ссылки открываются в браузере без вопроса.' },
    ],
    defaultLevel: 'always',
  },
  {
    id: 'storage.encryption',
    group: 'storage',
    visibility: 'basic',
    title: 'Шифрование истории и памяти',
    description: 'Переписка, память и вложения хранятся на этом компьютере. Изменение вступает в силу после перезапуска Monarch.',
    levels: [
      { id: 'required', title: 'Шифровать', description: 'Данные на диске зашифрованы ключом Windows этой учётной записи. Если шифрование Windows недоступно, история хранится только до закрытия Monarch.' },
      { id: 'off', title: 'Не шифровать', description: 'Новые данные записываются открытым текстом: их сможет прочитать любой, у кого есть доступ к файлам или резервной копии.' },
    ],
    defaultLevel: 'required',
  },
  {
    // Owner decision 2026-10-12: Monarch Safe by default, with alternatives.
    id: 'storage.keyRecovery',
    group: 'storage',
    visibility: 'basic',
    title: 'Восстановление ключа истории',
    description: 'Ключ шифрования истории привязан к этой учётной записи Windows. Если его запись повредится или Windows переустановят, без копии ключа историю и память не открыть.',
    // Strictest first by secrecy: every extra copy is one more way to the key.
    levels: [
      { id: 'safe', title: 'Monarch Safe', description: 'Зашифрованная копия ключа открывается только входом в Monarch Safe — PIN, ключом восстановления или аварийной фразой. Копия обновится, когда Safe будет открыт.' },
      { id: 'safe-and-code', title: 'Safe и код', description: 'Две копии: в Monarch Safe и под кодом восстановления. Хватит любой, но код открывает историю любому, кто его найдёт.' },
      { id: 'code', title: 'Код восстановления', description: 'Monarch один раз покажет код и не будет его хранить. Кто найдёт код и файлы Monarch, откроет историю; потеряешь код — копии не будет.' },
      { id: 'none', title: 'Без копии', description: 'Если ключ потеряется, историю и память восстановить не получится.' },
    ],
    defaultLevel: 'safe',
  },
  {
    id: 'telegram.cloudSeparateKey',
    group: 'privacy',
    visibility: 'advanced',
    title: 'Ключ MAX для облака Telegram',
    description: 'Облако Telegram работает без компьютера и хранит ключ сервиса MAX у Cloudflare.',
    levels: [
      { id: 'required', title: 'Только отдельный ключ', description: 'Облако получает отдельный ключ, который можно ограничить по расходам и отозвать; основной ключ остаётся на компьютере.' },
      { id: 'off', title: 'Можно основной ключ', description: 'Если отдельный ключ не указан, в облако передаётся основной ключ MAX с компьютера.' },
    ],
    defaultLevel: 'required',
  },
  {
    id: 'search.queryMinimization',
    group: 'privacy',
    visibility: 'advanced',
    title: 'Очистка поисковых запросов',
    description: 'Поисковый запрос уходит сразу в несколько поисковиков.',
    levels: [
      { id: 'on', title: 'Очищать', description: 'Из запроса убираются e-mail, телефоны, номера карт и документов, ключи и адреса страниц; запрос не длиннее 200 символов.' },
      { id: 'off', title: 'Отправлять как есть', description: 'Поисковики получают запрос без очистки, вместе с личными данными, если они в нём есть.' },
    ],
    defaultLevel: 'on',
  },
] satisfies SecurityPolicyControl[]);

const CONTROL_BY_ID = new Map(SECURITY_POLICY_CONTROLS.map(control => [control.id, control]));
const MAX_LOG_BYTES = 256 * 1024;

export interface SecurityPolicySnapshot {
  schemaVersion: 1;
  levels: Record<string, string>;
}

export interface SecurityPolicyView {
  controls: Array<SecurityPolicyControl & { level: string; isDefault: boolean }>;
}

export class SecurityPolicyError extends Error {
  constructor(readonly code: 'unknown-control' | 'unknown-level' | 'weakening-unconfirmed') {
    super(`security-policy:${code}`);
  }
}

/** Position in the strictest-first list; a larger index is weaker. */
export function securityLevelRank(controlId: string, level: string): number {
  return CONTROL_BY_ID.get(controlId)?.levels.findIndex(item => item.id === level) ?? -1;
}

/** The policy file; Oscar reads it directly for its own controls. */
export function securityPolicyFilePath(stateRoot: string): string {
  return path.join(stateRoot, 'settings', 'security-policy.v1.json');
}

export class SecurityPolicyStore {
  private readonly filePath: string;
  private readonly logPath: string;

  constructor(stateRoot: string) {
    this.filePath = securityPolicyFilePath(stateRoot);
    this.logPath = path.join(stateRoot, 'settings', 'security-policy.log.jsonl');
  }

  /** Unknown, missing or damaged values read as the safe default. */
  snapshot(): SecurityPolicySnapshot {
    let stored: Record<string, unknown> = {};
    try {
      if (existsSync(this.filePath)) {
        const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as { schemaVersion?: unknown; levels?: unknown };
        if (value?.schemaVersion === 1 && value.levels && typeof value.levels === 'object') {
          stored = value.levels as Record<string, unknown>;
        }
      }
    } catch { stored = {}; }
    const levels: Record<string, string> = {};
    for (const control of SECURITY_POLICY_CONTROLS) {
      const candidate = stored[control.id];
      levels[control.id] = typeof candidate === 'string' && securityLevelRank(control.id, candidate) >= 0
        ? candidate : control.defaultLevel;
    }
    return { schemaVersion: 1, levels };
  }

  level(controlId: string): string {
    const control = CONTROL_BY_ID.get(controlId);
    if (!control) throw new SecurityPolicyError('unknown-control');
    return this.snapshot().levels[controlId] ?? control.defaultLevel;
  }

  view(): SecurityPolicyView {
    const { levels } = this.snapshot();
    return {
      controls: SECURITY_POLICY_CONTROLS.map(control => ({
        ...control,
        levels: control.levels.map(item => ({ ...item })),
        level: levels[control.id]!,
        isDefault: levels[control.id] === control.defaultLevel,
      })),
    };
  }

  /** Strengthening applies at once; weakening only with `confirmWeakening`. */
  set(input: { control?: unknown; level?: unknown; confirmWeakening?: unknown }, now = new Date()): SecurityPolicyView {
    const controlId = typeof input?.control === 'string' ? input.control : '';
    const control = CONTROL_BY_ID.get(controlId);
    if (!control) throw new SecurityPolicyError('unknown-control');
    const level = typeof input.level === 'string' ? input.level : '';
    const nextRank = securityLevelRank(controlId, level);
    if (nextRank < 0) throw new SecurityPolicyError('unknown-level');
    const current = this.snapshot();
    const previous = current.levels[controlId]!;
    const previousRank = securityLevelRank(controlId, previous);
    if (nextRank > previousRank && input.confirmWeakening !== true) throw new SecurityPolicyError('weakening-unconfirmed');
    if (previous !== level) {
      writeDurableJson(this.filePath, { schemaVersion: 1, levels: { ...current.levels, [controlId]: level } });
      this.log({ at: now.toISOString(), control: controlId, from: previous, to: level,
        direction: nextRank > previousRank ? 'weaker' : 'stronger' });
    }
    return this.view();
  }

  private log(entry: Record<string, string>): void {
    try {
      mkdirSync(path.dirname(this.logPath), { recursive: true });
      if (existsSync(this.logPath) && statSync(this.logPath).size > MAX_LOG_BYTES) {
        renameWithWindowsRetrySync(this.logPath, this.logPath + '.1');
      }
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // The change itself is saved; a full disk must not undo it.
    }
  }
}
