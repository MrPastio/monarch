import path from 'node:path';

export type MonarchRuntimeMode = 'development' | 'installed';

export interface MonarchRuntimePaths {
  mode: MonarchRuntimeMode;
  workspaceRoot: string;
  installRoot: string | null;
  versionRoot: string;
  payloadRoot: string;
  configRoot: string;
  dataRoot: string;
  logsRoot: string;
  generatedRoot: string;
  modelsRoot: string;
  secretsRoot: string;
  stateRoot: string;
  userWorkspaceRoot: string;
  coderWorkspaceRoot: string;
  coderSandboxRoot: string;
}

export function resolveMonarchRuntimePaths(
  workspaceRoot = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): MonarchRuntimePaths {
  const workspace = path.resolve(workspaceRoot);
  const configuredInstallRoot = readAbsolutePath(environment, 'MONARCH_INSTALL_ROOT');
  const configuredVersionRoot = readAbsolutePath(environment, 'MONARCH_VERSION_ROOT');
  const installed = Boolean(configuredInstallRoot || configuredVersionRoot);

  if (installed && (!configuredInstallRoot || !configuredVersionRoot)) {
    throw new Error(
      'Installed Monarch runtime requires both MONARCH_INSTALL_ROOT and MONARCH_VERSION_ROOT.',
    );
  }
  if (installed && !samePath(workspace, configuredVersionRoot!)) {
    throw new Error(
      `Installed Monarch runtime cwd mismatch: expected ${configuredVersionRoot}, received ${workspace}.`,
    );
  }

  const payloadRoot = installed
    ? requireAbsolutePath(environment, 'MONARCH_PAYLOAD_ROOT')
    : readAbsolutePath(environment, 'MONARCH_PAYLOAD_ROOT') || workspace;
  const dataRoot = installed
    ? requireAbsolutePath(environment, 'MONARCH_DATA_ROOT')
    : readAbsolutePath(environment, 'MONARCH_DATA_ROOT') || path.join(workspace, 'data', 'local');
  const logsRoot = installed
    ? requireAbsolutePath(environment, 'MONARCH_LOGS_ROOT')
    : readAbsolutePath(environment, 'MONARCH_LOGS_ROOT') || path.join(workspace, 'logs');
  const configRoot = installed
    ? requireAbsolutePath(environment, 'MONARCH_CONFIG_ROOT')
    : readAbsolutePath(environment, 'MONARCH_CONFIG_ROOT') || workspace;
  const generatedRoot = readAbsolutePath(environment, 'MONARCH_GENERATED_ROOT')
    || (installed ? path.join(payloadRoot, 'generated') : path.join(workspace, 'artifacts', 'generated'));
  const modelsRoot = readAbsolutePath(environment, 'MONARCH_MODELS_ROOT')
    || (installed ? path.join(payloadRoot, 'models') : workspace);
  const secretsRoot = readAbsolutePath(environment, 'MONARCH_SECRETS_ROOT')
    || (installed ? path.join(configuredInstallRoot!, 'secrets') : path.join(workspace, 'secrets'));
  const stateRoot = readAbsolutePath(environment, 'MONARCH_STATE_ROOT')
    || (installed ? path.join(dataRoot, 'runtime') : path.join(workspace, 'runtime'));
  const userWorkspaceRoot = readAbsolutePath(environment, 'MONARCH_WORKSPACE_ROOT')
    || (installed ? path.join(payloadRoot, 'workspaces', 'default') : workspace);
  const coderWorkspaceRoot = readAbsolutePath(environment, 'MONARCH_CODER_WORKSPACE_ROOT')
    || (installed ? path.join(payloadRoot, 'workspaces', 'coder') : path.join(workspace, 'Workspace Coder'));
  const coderSandboxRoot = readAbsolutePath(environment, 'MONARCH_CODER_SANDBOX_ROOT')
    || (installed ? path.join(payloadRoot, 'coder-sandbox') : path.resolve(path.parse(workspace).root, 'MonarchCoderSandbox'));

  const resolved: MonarchRuntimePaths = {
    mode: installed ? 'installed' : 'development',
    workspaceRoot: workspace,
    installRoot: configuredInstallRoot,
    versionRoot: configuredVersionRoot || workspace,
    payloadRoot,
    configRoot,
    dataRoot,
    logsRoot,
    generatedRoot,
    modelsRoot,
    secretsRoot,
    stateRoot,
    userWorkspaceRoot,
    coderWorkspaceRoot,
    coderSandboxRoot,
  };

  if (installed) {
    for (const [label, writableRoot] of Object.entries({
      MONARCH_CONFIG_ROOT: resolved.configRoot,
      MONARCH_DATA_ROOT: resolved.dataRoot,
      MONARCH_LOGS_ROOT: resolved.logsRoot,
      MONARCH_GENERATED_ROOT: resolved.generatedRoot,
      MONARCH_SECRETS_ROOT: resolved.secretsRoot,
      MONARCH_STATE_ROOT: resolved.stateRoot,
      MONARCH_WORKSPACE_ROOT: resolved.userWorkspaceRoot,
      MONARCH_CODER_WORKSPACE_ROOT: resolved.coderWorkspaceRoot,
      MONARCH_CODER_SANDBOX_ROOT: resolved.coderSandboxRoot,
    })) {
      if (isPathInside(resolved.versionRoot, writableRoot)) {
        throw new Error(
          `Installed Monarch writable path ${label} must stay outside immutable version root ${resolved.versionRoot}.`,
        );
      }
    }
  }

  return resolved;
}

function readAbsolutePath(environment: NodeJS.ProcessEnv, key: string): string | null {
  const value = String(environment[key] || '').trim();
  if (!value) {
    return null;
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path: ${value}`);
  }
  return path.resolve(value);
}

function requireAbsolutePath(environment: NodeJS.ProcessEnv, key: string): string {
  const value = readAbsolutePath(environment, key);
  if (!value) {
    throw new Error(`Installed Monarch runtime is missing required path ${key}.`);
  }
  return value;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
