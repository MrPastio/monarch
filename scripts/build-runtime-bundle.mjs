import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputPath = process.env.MONARCH_RUNTIME_BUNDLE_OUTPUT
  ? path.resolve(process.env.MONARCH_RUNTIME_BUNDLE_OUTPUT)
  : path.join(projectRoot, 'dist', 'monarch-server.mjs');
const outputDirectory = path.dirname(outputPath);

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(projectRoot, 'src', 'main.ts')],
  outfile: outputPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Native Node addons cannot be embedded into a single JavaScript bundle.
  // The offline payload copies canvas beside the bundle so Node can load its
  // platform-specific binary at runtime.
  external: ['canvas'],
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
});

const output = await stat(outputPath);
if (!output.isFile() || output.size < 100_000) {
  throw new Error(`Monarch runtime bundle is invalid: ${outputPath}`);
}

console.log(`Built Monarch runtime bundle: ${outputPath} (${output.size} bytes)`);
