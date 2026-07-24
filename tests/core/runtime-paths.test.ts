import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMonarchRuntimePaths } from '../../src/core/runtime-paths';

describe('resolveMonarchRuntimePaths', () => {
  it('routes installed mutable state outside the immutable version directory', () => {
    const root = path.resolve('runtime-path-test');
    const installRoot = path.join(root, 'install');
    const versionRoot = path.join(installRoot, 'versions', '9.9.9');
    const payloadRoot = path.join(root, 'payload');
    const configRoot = path.join(root, 'config');
    const dataRoot = path.join(root, 'data');
    const logsRoot = path.join(root, 'logs');
    const paths = resolveMonarchRuntimePaths(versionRoot, {
      MONARCH_INSTALL_ROOT: installRoot,
      MONARCH_VERSION_ROOT: versionRoot,
      MONARCH_PAYLOAD_ROOT: payloadRoot,
      MONARCH_CONFIG_ROOT: configRoot,
      MONARCH_DATA_ROOT: dataRoot,
      MONARCH_LOGS_ROOT: logsRoot,
    });

    expect(paths.mode).toBe('installed');
    expect(paths.generatedRoot).toBe(path.join(payloadRoot, 'generated'));
    expect(paths.stateRoot).toBe(path.join(dataRoot, 'runtime'));
    expect(paths.secretsRoot).toBe(path.join(installRoot, 'secrets'));
    expect(paths.userWorkspaceRoot).toBe(path.join(payloadRoot, 'workspaces', 'default'));
    expect(paths.coderWorkspaceRoot).toBe(path.join(payloadRoot, 'workspaces', 'coder'));
    expect(Object.values(paths)).not.toContain(path.join(versionRoot, 'artifacts', 'generated'));
  });

  it('fails closed when an installed launcher omits a required writable root', () => {
    const root = path.resolve('runtime-path-test');
    const installRoot = path.join(root, 'install');
    const versionRoot = path.join(installRoot, 'versions', '9.9.9');

    expect(() => resolveMonarchRuntimePaths(versionRoot, {
      MONARCH_INSTALL_ROOT: installRoot,
      MONARCH_VERSION_ROOT: versionRoot,
      MONARCH_PAYLOAD_ROOT: path.join(root, 'payload'),
      MONARCH_CONFIG_ROOT: path.join(root, 'config'),
      MONARCH_LOGS_ROOT: path.join(root, 'logs'),
    })).toThrow('MONARCH_DATA_ROOT');
  });

  it('rejects a writable installed path inside the version directory', () => {
    const root = path.resolve('runtime-path-test');
    const installRoot = path.join(root, 'install');
    const versionRoot = path.join(installRoot, 'versions', '9.9.9');

    expect(() => resolveMonarchRuntimePaths(versionRoot, {
      MONARCH_INSTALL_ROOT: installRoot,
      MONARCH_VERSION_ROOT: versionRoot,
      MONARCH_PAYLOAD_ROOT: path.join(root, 'payload'),
      MONARCH_CONFIG_ROOT: path.join(root, 'config'),
      MONARCH_DATA_ROOT: path.join(versionRoot, 'data'),
      MONARCH_LOGS_ROOT: path.join(root, 'logs'),
    })).toThrow('immutable version root');
  });
});
