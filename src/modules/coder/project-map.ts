import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readDurableJson, writeDurableJson } from '../../core/durable-json';

/**
 * Coder Memory, layer 1: a map of the project's architecture.
 *
 * Deterministic and cheap: languages, top-level modules, symbols and imports
 * by per-language patterns, build/test commands from manifests, entry points
 * and the project's own rules (AGENTS.md, CLAUDE.md, README). A rescan reuses
 * every file whose size and modification time did not change, so starting a
 * run on a known project costs one directory walk. The map lives in
 * Monarch's sealed state, never inside the project folder.
 */

export const PROJECT_MAP_SCHEMA_VERSION = 1 as const;
const MAX_LISTED_FILES = 20_000;
const MAX_ANALYZED_BYTES = 256 * 1024;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_IMPORTS_PER_FILE = 40;
const SCAN_TIME_BUDGET_MS = 6_000;
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md', 'README.md'];

const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.agents', '.claude', '.codex', '.gemini', '.monarch', '.venv', 'venv', '.idea', '.vscode',
  '.next', '.nuxt', '.turbo', '.cache', '.pytest_cache', '.mypy_cache', '__pycache__', 'node_modules',
  'build', 'coverage', 'dist', 'out', 'target', 'vendor', 'bin', 'obj',
]);

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.rb': 'ruby', '.php': 'php', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.vue': 'vue', '.svelte': 'svelte', '.css': 'css', '.scss': 'css', '.html': 'html', '.sql': 'sql',
  '.sh': 'shell', '.ps1': 'powershell', '.md': 'markdown', '.json': 'json', '.toml': 'toml', '.yml': 'yaml', '.yaml': 'yaml',
};
const CODE_LANGUAGES = new Set(['typescript', 'javascript', 'python', 'csharp', 'go', 'rust', 'java', 'kotlin',
  'swift', 'ruby', 'php', 'c', 'cpp', 'vue', 'svelte']);

export interface ProjectMapFile {
  path: string;
  size: number;
  mtimeMs: number;
  sha: string;
  language: string;
  symbols: string[];
  imports: string[];
}

export interface ProjectMapModule {
  path: string;
  files: number;
  language: string;
  symbols: string[];
}

export interface ProjectMap {
  schemaVersion: typeof PROJECT_MAP_SCHEMA_VERSION;
  projectId: string;
  root: string;
  scannedAt: string;
  truncated: boolean;
  files: ProjectMapFile[];
  stack: string[];
  commands: Array<{ name: string; command: string }>;
  dependencies: string[];
  entrypoints: string[];
  modules: ProjectMapModule[];
  rules: Array<{ source: string; text: string }>;
}

export interface ProjectScanResult {
  map: ProjectMap;
  changed: string[];
  removed: string[];
}

/** Sealed per-project map files under Monarch state. */
export class ProjectMapStore {
  constructor(private readonly mapsRoot: string) {}

  private file(projectId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(projectId)) throw new Error('Invalid Coder project id.');
    return path.join(this.mapsRoot, `${projectId.replace(/:/gu, '_')}.json`);
  }

  read(projectId: string): ProjectMap | null {
    const value = readDurableJson<ProjectMap>(this.file(projectId), { sensitive: { storeId: 'coder-maps' } });
    return value && value.schemaVersion === PROJECT_MAP_SCHEMA_VERSION && value.projectId === projectId ? value : null;
  }

  write(map: ProjectMap): void {
    writeDurableJson(this.file(map.projectId), map, { sensitive: { storeId: 'coder-maps' } });
  }
}

