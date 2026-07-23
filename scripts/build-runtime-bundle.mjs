import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const execFileAsync = promisify(execFile);

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(projectRoot, 'src', 'main.ts')],
  outfile: outputPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // esbuild wraps CommonJS dependencies with a dynamic require shim. An ESM
  // bundle has no native `require`, so Node built-ins used by packages such as
  // undici must be resolved through createRequire at runtime.
  banner: {
    js: "import { createRequire as __monarchCreateRequire } from 'node:module'; const require = __monarchCreateRequire(import.meta.url);",
  },
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

const { stdout } = await execFileAsync(process.execPath, [outputPath, 'help'], {
  cwd: projectRoot,
  timeout: 30_000,
  windowsHide: true,
  maxBuffer: 1024 * 1024,
});
if (!stdout.includes('Monarch commands:')) {
  throw new Error(`Monarch runtime bundle did not pass its executable smoke test: ${outputPath}`);
}

console.log(`Built Monarch runtime bundle: ${outputPath} (${output.size} bytes)`);
