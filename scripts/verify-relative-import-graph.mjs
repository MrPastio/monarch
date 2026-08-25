import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2).map((entry) => path.resolve(entry));
if (roots.length === 0) {
  process.stderr.write('Usage: node scripts/verify-relative-import-graph.mjs <root> [...root]\n');
  process.exit(2);
}

const sourceExtensions = new Set(['.js', '.mjs', '.cjs']);
const importPatterns = [
  /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
];
const missing = [];
let checkedFiles = 0;
let checkedImports = 0;

function walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) verifyFile(target);
  }
}

function verifyFile(filePath) {
  checkedFiles += 1;
  const source = readFileSync(filePath, 'utf8');
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      checkedImports += 1;
      const cleanSpecifier = specifier.split(/[?#]/u, 1)[0];
      const resolved = path.resolve(path.dirname(filePath), cleanSpecifier);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        missing.push(`${filePath} -> ${specifier}`);
      }
    }
  }
}

for (const root of roots) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    missing.push(`missing root: ${root}`);
    continue;
  }
  walk(root);
}

if (missing.length > 0) {
  process.stderr.write(`Relative import graph is incomplete (${missing.length} missing):\n${missing.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`Relative import graph verified: ${checkedFiles} files, ${checkedImports} relative imports.\n`);
