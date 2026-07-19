function defaultDelay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown');
}

async function createStartupError({
  summary,
  errorLogPath,
  readErrorLog,
  lastError,
}) {
  const lines = [summary];
  if (errorLogPath) lines.push(`Runtime log: ${errorLogPath}`);

  const logTail = String(await readErrorLog().catch(() => '')).trim();
  if (logTail) {
    lines.push('Runtime stderr:', logTail);
  } else if (lastError) {
    lines.push(`Last connection error: ${errorMessage(lastError)}`);
  }
  return new Error(lines.join('\n'));
}

export async function waitForRuntimeReady({
  fetchHealth,
  getProcessExit = () => null,
  readErrorLog = async () => '',
  errorLogPath = '',
  timeoutMs = 60_000,
  pollIntervalMs = 250,
  now = () => Date.now(),
  delay = defaultDelay,
}) {
  const startedAt = now();
  let lastError = null;

  while (now() - startedAt < timeoutMs) {
    const earlyExit = getProcessExit();
    if (earlyExit) {
      const reason = earlyExit.error
        ? errorMessage(earlyExit.error)
        : earlyExit.code ?? earlyExit.signal ?? 'unknown';
      throw await createStartupError({
        summary: `Monarch runtime exited before startup (${reason}).`,
        errorLogPath,
        readErrorLog,
        lastError,
      });
    }

    try {
      const health = await fetchHealth();
      if (health?.ok) return health;
    } catch (error) {
      lastError = error;
    }

    const lateExit = getProcessExit();
    if (lateExit) {
      const reason = lateExit.error
        ? errorMessage(lateExit.error)
        : lateExit.code ?? lateExit.signal ?? 'unknown';
      throw await createStartupError({
        summary: `Monarch runtime exited before startup (${reason}).`,
        errorLogPath,
        readErrorLog,
        lastError,
      });
    }
    await delay(pollIntervalMs);
  }

  throw await createStartupError({
    summary: `Monarch runtime did not become ready within ${Math.ceil(timeoutMs / 1000)} seconds.`,
    errorLogPath,
    readErrorLog,
    lastError,
  });
}
