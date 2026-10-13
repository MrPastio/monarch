import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveRuntimeLaunch } from './runtime-entry.mjs';
import { renameWithRetry } from './windows-rename.mjs';

/** Build the current source for this launch. Never reuse a possibly stale dist
 * bundle or change the installed runtime selection. One Node process still owns
 * the server and all its children; esbuild is only a development build step. */
export async function prepareDevelopmentRuntime({ workspaceRoot, outputRoot, preferSource,
  buildSource, resolveLaunch = resolveRuntimeLaunch }) {
  const launch = resolveLaunch({ workspaceRoot, preferSource });
  if (!preferSource || launch.kind !== 'tsx') return launch;
  const build = buildSource ?? (await import('esbuild')).build;
  const output = path.join(outputRoot, 'development', 'monarch-server.mjs');
  await mkdir(path.dirname(output), { recursive: true });
  // write:false keeps a failed build from truncating the last successful output.
  // The successful build overwrites it BEFORE the child starts, including source
  // edits made since the previous launch. No mtime-only freshness assumptions.
  const result = await build({ entryPoints: [path.join(workspaceRoot, 'src', 'main.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire as __monarchCreateRequire } from 'node:module'; const require = __monarchCreateRequire(import.meta.url);" },
    external: ['canvas'], legalComments: 'none', sourcemap: false, logLevel: 'warning', write: false });
  const file = result.outputFiles?.find(item => path.resolve(item.path) === path.resolve(output));
  if (!file || file.contents.length === 0) throw Error('development-runtime-build-empty');
  const { writeFile, rename } = await import('node:fs/promises');
  const temporary = output + '.' + process.pid + '.tmp';
  await writeFile(temporary, file.contents);
  await renameWithRetry(temporary, output);
  return { kind: 'source-bundle', entryPath: output, args: [output] };
}

/** The MAX host runs in the main process from dist/astra-max-electron.mjs.
 * A source launch rebuilt the runtime but not this bundle, so MAX fixes did not
 * reach a development run until someone remembered build:runtime (live: a
 * whole day of provider fixes tested against yesterday's bundle). Built the same
 * way as the runtime: in memory first, then one atomic replace. */
export async function prepareDevelopmentMaxBundle({ workspaceRoot, preferSource, buildSource }) {
  if (!preferSource) return false;
  const build = buildSource ?? (await import('esbuild')).build;
  const output = path.join(workspaceRoot, 'dist', 'astra-max-electron.mjs');
  await mkdir(path.dirname(output), { recursive: true });
  const result = await build({ entryPoints: [path.join(workspaceRoot, 'src', 'agent-v3', 'max-electron-entry.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire as __monarchCreateRequire } from 'node:module'; const require = __monarchCreateRequire(import.meta.url);" },
    legalComments: 'none', sourcemap: false, logLevel: 'warning', write: false });
  const file = result.outputFiles?.find(item => path.resolve(item.path) === path.resolve(output));
  if (!file || file.contents.length === 0) throw Error('development-max-build-empty');
  const { writeFile } = await import('node:fs/promises');
  const { renameWithRetry } = await import('./windows-rename.mjs');
  const temporary = output + '.' + process.pid + '.tmp';
  await writeFile(temporary, file.contents);
  await renameWithRetry(temporary, output);
  return true;
}
