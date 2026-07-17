import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';

// Skill discovery can span user, workspace, and plugin-cache roots. Keep the
// metadata snapshot warm so typing in Skill Radar never triggers a full scan.
const SKILL_CACHE_TTL_MS = 30_000;
const MAX_SKILL_FILES = 512;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_ACTIVATED_INSTRUCTIONS = 8_000;
const MAX_SKILL_RESOURCES = 128;
const MAX_SKILL_RESOURCE_DEPTH = 4;
const DEFAULT_IMPLICIT_ACTIVATION_SCORE = 0.55;
const ALL_SKILL_PLATFORMS = ['win32', 'darwin', 'linux'] as const;

const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git',
  '.venv',
  '__pycache__',
  'assets',
  'build',
  'dist',
  'node_modules',
  'references',
  'scripts',
  'tmp',
]);

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'для', 'его', 'или', 'как', 'когда',
  'можешь', 'надо', 'нужно', 'она', 'они', 'при', 'the', 'this', 'use', 'user',
  'with', 'what', 'which', 'чтобы', 'это', 'этот', 'that', 'from', 'into', 'your',
]);

const GENERIC_ACTION_TOKENS = new Set([
  'build', 'create', 'edit', 'generate', 'make', 'run', 'use', 'write',
]);

const TOKEN_ALIASES: Record<string, string[]> = {
  безопасность: ['security'],
  безопасностью: ['security'],
  браузер: ['browser'],
  документ: ['document'],
  документы: ['documents'],
  изображение: ['image'],
  изображения: ['image'],
  картинка: ['image'],
  картинки: ['image'],
  картинку: ['image'],
  код: ['code'],
  исправь: ['improve', 'edit'],
  улучшить: ['improve'],
  файл: ['file'],
  файла: ['file'],
  файлы: ['files', 'file'],
  файлов: ['files', 'file'],
  создай: ['create', 'creating', 'generate'],
  создать: ['create', 'creating', 'generate'],
  удали: ['delete', 'deleting'],
  удалить: ['delete', 'deleting'],
  переименуй: ['rename'],
  переименовать: ['rename'],
  перемести: ['move'],
  переместить: ['move'],
  навык: ['skill'],
  навыки: ['skills'],
  навыков: ['skills'],
  систему: ['system'],
  система: ['system'],
  презентация: ['presentation'],
  сгенерируй: ['generate', 'create'],
  таблица: ['spreadsheet'],
  тест: ['test'],
  тестирование: ['testing'],
};

export type AgentSkillProvider = 'codex' | 'claude' | 'gemini' | 'monarch';
export type AgentSkillScope = 'project' | 'user' | 'system';
export type AgentSkillPlatform = typeof ALL_SKILL_PLATFORMS[number];
export type AgentSkillSourceTier = 'builtin' | 'extension' | 'user' | 'workspace';
export type AgentSkillTrust = 'trusted' | 'linked';

export interface AgentSkillMetadata {
  id: string;
  name: string;
  displayName: string;
  description: string;
  provider: AgentSkillProvider;
  scope: AgentSkillScope;
  sourceTier: AgentSkillSourceTier;
  trust: AgentSkillTrust;
  location: string;
  fingerprint: string;
  allowImplicitInvocation: boolean;
  userInvocable: boolean;
  argumentHint: string;
  context: string;
  agent: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** Declarative requirements only. The Policy Kernel remains the sole authority. */
  requiredCapabilities: string[];
  paths: string[];
  legacyCommand: boolean;
  platforms: AgentSkillPlatform[];
  compatible: boolean;
  resourceCount: number;
  executableResourceCount: number;
  requiresExplicitActivation: boolean;
}

export interface AgentSkillMatch {
  skill: AgentSkillMetadata;
  score: number;
  explicit: boolean;
  reason: string;
  matchedTerms: string[];
}

export interface ActivatedAgentSkill extends AgentSkillMetadata {
  instructions: string;
  arguments: string;
  explicit: boolean;
  truncated: boolean;
  resources: string[];
}

interface SkillRecord {
  metadata: AgentSkillMetadata;
  filePath: string;
  priority: number;
}

interface SkillSnapshot {
  loadedAt: number;
  records: SkillRecord[];
}