export async function scanProject(
  projectId: string,
  root: string,
  previous: ProjectMap | null,
  options: { signal?: AbortSignal; timeBudgetMs?: number; now?: () => number } = {},
): Promise<ProjectScanResult> {
  const now = options.now || Date.now;
  const deadline = now() + (options.timeBudgetMs ?? SCAN_TIME_BUDGET_MS);
  const known = new Map((previous?.root === root ? previous.files : []).map((file) => [file.path, file]));
  const ignore = await readGitignore(root);
  const files: ProjectMapFile[] = [];
  const changed: string[] = [];
  let truncated = false;
  const queue = [''];
  while (queue.length) {
    options.signal?.throwIfAborted();
    if (now() > deadline || files.length >= MAX_LISTED_FILES) { truncated = true; break; }
    const relativeDirectory = queue.shift()!;
    let entries;
    try { entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true }); } catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase()) && !ignore(relative, true)) queue.push(relative);
        continue;
      }
      if (!entry.isFile() || ignore(relative, false)) continue;
      if (files.length >= MAX_LISTED_FILES) { truncated = true; break; }
      const absolute = path.join(root, relative);
      let info;
      try { info = await stat(absolute); } catch { continue; }
      const prior = known.get(relative);
      if (prior && prior.size === info.size && prior.mtimeMs === Math.trunc(info.mtimeMs)) {
        files.push(prior);
        continue;
      }
      files.push(await analyzeFile(absolute, relative, info.size, Math.trunc(info.mtimeMs)));
      changed.push(relative);
    }
  }
  const present = new Set(files.map((file) => file.path));
  // A truncated walk did not see everything; it must not forget what it missed.
  const removed = truncated ? [] : [...known.keys()].filter((key) => !present.has(key));
  if (truncated) for (const [key, file] of known) if (!present.has(key)) files.push(file);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifests = await readManifests(root, files);
  const map: ProjectMap = {
    schemaVersion: PROJECT_MAP_SCHEMA_VERSION,
    projectId,
    root,
    scannedAt: new Date(now()).toISOString(),
    truncated,
    files,
    stack: detectStack(files, manifests.dependencies),
    commands: manifests.commands,
    dependencies: manifests.dependencies.slice(0, 40),
    entrypoints: detectEntrypoints(files, manifests.entrypoints),
    modules: summarizeModules(files),
    rules: await readRules(root),
  };
  return { map, changed, removed };
}

async function analyzeFile(absolute: string, relative: string, size: number, mtimeMs: number): Promise<ProjectMapFile> {
  const language = LANGUAGES[path.extname(relative).toLowerCase()] || 'other';
  const base: ProjectMapFile = { path: relative, size, mtimeMs, sha: '', language, symbols: [], imports: [] };
  if (size > MAX_ANALYZED_BYTES) return base;
  let buffer: Buffer;
  try { buffer = await readFile(absolute); } catch { return base; }
  base.sha = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  if (!CODE_LANGUAGES.has(language) || buffer.subarray(0, 4096).includes(0)) return base;
  const text = buffer.toString('utf8');
  base.symbols = extractSymbols(language, text);
  base.imports = extractImports(language, text, relative);
  return base;
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gmu,
    /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)/gmu,
  ],
  python: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/gmu],
  csharp: [/\b(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/gmu,
    /^\s*public\s+(?:static\s+|async\s+|override\s+|virtual\s+)*[\w<>[\],?\s]+?\s+([A-Z]\w*)\s*\(/gmu],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^type\s+([A-Za-z_]\w*)/gmu],
  rust: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)/gmu],
  java: [/\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gmu],
  kotlin: [/\b(?:class|interface|object|fun)\s+([A-Za-z_]\w*)/gmu],
};
SYMBOL_PATTERNS.javascript = SYMBOL_PATTERNS.typescript!;
SYMBOL_PATTERNS.vue = SYMBOL_PATTERNS.typescript!;
SYMBOL_PATTERNS.svelte = SYMBOL_PATTERNS.typescript!;

export function extractSymbols(language: string, text: string): string[] {
  const found: string[] = [];
  for (const pattern of SYMBOL_PATTERNS[language] || []) {
    for (const match of text.matchAll(pattern)) {
      const name = match.slice(1).find(Boolean);
      if (name && !found.includes(name)) found.push(name);
      if (found.length >= MAX_SYMBOLS_PER_FILE) return found;
    }
  }
  return found;
}

export function extractImports(language: string, text: string, relative: string): string[] {
  const raw: string[] = [];
  if (['typescript', 'javascript', 'vue', 'svelte'].includes(language)) {
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]/gmu)) raw.push(match[1]!);
  } else if (language === 'python') {
    for (const match of text.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+))/gmu)) raw.push((match[1] || match[2])!);
  } else if (language === 'go') {
    for (const match of text.matchAll(/^\s*(?:import\s+)?"([\w./-]+)"/gmu)) raw.push(match[1]!);
  } else if (language === 'rust') {
    for (const match of text.matchAll(/^\s*use\s+([\w:]+)/gmu)) raw.push(match[1]!);
  } else if (language === 'csharp') {
    for (const match of text.matchAll(/^\s*using\s+([\w.]+)\s*;/gmu)) raw.push(match[1]!);
  }
  const directory = path.posix.dirname(relative);
  const out: string[] = [];
  for (const entry of raw) {
    const value = entry.startsWith('.') && !entry.startsWith('..') && language !== 'python' || entry.startsWith('../')
      ? path.posix.normalize(path.posix.join(directory, entry))
      : entry;
    if (!out.includes(value)) out.push(value);
    if (out.length >= MAX_IMPORTS_PER_FILE) break;
  }
  return out;
}

