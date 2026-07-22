import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  MonarchActionObservationV1,
  MonarchActionPredicate,
  MonarchExecutionResult,
} from './contracts';
import { actionPredicateValueError } from './action-predicate';

const MAX_PREDICATE_FILE_BYTES = 1024 * 1024;

export async function verifyActionPredicates(
  predicates: MonarchActionPredicate[] | undefined,
  options: {
    phase: MonarchActionObservationV1['phase'];
    workspaceRoot: string;
    allowedRoots?: string[];
    result?: MonarchExecutionResult;
  },
): Promise<MonarchActionObservationV1[]> {
  if (!predicates?.length) return [];
  const observations: MonarchActionObservationV1[] = [];
  for (const predicate of predicates) {
    observations.push(await evaluatePredicate(predicate, options));
  }
  return observations;
}

async function evaluatePredicate(
  predicate: MonarchActionPredicate,
  options: {
    phase: MonarchActionObservationV1['phase'];
    workspaceRoot: string;
    allowedRoots?: string[];
    result?: MonarchExecutionResult;
  },
): Promise<MonarchActionObservationV1> {
  const valueError = actionPredicateValueError(predicate as unknown as Record<string, unknown>);
  if (valueError) {
    return observation(options.phase, predicate, false, undefined, 'predicate-value-invalid', valueError);
  }
  if (predicate.target === 'result' || predicate.target.startsWith('result.')) {
    if (options.phase !== 'verification' || !options.result) {
      return observation(options.phase, predicate, false, undefined, 'predicate-result-unavailable', 'Result predicates are available only during verification.');
    }
    const observed = readResultTarget(options.result, predicate.target);
    return compareObserved(options.phase, predicate, observed, observed !== undefined);
  }

  const targetPath = path.resolve(options.workspaceRoot, predicate.target);
  const allowedRoots = (options.allowedRoots?.length ? options.allowedRoots : [options.workspaceRoot]).map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => isPathInside(targetPath, root))) {
    return observation(options.phase, predicate, false, targetPath, 'predicate-outside-scope', 'Predicate target is outside the canonical action scope.');
  }
  if (!(await hasSafeExistingAncestor(targetPath, allowedRoots))) {
    return observation(options.phase, predicate, false, targetPath, 'predicate-symlink-escape', 'Predicate target resolves through an ancestor outside the canonical action scope.');
  }

  const info = await lstat(targetPath).catch(() => undefined);
  const exists = Boolean(info);
  if (predicate.kind === 'exists') {
    return observation(options.phase, predicate, exists, exists, exists ? 'predicate-ok' : 'predicate-not-found', exists ? 'Target exists.' : 'Target does not exist.');
  }
  if (predicate.kind === 'not-exists') {
    return observation(options.phase, predicate, !exists, exists, !exists ? 'predicate-ok' : 'predicate-already-exists', !exists ? 'Target does not exist.' : 'Target already exists.');
  }
  if (!info) {
    return observation(options.phase, predicate, false, undefined, 'predicate-not-found', 'Predicate target does not exist.');
  }
  if (predicate.kind === 'status') {
    const status = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other';
    return compareObserved(options.phase, predicate, status, true);
  }
  if (!info.isFile()) {
    return observation(options.phase, predicate, false, info.isDirectory() ? 'directory' : 'other', 'predicate-not-file', 'Content predicates require a regular file.');
  }
  if (info.size > MAX_PREDICATE_FILE_BYTES) {
    return observation(options.phase, predicate, false, info.size, 'predicate-file-too-large', `Predicate file exceeds ${MAX_PREDICATE_FILE_BYTES} bytes.`);
  }
  const content = await readFile(targetPath, 'utf8').catch(() => undefined);
  if (content === undefined) {
    return observation(options.phase, predicate, false, undefined, 'predicate-read-failed', 'Predicate target could not be read as text.');
  }
  return compareObserved(options.phase, predicate, content, true);
}

function compareObserved(
  phase: MonarchActionObservationV1['phase'],
  predicate: MonarchActionPredicate,
  observed: unknown,
  exists: boolean,
): MonarchActionObservationV1 {
  let ok = false;
  if (predicate.kind === 'exists') ok = exists;
  else if (predicate.kind === 'not-exists') ok = !exists;
  else if (predicate.kind === 'equals' || predicate.kind === 'status') ok = deepEqual(observed, predicate.value);
  else if (predicate.kind === 'contains') {
    ok = typeof observed === 'string'
      ? typeof predicate.value === 'string' && observed.includes(predicate.value)
      : Array.isArray(observed)
        ? observed.some((entry) => deepEqual(entry, predicate.value))
        : false;
  }
  return observation(
    phase,
    predicate,
    ok,
    summarizeObserved(observed),
    ok ? 'predicate-ok' : 'predicate-mismatch',
    ok ? 'Predicate satisfied.' : 'Observed value does not satisfy the predicate.',
  );
}

async function hasSafeExistingAncestor(targetPath: string, allowedRoots: string[]): Promise<boolean> {
  let current = targetPath;
  while (true) {
    const resolved = await realpath(current).catch(() => undefined);
    if (resolved) return allowedRoots.some((root) => isPathInside(resolved, root));
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function readResultTarget(result: MonarchExecutionResult, target: string): unknown {
  if (target === 'result') return result;
  const segments = target.slice('result.'.length).split('.').filter(Boolean).slice(0, 16);
  let current: unknown = result;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function observation(
  phase: MonarchActionObservationV1['phase'],
  predicate: MonarchActionPredicate,
  ok: boolean,
  observed: unknown,
  code: string,
  message: string,
): MonarchActionObservationV1 {
  return {
    version: 1,
    phase,
    predicate: { ...predicate },
    ok,
    ...(observed !== undefined ? { observed } : {}),
    code,
    message,
  };
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  if (candidate.toLowerCase() === root.toLowerCase()) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function summarizeObserved(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 2_000) return `${value.slice(0, 2_000)}…`;
  return value;
}
