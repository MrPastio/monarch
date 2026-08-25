import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { findAgentContextSecretPath } from '../../agent/context-compiler';
import type { AgentSkillMetadata } from './agent-skills';
import { AgentSkillRegistry, getAgentSkillRegistry } from './agent-skills';

const MAX_PURPOSE_LENGTH = 2_000;
const MAX_INSTRUCTIONS_LENGTH = 8_000;
const MAX_EXAMPLES = 8;
const MAX_CAPABILITIES = 32;
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CAPABILITY_ID = /^[a-z0-9][a-z0-9._*-]{0,127}$/;

export type AgentSkillDraftSource = 'manual' | 'auto';
export type AgentSkillAuthoringScope = 'project' | 'user';

export interface AgentSkillDraftV1 {
  schemaVersion: 1;
  source: AgentSkillDraftSource;
  scope: AgentSkillAuthoringScope;
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  examples: string[];
  requiredCapabilities: string[];
  allowImplicitInvocation: boolean;
}

export interface AgentSkillDiagnostic {
  level: 'error' | 'warning';
  code: string;
  field: string;
  message: string;
}

export interface AgentSkillValidationResult {
  valid: boolean;
  draft: AgentSkillDraftV1;
  draftHash: string;
  targetLocation: string;
  diagnostics: AgentSkillDiagnostic[];
}

export interface AgentSkillCreationReceipt {
  schemaVersion: 1;
  created: true;
  verified: true;
  name: string;
  scope: AgentSkillAuthoringScope;
  source: AgentSkillDraftSource;
  location: string;
  draftHash: string;
  packageHash: string;
  readBackHash: string;
  skillId: string;
}

export interface AgentSkillPublishResult {
  receipt: AgentSkillCreationReceipt;
  skill: AgentSkillMetadata;
}

export class AgentSkillAuthoringError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSkillAuthoringError';
  }
}

export interface AgentSkillAuthoringOptions {
  userSkillsRoot?: string;
}

export class AgentSkillAuthoringService {
  readonly userSkillsRoot: string;

