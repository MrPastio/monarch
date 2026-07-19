import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveRuntimeLaunch({
  workspaceRoot,
  fileExists = existsSync,
}) {
  const bundledMain = path.join(workspaceRoot, 'dist', 'monarch-server.mjs');
  if (fileExists(bundledMain)) {
    return {
      kind: 'bundle',
      entryPath: bundledMain,
      args: [bundledMain],
    };
  }

  const tsxCli = path.join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const sourceMain = path.join(workspaceRoot, 'src', 'main.ts');
  if (fileExists(tsxCli) && fileExists(sourceMain)) {
    return {
      kind: 'tsx',
      entryPath: sourceMain,
      args: [tsxCli, sourceMain],
    };
  }

  throw new Error(
    'Monarch runtime files are missing. Expected dist/monarch-server.mjs '
    + 'or the development node_modules/tsx and src/main.ts fallback.',
  );
}