interface DiscoveredSkillFile {
  filePath: string;
  provider: AgentSkillProvider;
  scope: AgentSkillScope;
  legacyCommand: boolean;
  sourceRoot: string;
  sourceTier: AgentSkillSourceTier;
  priority: number;
}

interface ParsedSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export class AgentSkillRegistry {
  private snapshot: SkillSnapshot | null = null;
  private loading: Promise<SkillSnapshot> | null = null;

  constructor(
    readonly workspaceRoot = process.cwd(),
    readonly runtimePlatform: NodeJS.Platform = process.platform,
  ) {}

  async list(options: { refresh?: boolean } = {}): Promise<AgentSkillMetadata[]> {
    const snapshot = await this.loadSnapshot(Boolean(options.refresh));
    return snapshot.records.map((record) => ({ ...record.metadata }));
  }

  async match(query: string, options: { limit?: number } = {}): Promise<AgentSkillMatch[]> {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return [];
    }

    const limit = Math.max(1, Math.min(Math.floor(options.limit || 5), 20));
    const queryTokens = tokenize(normalizedQuery);
    const explicitNames = readExplicitSkillNames(normalizedQuery);
    const snapshot = await this.loadSnapshot(false);

    return snapshot.records
      .map((record) => scoreSkill(record.metadata, normalizedQuery, queryTokens, explicitNames))
      .filter((match): match is AgentSkillMatch => match !== null)
      .sort(compareMatches)
      .slice(0, limit);
  }

  async activate(
    idOrName: string,
    prompt = '',
    options: { explicit?: boolean } = {}
  ): Promise<ActivatedAgentSkill | null> {
    const snapshot = await this.loadSnapshot(false);
    const needle = String(idOrName || '').trim().toLowerCase();
    const record = snapshot.records.find((candidate) => candidate.metadata.id.toLowerCase() === needle)
      || snapshot.records.find((candidate) => candidate.metadata.name.toLowerCase() === needle);
    if (!record || !record.metadata.compatible) {
      return null;
    }

    const parsed = await readSkillFile(record.filePath);
    const fingerprint = createContentFingerprint(parsed.raw);
    if (fingerprint !== record.metadata.fingerprint) {
      this.invalidate();
      return null;
    }
    const invocationArguments = readInvocationArguments(prompt, record.metadata.name);
    const rendered = renderSkillInstructions(parsed.body, invocationArguments, path.dirname(record.filePath));
    const truncated = rendered.length > MAX_ACTIVATED_INSTRUCTIONS;
    const resources = await listSkillResources(path.dirname(record.filePath));

    return {
      ...record.metadata,
      instructions: rendered.slice(0, MAX_ACTIVATED_INSTRUCTIONS),
      arguments: invocationArguments,
      explicit: Boolean(options.explicit),
      truncated,
      resources,
    };
  }

  async activateForPrompt(
    prompt: string,
    options: { limit?: number; minimumScore?: number } = {}
  ): Promise<ActivatedAgentSkill[]> {
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 2), 3));
    const minimumScore = Math.max(0, Math.min(options.minimumScore ?? DEFAULT_IMPLICIT_ACTIVATION_SCORE, 1));
    const matches = await this.match(prompt, { limit: Math.max(limit * 3, 6) });
    const explicitMatches = matches.filter((match) => match.explicit && match.skill.userInvocable);
    const selected = explicitMatches.length > 0
      ? explicitMatches.slice(0, limit)
      : matches
        .filter((match) => (
          match.skill.allowImplicitInvocation
          && !match.skill.requiresExplicitActivation
          && match.score >= minimumScore
        ))
        .slice(0, limit);

    const activated = await Promise.all(selected.map((match) => this.activate(
      match.skill.id,
      prompt,
      { explicit: match.explicit }
    )));
    return activated.filter((skill): skill is ActivatedAgentSkill => skill !== null);
  }

  invalidate(): void {
    this.snapshot = null;
  }

  private async loadSnapshot(refresh: boolean): Promise<SkillSnapshot> {
    const now = Date.now();
    if (!refresh && this.snapshot && now - this.snapshot.loadedAt <= SKILL_CACHE_TTL_MS) {
      return this.snapshot;
    }
    if (this.loading) {
      return this.loading;
    }

    this.loading = this.scan()
      .then((snapshot) => {
        this.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async scan(): Promise<SkillSnapshot> {
    const discovered = await discoverSkillFiles(this.workspaceRoot);
    const records = deduplicateSkillRecords((await Promise.all(
      discovered.slice(0, MAX_SKILL_FILES).map((entry) => readSkillRecord(entry, this.runtimePlatform))
    ))
      .filter((record): record is SkillRecord => record !== null)
      .sort(compareSkillRecords));

    return {
      loadedAt: Date.now(),
      records,
    };
  }
}

const registries = new Map<string, AgentSkillRegistry>();

export function getAgentSkillRegistry(workspaceRoot = process.cwd()): AgentSkillRegistry {
  const normalizedRoot = path.resolve(workspaceRoot).toLowerCase();
  const existing = registries.get(normalizedRoot);
  if (existing) {
    return existing;
  }
  const registry = new AgentSkillRegistry(path.resolve(workspaceRoot));
  registries.set(normalizedRoot, registry);
  return registry;
}

async function discoverSkillFiles(workspaceRoot: string): Promise<DiscoveredSkillFile[]> {
  const root = path.resolve(workspaceRoot);
  const home = homedir();
  const results: DiscoveredSkillFile[] = [];
  const seen = new Set<string>();

  const addSkillRoot = async (
    skillRoot: string,
    provider: AgentSkillProvider,
    scope: AgentSkillScope,
    maxDepth: number,
    sourceTier: AgentSkillSourceTier,
    priority: number,
  ): Promise<void> => {
    const files = await findSkillEntrypoints(skillRoot, maxDepth);
    for (const filePath of files) {
      const key = path.resolve(filePath).toLowerCase();
      if (seen.has(key) || results.length >= MAX_SKILL_FILES) continue;
      seen.add(key);
      results.push({
        filePath,
        provider,
        scope,
        legacyCommand: false,
        sourceRoot: skillRoot,
        sourceTier,
        priority,
      });
    }
  };

  await Promise.all([
    // Google Agent Skills precedence, adapted for Monarch's local providers.
    addSkillRoot(path.join(home, '.codex', 'plugins', 'cache'), 'codex', 'system', 10, 'builtin', 10),
    addSkillRoot(path.join(home, '.gemini', 'extensions'), 'gemini', 'system', 8, 'extension', 20),
    addSkillRoot(path.join(home, '.gemini', 'skills'), 'gemini', 'user', 6, 'user', 30),
    addSkillRoot(path.join(home, '.claude', 'skills'), 'claude', 'user', 6, 'user', 31),
    addSkillRoot(path.join(home, '.codex', 'skills'), 'codex', 'user', 6, 'user', 32),
    addSkillRoot(path.join(home, '.agents', 'skills'), 'codex', 'user', 6, 'user', 33),
    addSkillRoot(path.join(root, '.gemini', 'skills'), 'gemini', 'project', 6, 'workspace', 40),
    addSkillRoot(path.join(root, '.claude', 'skills'), 'claude', 'project', 6, 'workspace', 41),
    addSkillRoot(path.join(root, '.monarch', 'skills'), 'monarch', 'project', 6, 'workspace', 42),
    addSkillRoot(path.join(root, '.agents', 'skills'), 'codex', 'project', 6, 'workspace', 43),
  ]);

  const nestedConfigRoots = await findNestedSkillRoots(root, 5);
  await Promise.all(nestedConfigRoots.map((entry) => addSkillRoot(
    entry.skillRoot,
    entry.provider,
    'project',
    5,
    'workspace',
    entry.provider === 'codex' ? 43 : entry.provider === 'monarch' ? 42 : 41,
  )));

  const legacyCommands = await Promise.all([
    findLegacyClaudeCommands(path.join(root, '.claude', 'commands'), 'project'),
    findLegacyClaudeCommands(path.join(home, '.claude', 'commands'), 'user'),
  ]);
  for (const command of legacyCommands.flat()) {
    const key = path.resolve(command.filePath).toLowerCase();
    if (seen.has(key) || results.length >= MAX_SKILL_FILES) continue;
    seen.add(key);
    results.push(command);
  }

  return results;
}

async function findSkillEntrypoints(root: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  await walk(root, 0);
  return results;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= MAX_SKILL_FILES) return;
    const entries = await safeReadDirectory(current);
    if (!entries) return;

    const hasEntrypoint = entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
    if (hasEntrypoint) {
      results.push(path.join(current, 'SKILL.md'));
      return;
    }

    await Promise.all(entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .filter((entry) => !SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase()))
      .map((entry) => walk(path.join(current, entry.name), depth + 1)));
  }
}