  constructor(
    readonly workspaceRoot = process.cwd(),
    readonly registry: AgentSkillRegistry = getAgentSkillRegistry(workspaceRoot),
    options: AgentSkillAuthoringOptions = {},
  ) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.userSkillsRoot = path.resolve(options.userSkillsRoot || path.join(homedir(), '.monarch', 'skills'));
  }

  createAutoDraft(purposeInput: unknown, scopeInput: unknown = 'project'): AgentSkillDraftV1 {
    const purpose = compactText(purposeInput, MAX_PURPOSE_LENGTH);
    if (purpose.length < 12) {
      throw new AgentSkillAuthoringError(
        400,
        'skill-purpose-too-short',
        'Опиши результат навыка хотя бы одним коротким предложением.',
      );
    }
    const scope = normalizeScope(scopeInput);
    const name = purposeToSkillName(purpose);
    const displayName = purposeToDisplayName(purpose, name);
    const description = normalizeDescription(purpose);
    return {
      schemaVersion: 1,
      source: 'auto',
      scope,
      name,
      displayName,
      description,
      instructions: buildAutoInstructions(purpose),
      examples: [purpose.slice(0, 400)],
      requiredCapabilities: [],
      // Auto-generated instructions always require a human review before they
      // can participate in implicit routing.
      allowImplicitInvocation: false,
    };
  }

  normalizeDraft(value: unknown): AgentSkillDraftV1 {
    const record = asRecord(value);
    return {
      schemaVersion: 1,
      source: record?.source === 'auto' ? 'auto' : 'manual',
      scope: normalizeScope(record?.scope),
      name: normalizeSkillName(record?.name),
      displayName: compactText(record?.displayName, 80),
      description: compactText(record?.description, 500),
      instructions: normalizeInstructions(record?.instructions),
      examples: normalizeStringList(record?.examples, MAX_EXAMPLES, 400),
      requiredCapabilities: normalizeStringList(record?.requiredCapabilities, MAX_CAPABILITIES, 128)
        .map((entry) => entry.toLowerCase()),
      allowImplicitInvocation: record?.allowImplicitInvocation === true,
    };
  }

  async validate(
    value: unknown,
    options: { availableCapabilities?: Iterable<string> } = {},
  ): Promise<AgentSkillValidationResult> {
    const source = asRecord(value);
    const draft = this.normalizeDraft(value);
    const diagnostics: AgentSkillDiagnostic[] = [];
    const allowedKeys = new Set([
      'schemaVersion', 'source', 'scope', 'name', 'displayName', 'description', 'instructions',
      'examples', 'requiredCapabilities', 'allowImplicitInvocation',
    ]);
    if (!source) {
      diagnostics.push(errorDiagnostic('draft', 'skill-draft-invalid', 'Черновик навыка должен быть объектом.'));
    } else {
      const unknownKeys = Object.keys(source).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length) {
        diagnostics.push(errorDiagnostic(
          'draft',
          'skill-draft-extra-fields',
          `Лишние поля черновика: ${unknownKeys.join(', ')}.`,
        ));
      }
      if (source.schemaVersion !== 1) {
        diagnostics.push(errorDiagnostic('schemaVersion', 'skill-schema-version', 'Поддерживается только schemaVersion 1.'));
      }
      if (source.source !== 'manual' && source.source !== 'auto') {
        diagnostics.push(errorDiagnostic('source', 'skill-source-invalid', 'Источник черновика должен быть manual или auto.'));
      }
      if (source.scope !== 'project' && source.scope !== 'user') {
        diagnostics.push(errorDiagnostic('scope', 'skill-scope-invalid', 'Выбери область project или user.'));
      }
      if (typeof source.name !== 'string' || source.name.trim().toLowerCase() !== draft.name) {
        diagnostics.push(errorDiagnostic('name', 'skill-name-not-canonical', 'Имя должно уже быть в каноническом формате без автозамены символов.'));
      }
      if (!Array.isArray(source.examples) || !source.examples.every((entry) => typeof entry === 'string')) {
        diagnostics.push(errorDiagnostic('examples', 'skill-examples-invalid', 'Примеры должны быть массивом строк.'));
      }
      if (!Array.isArray(source.requiredCapabilities)
        || !source.requiredCapabilities.every((entry) => typeof entry === 'string')) {
        diagnostics.push(errorDiagnostic(
          'requiredCapabilities',
          'skill-capabilities-invalid',
          'requiredCapabilities должен быть массивом строк.',
        ));
      }
      if (typeof source.allowImplicitInvocation !== 'boolean') {
        diagnostics.push(errorDiagnostic(
          'allowImplicitInvocation',
          'skill-implicit-invalid',
          'Режим автоподбора должен быть явным true или false.',
        ));
      }
      if (typeof source.displayName === 'string' && source.displayName.trim().length > 80) {
        diagnostics.push(errorDiagnostic('displayName', 'skill-display-name-long', 'Название длиннее 80 символов.'));
      }
      if (typeof source.description === 'string' && source.description.trim().length > 500) {
        diagnostics.push(errorDiagnostic('description', 'skill-description-long', 'Описание длиннее 500 символов.'));
      }
      if (Array.isArray(source.examples) && source.examples.length > MAX_EXAMPLES) {
        diagnostics.push(errorDiagnostic('examples', 'skill-examples-limit', `Допустимо не больше ${MAX_EXAMPLES} примеров.`));
      }
      if (Array.isArray(source.requiredCapabilities) && source.requiredCapabilities.length > MAX_CAPABILITIES) {
        diagnostics.push(errorDiagnostic(
          'requiredCapabilities',
          'skill-capabilities-limit',
          `Допустимо не больше ${MAX_CAPABILITIES} capability.`,
        ));
      }
    }

    if (!SKILL_NAME.test(draft.name) || draft.name.includes('--')) {
      diagnostics.push(errorDiagnostic(
        'name',
        'skill-name-invalid',
        'Имя: 1–63 символа, только a-z, 0-9 и одиночные дефисы.',
      ));
    }
    if (draft.displayName.length < 3) {
      diagnostics.push(errorDiagnostic('displayName', 'skill-display-name-short', 'Укажи короткое название навыка.'));
    }
    if (draft.description.length < 20) {
      diagnostics.push(errorDiagnostic('description', 'skill-description-short', 'Описание должно ясно говорить, когда применять навык.'));
    }
    if (draft.instructions.length < 40 || draft.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      diagnostics.push(errorDiagnostic(
        'instructions',
        'skill-instructions-length',
        `Инструкции должны содержать от 40 до ${MAX_INSTRUCTIONS_LENGTH} символов.`,
      ));
    }
    const invalidCapability = draft.requiredCapabilities.find((value) => !CAPABILITY_ID.test(value));
    if (invalidCapability) {
      diagnostics.push(errorDiagnostic(
        'requiredCapabilities',
        'skill-capability-invalid',
        `Некорректный capability id: ${invalidCapability}.`,
      ));
    }
    const duplicateCapabilities = duplicateValues(draft.requiredCapabilities);
    if (duplicateCapabilities.length) {
      diagnostics.push(errorDiagnostic(
        'requiredCapabilities',
        'skill-capability-duplicate',
        `Повторяются capability: ${duplicateCapabilities.join(', ')}.`,
      ));
    }
    const secretPath = findAgentContextSecretPath({
      description: draft.description,
      instructions: draft.instructions,
      examples: draft.examples,
    }, 'draft');
    if (secretPath) {
      diagnostics.push(errorDiagnostic(
        secretPath,
        'skill-secret-material',
        'В черновике обнаружен похожий на секрет фрагмент. Удали ключ, токен или пароль.',
      ));
    }

    const available = options.availableCapabilities
      ? new Set(Array.from(options.availableCapabilities, (entry) => String(entry).toLowerCase()))
      : null;
    const unavailable = available
      ? draft.requiredCapabilities.filter((capability) => !available.has(capability))
      : [];
    if (unavailable.length) {
      diagnostics.push(warningDiagnostic(
        'requiredCapabilities',
        'skill-capability-unavailable',
        `Сейчас не зарегистрированы: ${unavailable.join(', ')}. Навык не получает эти права автоматически.`,
      ));
    }
    if (draft.allowImplicitInvocation) {
      diagnostics.push(warningDiagnostic(
        'allowImplicitInvocation',
        'skill-implicit-enabled',
        'Навык сможет подбираться автоматически. Его действия всё равно проходят Policy Kernel.',
      ));
    }
    if (!draft.examples.length) {
      diagnostics.push(warningDiagnostic('examples', 'skill-examples-empty', 'Добавь пример запроса для точного подбора навыка.'));
    }

    const target = this.targetDirectory(draft);
    if (await pathExists(target)) {
      diagnostics.push(errorDiagnostic('name', 'skill-already-exists', 'Навык с таким именем уже существует в выбранной области.'));
    } else if (draft.name) {
      const duplicate = (await this.registry.list()).find((skill) => skill.name.toLowerCase() === draft.name);
      if (duplicate) {
        diagnostics.push(errorDiagnostic(
          'name',
          'skill-name-conflict',
          `Имя уже занято навыком ${duplicate.displayName} (${duplicate.scope}).`,
        ));
      }
    }

    return {
      valid: diagnostics.every((entry) => entry.level !== 'error'),
      draft,
      draftHash: hashDraft(draft),
      targetLocation: displayLocation(path.join(target, 'SKILL.md'), this.workspaceRoot),
      diagnostics,
    };
  }

  async publish(
    value: unknown,
    expectedDraftHash: unknown,
    options: { availableCapabilities?: Iterable<string>; signal?: AbortSignal } = {},
  ): Promise<AgentSkillPublishResult> {
    throwIfAborted(options.signal);
    const validation = await this.validate(value, options);
    const expected = compactText(expectedDraftHash, 128);
    if (!expected || expected !== validation.draftHash) {
      throw new AgentSkillAuthoringError(
        409,
        'skill-draft-changed',
        'Черновик изменился после проверки. Проверь его ещё раз перед созданием.',
      );
    }
    const firstError = validation.diagnostics.find((entry) => entry.level === 'error');
    if (firstError) {
      throw new AgentSkillAuthoringError(422, firstError.code, firstError.message);
    }

    const draft = validation.draft;
    const root = this.scopeRoot(draft.scope);
    const target = this.targetDirectory(draft);
    await mkdir(root, { recursive: true });
    throwIfAborted(options.signal);
    if (await pathExists(target)) {
      throw new AgentSkillAuthoringError(409, 'skill-already-exists', 'Навык с таким именем уже существует.');
    }

    const staging = path.join(root, `.${draft.name}.staging-${randomUUID()}`);
    assertPathInside(root, staging);
    assertPathInside(root, target);
    const skillMarkdown = renderSkillMarkdown(draft);
    const openAiYaml = renderOpenAiYaml(draft);
    let committed = false;
    try {
      await mkdir(path.join(staging, 'agents'), { recursive: true });
      await writeFile(path.join(staging, 'SKILL.md'), skillMarkdown, { encoding: 'utf8', flag: 'wx' });
      await writeFile(path.join(staging, 'agents', 'openai.yaml'), openAiYaml, { encoding: 'utf8', flag: 'wx' });
      throwIfAborted(options.signal);
      await rename(staging, target);
      committed = true;
    } catch (error) {
      if (!committed) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (isAlreadyExistsError(error)) {
        throw new AgentSkillAuthoringError(409, 'skill-already-exists', 'Навык с таким именем уже существует.');
      }
      throw error;
    }

    const [skillReadBack, yamlReadBack] = await Promise.all([
      readFile(path.join(target, 'SKILL.md'), 'utf8'),
      readFile(path.join(target, 'agents', 'openai.yaml'), 'utf8'),
    ]);
    const packageHash = hashPackage(skillMarkdown, openAiYaml);
    const readBackHash = hashPackage(skillReadBack, yamlReadBack);
    if (packageHash !== readBackHash) {
      throw new AgentSkillAuthoringError(
        500,
        'skill-readback-mismatch',
        'Навык записан, но контрольное чтение не совпало. Файлы оставлены для диагностики.',
      );
    }

    this.registry.invalidate();
    const skill = (await this.registry.list({ refresh: true })).find((entry) => (
      entry.name === draft.name && entry.scope === draft.scope
    ));
    if (!skill || skill.fingerprint !== createHash('sha256').update(skillReadBack, 'utf8').digest('hex')) {
      throw new AgentSkillAuthoringError(
        500,
        'skill-registry-verification-failed',
        'Навык записан, но Astra не подтвердила его в каталоге. Файлы оставлены для диагностики.',
      );
    }

    return {
      skill,
      receipt: {
        schemaVersion: 1,
        created: true,
        verified: true,
        name: draft.name,
        scope: draft.scope,
        source: draft.source,
        location: skill.location,
        draftHash: validation.draftHash,
        packageHash,
        readBackHash,
        skillId: skill.id,
      },
    };
  }

  private scopeRoot(scope: AgentSkillAuthoringScope): string {
    return scope === 'user'
      ? this.userSkillsRoot
      : path.join(this.workspaceRoot, '.monarch', 'skills');
  }

  private targetDirectory(draft: Pick<AgentSkillDraftV1, 'scope' | 'name'>): string {
    const root = this.scopeRoot(draft.scope);
    const target = path.resolve(root, draft.name || '__invalid__');
    assertPathInside(root, target);
    return target;
  }
}

