import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import path from 'node:path';

export function createTransactionalInstallerCoordinator({
  installRoot,
  updateRoot,
  runtimeUrl,
  fetchImpl = globalThis.fetch,
  shutdown,
  requestQuit,
  spawnImpl = spawn,
  now = () => Date.now(),
  taskTimeoutMs = 120_000,
}) {
  if (!path.isAbsolute(installRoot) || !path.isAbsolute(updateRoot)) {
    throw new TypeError('Installer coordinator requires absolute install and update roots.');
  }
  if (typeof shutdown !== 'function' || typeof requestQuit !== 'function') {
    throw new TypeError('Installer coordinator lifecycle callbacks are required.');
  }

  return async function launchInstaller({
    installerPath,
    manifest,
    signal,
    beginInstallation,
  }) {
    const trustedInstaller = requireInside(installerPath, updateRoot);
    if (path.basename(trustedInstaller) !== manifest?.asset?.fileName) {
      throw coordinatorError('installer-path-mismatch', 'Verified installer path does not match the signed manifest.');
    }
    await access(trustedInstaller);
    await waitForActiveTasks({
      runtimeUrl: typeof runtimeUrl === 'function' ? runtimeUrl() : runtimeUrl,
      fetchImpl,
      signal,
      now,
      timeoutMs: taskTimeoutMs,
    });
    throwIfAborted(signal);
    beginInstallation();
    await shutdown();

    const args = [
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/SP-',
      `/DIR=${installRoot}`,
    ];
    const child = spawnImpl(trustedInstaller, args, {
      cwd: updateRoot,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
    await Promise.race([
      once(child, 'spawn'),
      once(child, 'error').then(([error]) => Promise.reject(error)),
    ]);
    child.unref();
    requestQuit();
    return Object.freeze({ started: true, pid: child.pid });
  };
}

export async function waitForActiveTasks({
  runtimeUrl,
  fetchImpl = globalThis.fetch,
  signal,
  now = () => Date.now(),
  timeoutMs = 120_000,
  pollMs = 500,
}) {
  if (!runtimeUrl) return;
  const deadline = now() + timeoutMs;
  while (true) {
    throwIfAborted(signal);
    let active = false;
    try {
      const response = await fetchImpl(new URL('/api/intent-jobs?limit=100', runtimeUrl), {
        signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw coordinatorError('task-check-failed', `Task status returned HTTP ${response.status}.`);
      }
      const payload = await response.json();
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      active = jobs.some((job) => job?.status === 'queued' || job?.status === 'running');
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw coordinatorError('task-check-failed', 'Monarch could not confirm that active tasks stopped.', error);
    }
    if (!active) return;
    if (now() >= deadline) {
      throw coordinatorError('active-tasks-timeout', 'Active Monarch tasks did not finish before the update timeout.');
    }
    await abortableDelay(pollMs, signal);
  }
}

function requireInside(candidate, root) {
  if (!path.isAbsolute(candidate)) {
    throw coordinatorError('untrusted-installer-path', 'Installer path must be absolute.');
  }
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw coordinatorError('untrusted-installer-path', 'Installer path escaped the trusted update cache.');
  }
  return resolved;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Update installation was cancelled before Setup started.');
  error.name = 'AbortError';
  throw error;
}

function abortableDelay(duration, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, duration);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      const error = new Error('Update installation was cancelled.');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

function coordinatorError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
