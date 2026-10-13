// Electron fuses for the packaged Monarch runtime (Monarch Security, F-06).
// Fuses are bits compiled into electron.exe; flipping them turns off ways to
// run arbitrary code through the Monarch executable:
//   RunAsNode                       ELECTRON_RUN_AS_NODE=1 makes it a plain Node.js
//   EnableNodeOptionsEnvironmentVariable  NODE_OPTIONS can preload any script
//   EnableNodeCliInspectArguments   --inspect opens a debugger into the main process
//   EnableCookieEncryption          cookies on disk are encrypted with the OS key
// The source runtime (node_modules/electron) is left as it is for development.
//
// Usage: node scripts/electron-fuses.mjs <path-to-electron.exe> [--check]
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The installer builds from a fresh source export without node_modules; the
// build runtime root (current directory) has them.
async function loadFuses() {
  try { return await import('@electron/fuses'); } catch {
    const resolved = createRequire(path.join(process.cwd(), 'package.json')).resolve('@electron/fuses');
    return import(pathToFileURL(resolved).href);
  }
}
const { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } = await loadFuses();

export const MONARCH_ELECTRON_FUSES = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
});

export async function readMonarchFuses(executable) {
  const wire = await getCurrentFuseWire(executable);
  return Object.fromEntries(Object.keys(MONARCH_ELECTRON_FUSES).map(option => [option, wire[option] === FuseState.ENABLE]));
}

export async function checkMonarchFuses(executable) {
  const actual = await readMonarchFuses(executable);
  const wrong = Object.entries(MONARCH_ELECTRON_FUSES)
    .filter(([option, expected]) => actual[option] !== expected)
    .map(([option]) => FuseV1Options[option]);
  return { ok: wrong.length === 0, wrong };
}

export async function applyMonarchFuses(executable) {
  if (!existsSync(executable)) throw Error(`electron-fuses: missing ${executable}`);
  await flipFuses(executable, { version: FuseVersion.V1, resetAdHocDarwinSignature: false, ...MONARCH_ELECTRON_FUSES });
  const result = await checkMonarchFuses(executable);
  if (!result.ok) throw Error(`electron-fuses: not applied: ${result.wrong.join(', ')}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [executable, flag] = process.argv.slice(2);
  if (!executable) { console.error('usage: electron-fuses.mjs <electron.exe> [--check]'); process.exit(2); }
  const result = flag === '--check' ? await checkMonarchFuses(executable) : await applyMonarchFuses(executable);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