const authoringServices = new Map<string, AgentSkillAuthoringService>();

export function getAgentSkillAuthoringService(
  workspaceRoot = process.cwd(),
  registry = getAgentSkillRegistry(workspaceRoot),
): AgentSkillAuthoringService {
  const key = path.resolve(workspaceRoot).toLowerCase();
  const existing = authoringServices.get(key);
  if (existing) return existing;
  const service = new AgentSkillAuthoringService(workspaceRoot, registry);
  authoringServices.set(key, service);
  return service;
}

function renderSkillMarkdown(draft: AgentSkillDraftV1): string {
  return [
    '---',
    `name: ${yamlString(draft.name)}`,
    `description: ${yamlString(draft.description)}`,
    '---',
    '',
    draft.instructions.trim(),
    '',
    ...(draft.examples.length ? [
      '## Примеры запросов',
      '',
      ...draft.examples.map((example) => `- ${example.replace(/\s+/g, ' ').trim()}`),
      '',
    ] : []),
  ].join('\n');
}

function renderOpenAiYaml(draft: AgentSkillDraftV1): string {
  return [
    'interface:',
    `  display_name: ${yamlString(draft.displayName)}`,
    `  short_description: ${yamlString(draft.description.slice(0, 120))}`,
    `  default_prompt: ${yamlString(`Use $${draft.name} to follow this local workflow.`)}`,
    'policy:',
    `  allow_implicit_invocation: ${draft.allowImplicitInvocation ? 'true' : 'false'}`,
    'monarch:',
    '  schema_version: 1',
    `  source: ${draft.source}`,
    ...(draft.requiredCapabilities.length
      ? ['  required_capabilities:', ...draft.requiredCapabilities.map((capability) => `    - ${yamlString(capability)}`)]
      : ['  required_capabilities: []']),
    '',
  ].join('\n');
}