async function readGitignore(root: string): Promise<(relative: string, directory: boolean) => boolean> {
  let text = '';
  try { text = await readFile(path.join(root, '.gitignore'), 'utf8'); } catch { /* no rules */ }
  const rules = text.split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .slice(0, 400)
    .map((line) => {
      const directoryOnly = line.endsWith('/');
      const anchored = line.startsWith('/');
      const body = line.replace(/^\/+|\/+$/gu, '');
      const pattern = new RegExp('^' + body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*') + '$', 'u');
      return { pattern, directoryOnly, anchored, hasSlash: body.includes('/') };
    });
  return (relative, directory) => rules.some((rule) => {
    if (rule.directoryOnly && !directory) return false;
    if (rule.anchored || rule.hasSlash) return rule.pattern.test(relative);
    return rule.pattern.test(relative.split('/').pop()!);
  });
}

async function readText(file: string, limit: number): Promise<string> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return '';
    return (await readFile(file, 'utf8')).slice(0, limit);
  } catch { return ''; }
}

async function readManifests(root: string, files: ProjectMapFile[]) {
  const commands: Array<{ name: string; command: string }> = [];
  const dependencies: string[] = [];
  const entrypoints: string[] = [];
  const has = new Set(files.map((file) => file.path));
  const packageText = has.has('package.json') ? await readText(path.join(root, 'package.json'), 200_000) : '';
  if (packageText) {
    try {
      const manifest = JSON.parse(packageText) as Record<string, unknown>;
      const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts as Record<string, unknown> : {};
      const runner = has.has('pnpm-lock.yaml') ? 'pnpm' : has.has('yarn.lock') ? 'yarn' : has.has('bun.lockb') ? 'bun' : 'npm';
      for (const name of ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'check', 'format']) {
        if (typeof scripts[name] === 'string') commands.push({ name, command: name === 'test' && runner === 'npm' ? 'npm test' : `${runner} run ${name}` });
      }
      for (const key of ['dependencies', 'devDependencies']) {
        const block = manifest[key];
        if (block && typeof block === 'object') dependencies.push(...Object.keys(block as object));
      }
      for (const key of ['main', 'module']) if (typeof manifest[key] === 'string') entrypoints.push(String(manifest[key]).replace(/^\.\//u, ''));
      if (typeof manifest.bin === 'string') entrypoints.push(manifest.bin.replace(/^\.\//u, ''));
    } catch { /* malformed package.json: nothing to learn from it */ }
  }
  const pyproject = has.has('pyproject.toml') ? await readText(path.join(root, 'pyproject.toml'), 100_000) : '';
  const requirements = has.has('requirements.txt') ? await readText(path.join(root, 'requirements.txt'), 50_000) : '';
  for (const match of `${pyproject}\n${requirements}`.matchAll(/^\s*"?([A-Za-z][\w.-]+)\s*(?:[<>=~!;\[]|"|,|$)/gmu)) {
    const name = match[1]!.toLowerCase();
    if (!['name', 'version', 'description', 'readme', 'authors', 'requires-python', 'license', 'dependencies', 'build-backend', 'requires'].includes(name)) dependencies.push(name);
  }
  if (pyproject || requirements || files.some((file) => file.language === 'python')) {
    if (files.some((file) => /(^|\/)(tests?|test_[^/]+\.py)/u.test(file.path))) commands.push({ name: 'test', command: 'python -m pytest' });
  }
  if (has.has('Cargo.toml')) commands.push({ name: 'build', command: 'cargo build' }, { name: 'test', command: 'cargo test' });
  if (has.has('go.mod')) commands.push({ name: 'build', command: 'go build ./...' }, { name: 'test', command: 'go test ./...' });
  if (files.some((file) => file.path.endsWith('.csproj') || file.path.endsWith('.sln'))) {
    commands.push({ name: 'build', command: 'dotnet build' }, { name: 'test', command: 'dotnet test' });
  }
  const unique = commands.filter((entry, index) => commands.findIndex((other) => other.name === entry.name) === index);
  return { commands: unique, dependencies: [...new Set(dependencies)], entrypoints };
}

const FRAMEWORKS: Array<[string, RegExp]> = [
  ['React', /^react$/u], ['Vue', /^vue$/u], ['Svelte', /^svelte$/u], ['Next.js', /^next$/u], ['Electron', /^electron$/u],
  ['Vite', /^vite$/u], ['Express', /^express$/u], ['Fastify', /^fastify$/u], ['NestJS', /^@nestjs\/core$/u],
  ['Vitest', /^vitest$/u], ['Jest', /^jest$/u], ['FastAPI', /^fastapi$/u], ['Django', /^django$/u], ['Flask', /^flask$/u],
  ['pytest', /^pytest$/u], ['PyTorch', /^torch$/u], ['Tailwind', /^tailwindcss$/u], ['Prisma', /^prisma$|^@prisma\/client$/u],
];

function detectStack(files: ProjectMapFile[], dependencies: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) if (CODE_LANGUAGES.has(file.language)) counts.set(file.language, (counts.get(file.language) || 0) + 1);
  const languages = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([language]) => LANGUAGE_TITLES[language] || language);
  const frameworks = FRAMEWORKS.filter(([, pattern]) => dependencies.some((dependency) => pattern.test(dependency.toLowerCase()))).map(([title]) => title);
  return [...languages, ...frameworks];
}

