/** Work the caller deliberately does not await.
 *
 * A bare `void promise` that rejects is an unhandled rejection, and Node ends
 * the process for it: live, one EPERM on a state file closed the whole server.
 * Background work reports its failure as a code-only diagnostic and the caller
 * keeps running; whatever the work owned stays in its durable state for the
 * next attempt. Only the error's code or name is logged — never its message,
 * which can carry paths or user content.
 */
export function runInBackground(label: string, work: Promise<unknown> | (() => Promise<unknown>)): void {
  let promise: Promise<unknown>;
  try {
    promise = typeof work === 'function' ? work() : work;
  } catch (error) {
    reportBackgroundFailure(label, error);
    return;
  }
  Promise.resolve(promise).catch(error => reportBackgroundFailure(label, error));
}

export function backgroundFailureCode(error: unknown): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error ? error.name : typeof error;
  return code.replace(/[^A-Za-z0-9_.:-]/gu, '?').slice(0, 80) || 'unknown';
}

export function reportBackgroundFailure(label: string, error: unknown): void {
  try {
    console.error(JSON.stringify({ diagnostic: 'monarch-background-failure', work: label.slice(0, 200),
      code: backgroundFailureCode(error) }));
  } catch { /* Reporting must never become the next failure. */ }
}

/** Last line of defence for a long-lived process: a rejection nobody handled is
 * logged instead of ending every conversation and task at once. Uncaught
 * synchronous exceptions keep Node's default (the desktop restarts the runtime),
 * since the process state after one is not trustworthy. */
export function installUnhandledRejectionGuard(target: NodeJS.Process = process): void {
  target.on('unhandledRejection', (reason) => {
    // Where it came from is a source location, not content: the first frame
    // outside node internals names the call that dropped the promise.
    const frame = reason instanceof Error ? (reason.stack ?? '').split('\n')
      .find(line => /^\s+at /u.test(line) && !line.includes('node:internal')) : undefined;
    reportBackgroundFailure('unhandled-rejection' + (frame ? ' ' + frame.trim().replace(/^at /u, '').slice(-120) : ''), reason);
  });
}