function buildAutoInstructions(purpose: string): string {
  return [
    '# Цель',
    '',
    purpose,
    '',
    '# Порядок работы',
    '',
    '1. Сначала уточни границы задачи и проверь текущее состояние доступными read-only средствами.',
    '2. Составь короткий проверяемый план. Не выдавай намерение или текст модели за выполненное действие.',
    '3. Для каждого изменения используй только зарегистрированные capability и сохрани ограничения пользователя.',
    '4. После изменений выполни контрольное чтение или другую независимую проверку результата.',
    '5. Сообщи фактический результат, проверку и оставшиеся ограничения. Если действие не запускалось, скажи это прямо.',
    '',
    '# Безопасность',
    '',
    '- Навык не выдаёт новых прав: решения остаются за Policy Kernel и точными подтверждениями.',
    '- Не расширяй область задачи, не раскрывай секреты и не выполняй необратимые действия без явного основания.',
  ].join('\n');
}

function normalizeScope(value: unknown): AgentSkillAuthoringScope {
  return value === 'user' ? 'user' : 'project';
}

function normalizeSkillName(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

function purposeToSkillName(purpose: string): string {
  const transliterated = transliterate(purpose.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const tokens = transliterated.split('-').filter((token) => (
    token.length > 2 && !AUTO_NAME_STOP_WORDS.has(token)
  ));
  const base = tokens.slice(0, 5).join('-') || 'local-workflow';
  return normalizeSkillName(base);
}

function purposeToDisplayName(purpose: string, fallbackName: string): string {
  const first = purpose.split(/[.!?\n]/)[0]?.trim() || '';
  const compact = first.replace(/^[$/][a-z0-9:_-]+\s*/i, '').slice(0, 80).trim();
  if (compact.length >= 3) return compact;
  return fallbackName.split('-').map((token) => `${token[0]?.toUpperCase() || ''}${token.slice(1)}`).join(' ');
}

function normalizeDescription(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim().slice(0, 500);
  return /[.!?]$/.test(compact) ? compact : `${compact}.`;
}

function normalizeInstructions(value: unknown): string {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_INSTRUCTIONS_LENGTH + 1);
}

function normalizeStringList(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/\s+/g, ' ').trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function compactText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function hashDraft(draft: AgentSkillDraftV1): string {
  return createHash('sha256').update(stableJson(draft), 'utf8').digest('hex');
}

function hashPackage(skillMarkdown: string, openAiYaml: string): string {
  return createHash('sha256')
    .update('SKILL.md\0', 'utf8')
    .update(skillMarkdown, 'utf8')
    .update('\0agents/openai.yaml\0', 'utf8')
    .update(openAiYaml, 'utf8')
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return Array.from(duplicates);
}

function errorDiagnostic(field: string, code: string, message: string): AgentSkillDiagnostic {
  return { level: 'error', field, code, message };
}

function warningDiagnostic(field: string, code: string, message: string): AgentSkillDiagnostic {
  return { level: 'warning', field, code, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' ').trim());
}

