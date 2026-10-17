import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoderModule, type CoderMemoryPort } from '../../src/modules/coder';
import {
  extractImports, extractSymbols, importersOf, isKnowledgeStale, projectBriefBudget, renderProjectBrief,
  scanProject, searchProjectMap,
} from '../../src/modules/coder/project-map';

const context = { emit: async () => undefined, audit: async () => undefined } as any;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'monarch-project-map-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'demo', main: './src/index.ts', scripts: { build: 'tsc', test: 'vitest run' },
      dependencies: { react: '^18.0.0' }, devDependencies: { vitest: '^4.0.0' } }),
    'AGENTS.md': '# Rules\nNever edit generated files. Run npm test before a commit.',
    '.gitignore': 'secret.txt\ngenerated/\n',
    'secret.txt': 'should not be mapped',
    'generated/out.ts': 'export const ignored = 1;',
    'node_modules/pkg/index.js': 'module.exports = 1;',
    'src/index.ts': "import { createStore } from './store/memory-store';\nexport function main() { return createStore(); }\n",
    'src/store/memory-store.ts': 'export class MemoryStore {}\nexport function createStore() { return new MemoryStore(); }\n',
    'src/ui/panel.tsx': "import { MemoryStore } from '../store/memory-store';\nexport const Panel = () => null;\n",
    'tools/sync.py': 'import json\nfrom .helpers import load\n\nclass Syncer:\n    pass\n\ndef run_sync():\n    pass\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content, 'utf8');
  }
  return root;
}