const LANGUAGE_TITLES: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', csharp: 'C#', go: 'Go', rust: 'Rust',
  java: 'Java', kotlin: 'Kotlin', swift: 'Swift', ruby: 'Ruby', php: 'PHP', c: 'C', cpp: 'C++', vue: 'Vue', svelte: 'Svelte',
};

function detectEntrypoints(files: ProjectMapFile[], declared: string[]): string[] {
  const has = new Set(files.map((file) => file.path));
  const conventional = ['main.py', 'app.py', 'manage.py', '__main__.py', 'src/main.ts', 'src/index.ts', 'src/main.tsx',
    'src/index.tsx', 'src/main.js', 'src/index.js', 'index.js', 'index.ts', 'main.go', 'cmd/main.go', 'src/main.rs', 'Program.cs'];
  return [...new Set([...declared, ...conventional].filter((entry) => has.has(entry)))].slice(0, 8);
}

function summarizeModules(files: ProjectMapFile[]): ProjectMapModule[] {
  const groups = new Map<string, ProjectMapFile[]>();
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.length < 2) continue;
    // src/ and packages/ hold the real modules one level deeper.
    const key = ['src', 'lib', 'packages', 'apps', 'app'].includes(parts[0]!) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
    groups.set(key, [...(groups.get(key) || []), file]);
  }
  return [...groups.entries()]
    .map(([modulePath, entries]) => {
      const code = entries.filter((entry) => CODE_LANGUAGES.has(entry.language));
      const languages = new Map<string, number>();
      for (const entry of code) languages.set(entry.language, (languages.get(entry.language) || 0) + 1);
      const language = [...languages.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || entries[0]!.language;
      return { path: modulePath, files: entries.length, language, symbols: code.flatMap((entry) => entry.symbols).slice(0, 8) };
    })
    .sort((left, right) => right.files - left.files)
    .slice(0, 24);
}

async function readRules(root: string): Promise<Array<{ source: string; text: string }>> {
  const rules: Array<{ source: string; text: string }> = [];
  for (const name of RULE_FILES) {
    const text = (await readText(path.join(root, name), name === 'README.md' ? 1_500 : 4_000)).trim();
    if (text) rules.push({ source: name, text });
  }
  return rules;
}

function terms(query: string): string[] {
  return [...new Set(String(query || '')
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length >= 2))].slice(0, 12);
}

export interface ProjectMapHit {
  path: string;
  score: number;
  symbols: string[];
  importedBy: string[];
}

/** "Where is X defined", "who imports Y", "files about Z". */
export function searchProjectMap(map: ProjectMap, query: string, limit = 12): ProjectMapHit[] {
  const wanted = terms(query);
  const exact = String(query || '').trim();
  if (!wanted.length && !exact) return [];
  const hits: ProjectMapHit[] = [];
  for (const file of map.files) {
    const pathTerms = terms(file.path);
    let score = 0;
    const symbols: string[] = [];
    for (const symbol of file.symbols) {
      if (symbol === exact) { score += 10; symbols.push(symbol); continue; }
      const symbolTerms = terms(symbol);
      const shared = wanted.filter((term) => symbolTerms.includes(term)).length;
      if (shared) { score += 2 * shared; symbols.push(symbol); }
    }
    score += 3 * wanted.filter((term) => pathTerms.includes(term)).length;
    if (exact && file.path.endsWith(exact)) score += 8;
    if (score > 0) hits.push({ path: file.path, score, symbols: symbols.slice(0, 8), importedBy: [] });
  }
  hits.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const top = hits.slice(0, limit);
  for (const hit of top.slice(0, 5)) hit.importedBy = importersOf(map, hit.path).slice(0, 8);
  return top;
}

