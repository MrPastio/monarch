import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveRuntimeLaunch({
  workspaceRoot,
  preferSource = false,
  fileExists = existsSync,
}) {
  const bundledMain = path.join(workspaceRoot, 'dist', 'monarch-server.mjs');
  const tsxCli = path.join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const sourceMain = path.join(workspaceRoot, 'src', 'main.ts');
  const sourceAvailable = fileExists(tsxCli) && fileExists(sourceMain);
  if (preferSource && sourceAvailable) {
    return {
      kind: 'tsx',
      entryPath: sourceMain,
      // Import the tsx loader in the owned Node process. Launching the tsx CLI
      // creates an extra child which can outlive its Electron-owned parent and
      // keep the strict runtime port occupied after a crash.
      args: ['--import', 'tsx', sourceMain],
    };
  }

  if (fileExists(bundledMain)) {
    return {
      kind: 'bundle',
      entryPath: bundledMain,
      args: [bundledMain],
    };
  }

  if (sourceAvailable) {
    return {
      kind: 'tsx',
      entryPath: sourceMain,
      args: ['--import', 'tsx', sourceMain],
    };
  }

  throw new Error(
    'Monarch runtime files are missing. Expected dist/monarch-server.mjs '
    + 'or the development node_modules/tsx and src/main.ts fallback.',
  );
}