async function findNestedSkillRoots(
  workspaceRoot: string,
  maxDepth: number
): Promise<Array<{ skillRoot: string; provider: AgentSkillProvider }>> {
  const results: Array<{ skillRoot: string; provider: AgentSkillProvider }> = [];
  await walk(workspaceRoot, 0);
  return results;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await safeReadDirectory(current);
    if (!entries) return;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === '.agents' || lower === '.claude' || lower === '.gemini' || lower === '.monarch') {
        const provider: AgentSkillProvider = lower === '.agents'
          ? 'codex'
          : lower === '.claude' ? 'claude' : lower === '.gemini' ? 'gemini' : 'monarch';
        results.push({ skillRoot: path.join(current, entry.name, 'skills'), provider });
        continue;
      }
      if (lower.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(lower)) continue;
      await walk(path.join(current, entry.name), depth + 1);
    }
  }
}

async function findLegacyClaudeCommands(
  root: string,
  scope: AgentSkillScope
): Promise<DiscoveredSkillFile[]> {
  const entries = await safeReadDirectory(root);
  if (!entries) return [];
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => ({
      filePath: path.join(root, entry.name),
      provider: 'claude' as const,
      scope,
      legacyCommand: true,
      sourceRoot: root,
      sourceTier: scope === 'project' ? 'workspace' as const : 'user' as const,
      priority: scope === 'project' ? 41 : 31,
    }));
}