function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AgentSkillAuthoringError(400, 'skill-path-invalid', 'Целевой путь навыка выходит за разрешённый каталог.');
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code || '');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Skill creation was cancelled before commit.');
  error.name = 'AbortError';
  throw error;
}

function displayLocation(filePath: string, workspaceRoot: string): string {
  const workspaceRelative = path.relative(workspaceRoot, filePath);
  if (workspaceRelative && !workspaceRelative.startsWith('..') && !path.isAbsolute(workspaceRelative)) {
    return workspaceRelative.replace(/\\/g, '/');
  }
  const homeRelative = path.relative(homedir(), filePath);
  if (homeRelative && !homeRelative.startsWith('..') && !path.isAbsolute(homeRelative)) {
    return `~/${homeRelative.replace(/\\/g, '/')}`;
  }
  return path.basename(filePath);
}

const AUTO_NAME_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'this', 'that', 'skill', 'navyk', 'sozdat', 'sozday',
  'kotoryy', 'kotoraya', 'dlya', 'chtoby', 'budet', 'nuzhen', 'nuzhno', 'mne', 'monarch',
]);

function transliterate(value: string): string {
  return Array.from(value).map((character) => CYRILLIC_TRANSLITERATION[character] ?? character).join('');
}

const CYRILLIC_TRANSLITERATION: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