export function importersOf(map: ProjectMap, target: string): string[] {
  const stem = target.replace(/\.(?:[cm]?[jt]sx?|py)$/u, '').replace(/\/index$/u, '');
  return map.files.filter((file) => file.imports.some((entry) => {
    const normalized = entry.replace(/\.(?:[cm]?[jt]sx?|py)$/u, '').replace(/\/index$/u, '');
    return normalized === stem || normalized.replace(/\./gu, '/') === stem;
  })).map((file) => file.path);
}

export interface ProjectKnowledge {
  id: string;
  text: string;
  category: string;
  type?: string;
  relatedFiles?: string[];
}

/** Knowledge is linked to "path@sha"; a changed file makes it possibly stale. */
export function isKnowledgeStale(map: ProjectMap, knowledge: ProjectKnowledge): boolean {
  const byPath = new Map(map.files.map((file) => [file.path, file.sha]));
  return (knowledge.relatedFiles || []).some((entry) => {
    const at = entry.lastIndexOf('@');
    if (at <= 0) return false;
    const current = byPath.get(entry.slice(0, at));
    return current !== undefined && current !== entry.slice(at + 1);
  });
}

export function fileFingerprint(map: ProjectMap | null, relative: string): string {
  const sha = map?.files.find((file) => file.path === relative)?.sha;
  return sha ? `${relative}@${sha}` : relative;
}

/** Budget by the model's context: a 4K local model gets the essentials. */
export function projectBriefBudget(model: string): number {
  if (/^max-|^max-cloud:/u.test(model)) return 8_000;
  if (/qwen3-coder|deepseek/u.test(model)) return 4_000;
  return 1_400;
}

export function renderProjectBrief(map: ProjectMap, knowledge: ProjectKnowledge[], goal: string, budget: number): string {
  const sections: string[] = [];
  const name = path.basename(map.root);
  sections.push(`Проект «${name}»${map.stack.length ? ` — ${map.stack.join(', ')}` : ''}. Файлов: ${map.files.length}${map.truncated ? '+' : ''}.`);
  sections.push('Память проекта: coder.memory.search — карта и знания проекта; coder.code.search — поиск по коду; '
    + 'coder.memory.note — записать решение, соглашение или ловушку, чтобы следующая задача о них знала.');
  const rules = knowledge.filter((entry) => entry.category === 'rule');
  const facts = knowledge.filter((entry) => entry.category !== 'rule');
  if (rules.length) sections.push('Правила проекта (от владельца):\n' + rules.map((entry) => `- ${entry.text}`).join('\n'));
  if (map.commands.length) sections.push('Команды: ' + map.commands.map((entry) => `${entry.name}: \`${entry.command}\``).join('; '));
  if (map.entrypoints.length) sections.push('Точки входа: ' + map.entrypoints.join(', '));
  const relevant = searchProjectMap(map, goal, 6).filter((hit) => hit.score >= 3);
  if (relevant.length) {
    sections.push('Вероятно относится к задаче:\n' + relevant.map((hit) =>
      `- ${hit.path}${hit.symbols.length ? ` (${hit.symbols.slice(0, 5).join(', ')})` : ''}`).join('\n'));
  }
  if (facts.length) {
    sections.push('Что известно по прошлым задачам:\n' + facts.map((entry) =>
      `- ${entry.text}${isKnowledgeStale(map, entry) ? ' (файлы с тех пор менялись — проверь)' : ''}`).join('\n'));
  }
  if (map.modules.length) {
    sections.push('Структура: ' + map.modules.slice(0, 10).map((module) => `${module.path}/ (${module.files})`).join(', '));
  }
  for (const rule of map.rules) {
    sections.push(`Из ${rule.source}:\n${rule.text}`);
  }
  let text = '';
  for (const section of sections) {
    const candidate = text ? `${text}\n\n${section}` : section;
    if (candidate.length <= budget) { text = candidate; continue; }
    const room = budget - text.length - 3;
    if (room > 120) text = `${text}\n\n${section.slice(0, room - 1)}…`;
    break;
  }
  return text;
}