async function readSkillRecord(
  discovered: DiscoveredSkillFile,
  runtimePlatform: NodeJS.Platform,
): Promise<SkillRecord | null> {
  try {
    const fileStats = await stat(discovered.filePath);
    if (!fileStats.isFile() || fileStats.size > MAX_SKILL_FILE_BYTES) {
      return null;
    }

    const resolvedPath = await realpath(discovered.filePath).catch(() => path.resolve(discovered.filePath));
    const resolvedSourceRoot = await realpath(discovered.sourceRoot).catch(() => path.resolve(discovered.sourceRoot));
    const trust: AgentSkillTrust = isPathInside(resolvedSourceRoot, resolvedPath) ? 'trusted' : 'linked';
    const parsed = await readSkillFile(resolvedPath);
    const resources = await listSkillResources(path.dirname(resolvedPath));
    const folderName = discovered.legacyCommand
      ? path.basename(resolvedPath, path.extname(resolvedPath))
      : path.basename(path.dirname(resolvedPath));
    const rawName = readString(parsed.frontmatter, 'name') || folderName;
    const name = normalizeSkillName(rawName || folderName);
    if (!name) return null;

    const description = (
      readString(parsed.frontmatter, 'description')
      || firstMarkdownParagraph(parsed.body)
      || `Workflow from ${name}.`
    ).slice(0, 1_536);
    const whenToUse = readString(parsed.frontmatter, 'when_to_use');
    const openAiImplicit = await readOpenAiImplicitPolicy(path.dirname(resolvedPath));
    const disabledModelInvocation = readBoolean(parsed.frontmatter, 'disable-model-invocation', false);
    const userInvocable = readBoolean(parsed.frontmatter, 'user-invocable', true);
    const workspaceRelative = relativeLocation(resolvedPath, process.cwd());
    const displayName = readString(parsed.frontmatter, 'display_name') || humanizeSkillName(name);
    const inferredScope = inferSystemScope(resolvedPath, discovered.scope);
    const platforms = inferSkillPlatforms(resolvedPath, parsed.frontmatter);
    const id = createSkillId(discovered.provider, inferredScope, resolvedPath);

    return {
      filePath: resolvedPath,
      priority: discovered.priority,
      metadata: {
        id,
        name,
        displayName,
        description: whenToUse ? `${description} ${whenToUse}`.slice(0, 1_536) : description,
        provider: discovered.provider,
        scope: inferredScope,
        sourceTier: discovered.sourceTier,
        trust,
        location: workspaceRelative,
        fingerprint: createContentFingerprint(parsed.raw),
        allowImplicitInvocation: trust === 'trusted' && !disabledModelInvocation && openAiImplicit,
        userInvocable,
        argumentHint: readString(parsed.frontmatter, 'argument-hint'),
        context: readString(parsed.frontmatter, 'context') || 'inline',
        agent: readString(parsed.frontmatter, 'agent'),
        allowedTools: readStringList(parsed.frontmatter, 'allowed-tools'),
        disallowedTools: readStringList(parsed.frontmatter, 'disallowed-tools'),
        requiredCapabilities: readSkillCapabilityRequirements(parsed.frontmatter),
        paths: readStringList(parsed.frontmatter, 'paths'),
        legacyCommand: discovered.legacyCommand,
        platforms,
        compatible: platforms.includes(runtimePlatform as AgentSkillPlatform),
        resourceCount: resources.length,
        executableResourceCount: resources.filter(isExecutableSkillResource).length,
        requiresExplicitActivation: trust !== 'trusted',
      },
    };
  } catch {
    return null;
  }
}

