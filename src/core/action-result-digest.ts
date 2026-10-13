import { createHash } from 'node:crypto';
import type { MonarchExecutionResult } from './contracts';

/** The part of an action result a completion certificate binds: the same
 * projection Astra observes ({ok, summary, output, error}). */
export function actionResultProjection(result: MonarchExecutionResult): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ok: result.ok, summary: result.summary,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(typeof result.error === 'string' ? { error: result.error.slice(0, 1024) } : {}) })) as Record<string, unknown>;
}

/** sha256 of the projection in sorted-key canonical JSON: byte for byte what
 * Astra's journal encoding produces for the same value, so a digest recorded by
 * Kernel when an action completes still certifies its receipt after a restart,
 * when only a bounded copy of the result is kept on disk. */
export function actionResultDigest(result: MonarchExecutionResult): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(actionResultProjection(result))).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
}