describe('Coder Memory: project map', () => {
  it('maps symbols, imports, commands, stack, rules and respects .gitignore', async () => {
    const root = await fixture();
    try {
      const { map } = await scanProject('project_demo', root, null);
      const paths = map.files.map((file) => file.path);
      expect(paths).toContain('src/store/memory-store.ts');
      expect(paths).not.toContain('secret.txt');
      expect(paths.some((entry) => entry.startsWith('generated/') || entry.startsWith('node_modules/'))).toBe(false);
      expect(map.files.find((file) => file.path === 'src/store/memory-store.ts')?.symbols).toEqual(['MemoryStore', 'createStore']);
      expect(map.files.find((file) => file.path === 'src/index.ts')?.imports).toEqual(['src/store/memory-store']);
      expect(map.files.find((file) => file.path === 'tools/sync.py')?.symbols).toEqual(['Syncer', 'run_sync']);
      expect(map.commands).toEqual(expect.arrayContaining([{ name: 'build', command: 'npm run build' }, { name: 'test', command: 'npm test' }]));
      expect(map.stack).toEqual(expect.arrayContaining(['TypeScript', 'React', 'Vitest']));
      expect(map.entrypoints).toContain('src/index.ts');
      expect(map.rules[0]).toMatchObject({ source: 'AGENTS.md' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rescans incrementally: unchanged files are reused, edits and deletions are noticed', async () => {
    const root = await fixture();
    try {
      const first = await scanProject('project_demo', root, null);
      expect(first.changed.length).toBe(first.map.files.length);
      const again = await scanProject('project_demo', root, first.map);
      expect(again.changed).toEqual([]);
      const target = path.join(root, 'src/store/memory-store.ts');
      await writeFile(target, 'export class MemoryStore {}\nexport function openStore() {}\n', 'utf8');
      await utimes(target, new Date(), new Date(Date.now() + 5_000));
      await rm(path.join(root, 'src/ui/panel.tsx'));
      const third = await scanProject('project_demo', root, again.map);
      expect(third.changed).toEqual(['src/store/memory-store.ts']);
      expect(third.removed).toEqual(['src/ui/panel.tsx']);
      expect(third.map.files.find((file) => file.path === 'src/store/memory-store.ts')?.symbols).toContain('openStore');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers "where is X" and "who imports Y"', async () => {
    const root = await fixture();
    try {
      const { map } = await scanProject('project_demo', root, null);
      const hits = searchProjectMap(map, 'MemoryStore');
      expect(hits[0]).toMatchObject({ path: 'src/store/memory-store.ts' });
      expect(hits[0]!.importedBy.sort()).toEqual(['src/index.ts', 'src/ui/panel.tsx']);
      expect(importersOf(map, 'src/store/memory-store.ts')).toHaveLength(2);
      expect(searchProjectMap(map, 'совсем другое')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks knowledge stale when a linked file changed', async () => {
    const root = await fixture();
    try {
      const { map } = await scanProject('project_demo', root, null);
      const sha = map.files.find((file) => file.path === 'src/index.ts')!.sha;
      expect(isKnowledgeStale(map, { id: '1', text: 'x', category: 'project', relatedFiles: [`src/index.ts@${sha}`] })).toBe(false);
      expect(isKnowledgeStale(map, { id: '2', text: 'x', category: 'project', relatedFiles: ['src/index.ts@0000000000000000'] })).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fits the brief into the model budget, owner rules and tools first', async () => {
    const root = await fixture();
    try {
      const { map } = await scanProject('project_demo', root, null);
      const knowledge = [
        { id: 'r', text: 'Комментарии в коде — по-русски', category: 'rule' },
        { id: 'd', text: 'Хранилище переведено на SQLite', category: 'project', relatedFiles: ['src/store/memory-store.ts@stale000'] },
      ];
      const small = renderProjectBrief(map, knowledge, 'почини MemoryStore', projectBriefBudget('gemma4-balanced'));
      expect(small.length).toBeLessThanOrEqual(1_400);
      expect(small).toContain('coder.memory.search');
      expect(small).toContain('Комментарии в коде — по-русски');
      const large = renderProjectBrief(map, knowledge, 'почини MemoryStore', projectBriefBudget('max-gpt-oss-120b'));
      expect(large).toContain('src/store/memory-store.ts (MemoryStore');
      expect(large).toContain('(файлы с тех пор менялись — проверь)');
      expect(large).toContain('Из AGENTS.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts per-language symbols and imports', () => {
    expect(extractSymbols('go', 'func (s *Server) Start() {}\ntype Config struct{}')).toEqual(['Start', 'Config']);
    expect(extractSymbols('rust', 'pub fn run() {}\npub struct App;')).toEqual(['run', 'App']);
    expect(extractSymbols('csharp', 'public class Launcher {\n  public static void Main(string[] args) {}\n}')).toEqual(['Launcher', 'Main']);
    expect(extractImports('python', 'from app.core import x\nimport os.path', 'pkg/mod.py')).toEqual(['app.core', 'os.path']);
  });
});

describe('Coder Memory: tools', () => {
  async function moduleWithProject() {
    const monarchRoot = await mkdtemp(path.join(tmpdir(), 'monarch-coder-memory-'));
    const module = new CoderModule({ monarchRoot });
    await module.activate(context);
    const project = (await module.executeCapability({ capabilityId: 'coder.projects.create', input: { name: 'Memory Demo' } } as any, context)).output as any;
    await mkdir(path.join(project.root, 'src'), { recursive: true });
    await writeFile(path.join(project.root, 'src', 'cache.ts'), 'export function warmCache() {\n  // TODO: bound the cache\n}\n', 'utf8');
    await mkdir(path.join(project.root, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(project.root, 'node_modules', 'x', 'index.js'), '// TODO: not ours', 'utf8');
    return { monarchRoot, module, project };
  }
  const run = (module: CoderModule, capabilityId: string, input: unknown) =>
    module.executeCapability({ capabilityId, input } as any, context);

  it('searches code text, skipping dependencies, and refuses runaway patterns', async () => {
    const { monarchRoot, module, project } = await moduleWithProject();
    try {
      const found = await run(module, 'coder.code.search', { projectId: project.id, query: 'TODO' });
      expect((found.output as any).matches).toEqual([{ path: 'src/cache.ts', line: 2, text: '// TODO: bound the cache' }]);
      const regex = await run(module, 'coder.code.search', { projectId: project.id, query: 'warm\\w+', regex: true });
      expect((regex.output as any).matches[0].line).toBe(1);
      const runaway = await run(module, 'coder.code.search', { projectId: project.id, query: '(a+)+$', regex: true });
      expect(runaway.ok).toBe(false);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });

  it('searches the map and notes through the attached memory port with file fingerprints', async () => {
    const { monarchRoot, module, project } = await moduleWithProject();
    const notes: unknown[] = [];
    const port: CoderMemoryPort = {
      recall: async () => [{ id: 'k1', text: 'Кэш ограничен 100 записями', category: 'project', relatedFiles: ['src/cache.ts@deadbeefdeadbeef'] }],
      note: async (_projectId, input) => { notes.push(input); return { id: 'k2', action: 'created' }; },
    };
    try {
      const unavailable = await run(module, 'coder.memory.note', { projectId: project.id, kind: 'decision', text: 'Кэш ограничен сотней записей' });
      expect(unavailable.ok).toBe(false);
      module.attachMemory(port);
      const search = await run(module, 'coder.memory.search', { projectId: project.id, query: 'warmCache' });
      expect((search.output as any).files[0]).toMatchObject({ path: 'src/cache.ts' });
      expect((search.output as any).knowledge[0]).toMatchObject({ id: 'k1', stale: true });
      const saved = await run(module, 'coder.memory.note', {
        projectId: project.id, kind: 'pitfall', text: 'warmCache нельзя звать до загрузки настроек', files: ['src/cache.ts', '../../escape.txt'],
      });
      expect(saved.ok).toBe(true);
      const sha = module.readProjectMap(project.id)!.files.find((file) => file.path === 'src/cache.ts')!.sha;
      expect(notes[0]).toMatchObject({ kind: 'pitfall', relatedFiles: [`src/cache.ts@${sha}`], origin: 'learned', source: 'coder-agent' });
      const bad = await run(module, 'coder.memory.note', { projectId: project.id, kind: 'gossip', text: 'something long enough' });
      expect(bad.ok).toBe(false);
    } finally {
      await rm(monarchRoot, { recursive: true, force: true });
    }
  });
});