async function readSkillFile(filePath: string): Promise<ParsedSkillFile> {
  const raw = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new Error('Skill file is too large.');
  }
  return parseSkillFile(raw);
}

function parseSkillFile(raw: string): ParsedSkillFile {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: normalized.trim(), raw: normalized };
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    return { frontmatter: {}, body: normalized.trim(), raw: normalized };
  }

  const yaml = normalized.slice(4, end);
  const frontmatter: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || '';
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match?.[1]) continue;
    const key = match[1];
    const rawValue = match[2] || '';

    if (rawValue === '|' || rawValue === '>') {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1] || '')) {
        index += 1;
        block.push((lines[index] || '').replace(/^\s{1,4}/, ''));
      }
      frontmatter[key] = rawValue === '>' ? block.join(' ').trim() : block.join('\n').trim();
      continue;
    }

    if (!rawValue) {
      if (/^\s*-\s+/.test(lines[index + 1] || '')) {
        const values: string[] = [];
        while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1] || '')) {
          index += 1;
          values.push(unquote((lines[index] || '').replace(/^\s*-\s+/, '')));
        }
        frontmatter[key] = values;
        continue;
      }
      const continuation: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] || '')) {
        index += 1;
        continuation.push((lines[index] || '').trim());
      }
      frontmatter[key] = continuation.join(' ').trim();
      continue;
    }

    frontmatter[key] = parseScalar(rawValue);
  }

  return {
    frontmatter,
    body: normalized.slice(end + 5).trim(),
    raw: normalized,
  };
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map((item) => unquote(item.trim())).filter(Boolean);
  }
  return unquote(trimmed);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readOpenAiImplicitPolicy(skillDirectory: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(skillDirectory, 'agents', 'openai.yaml'), 'utf8');
    return !/allow_implicit_invocation\s*:\s*false\b/i.test(content);
  } catch {
    return true;
  }
}

