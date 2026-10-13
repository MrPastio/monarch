import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionRoot = path.join(projectRoot, 'runtime', 'astra-max-preview', 'version');
const outputPath = path.join(versionRoot, 'dist', 'astra-max-electron.mjs');
await mkdir(path.dirname(outputPath), { recursive: true });
await build({
  entryPoints: [path.join(projectRoot, 'src', 'agent-v3', 'max-electron-entry.ts')],
  outfile: outputPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import { createRequire as __monarchCreateRequire } from 'node:module'; const require = __monarchCreateRequire(import.meta.url);",
  },
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
});
const output = await stat(outputPath);
if (!output.isFile() || output.size < 50_000 || output.size > 2 * 1024 * 1024) {
  throw Error('astra-max-preview-build:output');
}
console.log(`Built isolated Astra MAX source preview: ${outputPath} (${output.size} bytes)`);