function scoreSkill(
  skill: AgentSkillMetadata,
  rawQuery: string,
  queryTokens: string[],
  explicitNames: string[]
): AgentSkillMatch | null {
  const explicit = explicitNames.some((name) => name === skill.name.toLowerCase());
  if (explicit) {
    return {
      skill: { ...skill },
      score: 1,
      explicit: true,
      reason: !skill.compatible
        ? `Навык предназначен для ${formatSkillPlatforms(skill.platforms)} и недоступен в текущей системе.`
        : skill.userInvocable ? 'Явный вызов навыка.' : 'Навык скрыт от ручного вызова.',
      matchedTerms: [skill.name],
    };
  }
  if (!skill.compatible || !skill.allowImplicitInvocation || queryTokens.length === 0) {
    return null;
  }

  const nameTokens = tokenize(`${skill.name} ${skill.displayName}`);
  const descriptionTokens = tokenize(skill.description);
  const nameMatches = intersection(queryTokens, nameTokens)
    .filter((token) => !GENERIC_ACTION_TOKENS.has(token));
  const descriptionMatches = intersection(queryTokens, descriptionTokens);
  const exactNamePhrase = rawQuery.toLowerCase().includes(skill.name.toLowerCase().replace(/-/g, ' '));
  if (nameMatches.length === 0 && descriptionMatches.length === 0 && !exactNamePhrase) {
    return null;
  }

  const uniqueMatched = Array.from(new Set([...nameMatches, ...descriptionMatches]));
  const coverage = uniqueMatched.length / Math.max(1, new Set(queryTokens).size);
  const score = Math.min(
    0.99,
    (exactNamePhrase ? 0.48 : 0)
      + Math.min(0.42, nameMatches.length * 0.2)
      + Math.min(0.4, descriptionMatches.length * 0.12)
      + Math.min(0.18, coverage * 0.18)
      + scopeBoost(skill.scope)
  );
  if (score < 0.12) return null;

  return {
    skill: { ...skill },
    score: Number(score.toFixed(3)),
    explicit: false,
    reason: `Совпали: ${uniqueMatched.slice(0, 4).join(', ')}.`,
    matchedTerms: uniqueMatched.slice(0, 8),
  };
}

function compareMatches(left: AgentSkillMatch, right: AgentSkillMatch): number {
  if (left.explicit !== right.explicit) return left.explicit ? -1 : 1;
  if (right.score !== left.score) return right.score - left.score;
  const scopeDifference = scopeRank(right.skill.scope) - scopeRank(left.skill.scope);
  if (scopeDifference) return scopeDifference;
  return left.skill.name.localeCompare(right.skill.name);
}

function compareSkillRecords(left: SkillRecord, right: SkillRecord): number {
  if (right.priority !== left.priority) return right.priority - left.priority;
  const scopeDifference = scopeRank(right.metadata.scope) - scopeRank(left.metadata.scope);
  if (scopeDifference) return scopeDifference;
  if (left.metadata.compatible !== right.metadata.compatible) return left.metadata.compatible ? -1 : 1;
  const nameDifference = left.metadata.name.localeCompare(right.metadata.name);
  return nameDifference || left.filePath.localeCompare(right.filePath);
}

function deduplicateSkillRecords(records: SkillRecord[]): SkillRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    // A user invokes a skill by name, so duplicate plugin-cache copies with
    // the same name are ambiguous and can inject the same workflow twice.
    // Records are already sorted project -> user -> system, compatible first.
    const key = record.metadata.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenize(value: string): string[] {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[_/\\.:]+/g, ' ')
    .split(/[^\p{L}\p{N}-]+/u)
    .flatMap((token) => token.split('-'))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return Array.from(new Set(base.flatMap((token) => [token, ...(TOKEN_ALIASES[token] || [])])));
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return Array.from(new Set(left.filter((value) => rightSet.has(value))));
}

function readExplicitSkillNames(prompt: string): string[] {
  return Array.from(prompt.matchAll(/(?:^|\s)[$/]([a-z0-9][a-z0-9:_-]{0,127})(?=\s|$)/gi))
    .map((match) => match[1]?.toLowerCase() || '')
    .filter(Boolean);
}

function readInvocationArguments(prompt: string, skillName: string): string {
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = prompt.match(new RegExp(`(?:^|\\s)[$/]${escaped}(?:\\s+([^\\n]+))?`, 'i'));
  return match?.[1]?.trim() || '';
}

function renderSkillInstructions(body: string, args: string, skillDirectory: string): string {
  const positional = args ? args.split(/\s+/) : [];
  let rendered = body
    .replace(/\$ARGUMENTS\b/g, args)
    .replace(/\$\{(?:CLAUDE_)?SKILL_DIR\}/g, skillDirectory);
  for (let index = 0; index < 10; index += 1) {
    rendered = rendered.replace(new RegExp(`\\$${index}\\b`, 'g'), positional[index] || '');
  }
  return rendered.trim();
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(/\s*,\s*|\s+(?=[A-Za-z][A-Za-z(])/).map((item) => item.trim()).filter(Boolean);
}

function readSkillCapabilityRequirements(record: Record<string, unknown>): string[] {
  const declared = [
    ...readStringList(record, 'required-capabilities'),
    ...readStringList(record, 'required_capabilities'),
    ...readStringList(record, 'requires-toolsets'),
    ...readStringList(record, 'requires_toolsets'),
  ];
  return Array.from(new Set(declared
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9._*-]{0,127}$/.test(value))))
    .slice(0, 64);
}

function firstMarkdownParagraph(body: string): string {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#+\s*/gm, '').trim())
    .find((paragraph) => paragraph && !paragraph.startsWith('```')) || '';
}

function normalizeSkillName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

function humanizeSkillName(name: string): string {
  return name.split(/[-_:]+/).filter(Boolean).map(capitalize).join(' ');
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase() || ''}${value.slice(1)}` : '';
}

function createSkillId(provider: AgentSkillProvider, scope: AgentSkillScope, filePath: string): string {
  const digest = createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 12);
  return `${provider}.${scope}.${digest}`;
}

function createContentFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function listSkillResources(skillDirectory: string): Promise<string[]> {
  const resources: string[] = [];
  await walk(skillDirectory, 0);
  return resources.sort((left, right) => left.localeCompare(right));

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_SKILL_RESOURCE_DEPTH || resources.length >= MAX_SKILL_RESOURCES) return;
    const entries = await safeReadDirectory(current);
    if (!entries) return;
    for (const entry of entries) {
      if (resources.length >= MAX_SKILL_RESOURCES) break;
      const lower = entry.name.toLowerCase();
      if (lower === '.git' || lower === 'node_modules' || lower === '__pycache__') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || (depth === 0 && lower === 'skill.md')) continue;
      resources.push(path.relative(skillDirectory, absolute).replace(/\\/g, '/'));
    }
  }
}

function isExecutableSkillResource(resource: string): boolean {
  return /\.(?:bat|cmd|com|exe|js|mjs|cjs|ps1|py|sh|vbs)$/i.test(resource);
}

function relativeLocation(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, '/');
  }
  const homeRelative = path.relative(homedir(), filePath);
  if (homeRelative && !homeRelative.startsWith('..') && !path.isAbsolute(homeRelative)) {
    return `~/${homeRelative.replace(/\\/g, '/')}`;
  }
  return path.basename(filePath);
}

function inferSystemScope(filePath: string, fallback: AgentSkillScope): AgentSkillScope {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/.system/') || normalized.includes('/plugins/cache/') ? 'system' : fallback;
}

function inferSkillPlatforms(
  filePath: string,
  frontmatter: Record<string, unknown>,
): AgentSkillPlatform[] {
  const declared = [
    ...readStringList(frontmatter, 'platforms'),
    ...readStringList(frontmatter, 'os'),
  ]
    .map(normalizeSkillPlatform)
    .filter((value): value is AgentSkillPlatform => value !== null);
  if (declared.length > 0) {
    return Array.from(new Set(declared));
  }

  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/build-macos-apps/') || normalized.includes('/build-ios-apps/')) {
    return ['darwin'];
  }
  return [...ALL_SKILL_PLATFORMS];
}

function normalizeSkillPlatform(value: string): AgentSkillPlatform | null {
  const normalized = value.trim().toLowerCase();
  if (['windows', 'win', 'win32'].includes(normalized)) return 'win32';
  if (['mac', 'macos', 'osx', 'darwin'].includes(normalized)) return 'darwin';
  if (['linux', 'unix'].includes(normalized)) return 'linux';
  return null;
}

function formatSkillPlatforms(platforms: AgentSkillPlatform[]): string {
  return platforms.map((platform) => (
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'
  )).join(', ');
}

function scopeRank(scope: AgentSkillScope): number {
  return scope === 'project' ? 3 : scope === 'user' ? 2 : 1;
}

function scopeBoost(scope: AgentSkillScope): number {
  return scope === 'project' ? 0.06 : scope === 'user' ? 0.03 : 0;
}

async function safeReadDirectory(directory: string): Promise<Dirent<string>[] | null> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}
