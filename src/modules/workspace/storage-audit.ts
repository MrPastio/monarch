import { Worker } from 'node:worker_threads';

export interface WorkspaceStorageAuditOptions {
  root: string;
  topN: number;
  maxDepth: number;
  maxEntries: number;
  maxWallTimeMs: number;
  blockedRoots: string[];
  concurrency?: number;
  signal?: AbortSignal;
}

export interface WorkspaceStorageAuditResult {
  root: string;
  logicalBytes: number;
  files: number;
  directories: number;
  emptyDirectories: number;
  entriesObserved: number;
  maxDepthObserved: number;
  topDirectories: Array<{ path: string; logicalBytes: number; files: number; directories: number }>;
  projectMarkerCandidates: Array<{ path: string; marker: string }>;
  skipReasons: Record<string, number>;
  observedTimestamps: { startedAt: string; completedAt: string; rootModifiedAt?: string };
  budget: { maxDepth: number; maxEntries: number; maxWallTimeMs: number; exhausted: boolean };
  partial: boolean;
  cancellationRequested: boolean;
  mutationsObserved: 0;
}

export function runWorkspaceStorageAudit(options: WorkspaceStorageAuditOptions): Promise<WorkspaceStorageAuditResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(STORAGE_AUDIT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        root: options.root,
        topN: options.topN,
        maxDepth: options.maxDepth,
        maxEntries: options.maxEntries,
        maxWallTimeMs: options.maxWallTimeMs,
        blockedRoots: options.blockedRoots,
        concurrency: Math.max(1, Math.min(options.concurrency || 8, 32)),
      },
    });
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (terminationTimer) clearTimeout(terminationTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const abort = () => {
      worker.postMessage({ type: 'cancel' });
      terminationTimer = setTimeout(() => {
        void worker.terminate();
        finish(() => reject(Object.assign(new Error('Storage audit worker did not acknowledge cancellation.'), {
          code: 'audit-cancellation-timeout',
        })));
      }, 2_000);
      terminationTimer.unref?.();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: unknown) => {
      if (!isRecord(message) || message.type !== 'result' || !isRecord(message.result)) {
        finish(() => reject(new Error('Storage audit worker returned an invalid result.')));
        return;
      }
      finish(() => resolve(message.result as unknown as WorkspaceStorageAuditResult));
      void worker.terminate();
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Storage audit worker exited before returning a result (code ${code}).`)));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const STORAGE_AUDIT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(workerData.root);
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const deadline = startedMs + workerData.maxWallTimeMs;
const blockedRoots = workerData.blockedRoots.map((entry) => path.resolve(entry));
const projectMarkers = new Set([
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'requirements.txt',
]);
let cancelled = false;
let logicalBytes = 0;
let files = 0;
let directories = 0;
let emptyDirectories = 0;
let entriesObserved = 0;
let entriesBudgeted = 1;
let entryBudgetHit = false;
let maxDepthObserved = 0;
let rootModifiedAt;
const skips = Object.create(null);
const top = new Map();
const markers = [];
const queue = [{ directory: root, depth: 0, topPath: '' }];

parentPort.on('message', (message) => {
  if (message && message.type === 'cancel') cancelled = true;
});

function increment(reason, count = 1) {
  skips[reason] = (skips[reason] || 0) + count;
}

function same(left, right) {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function within(candidate, parent) {
  if (same(candidate, parent)) return true;
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function policyAllows(candidate) {
  const resolved = path.resolve(candidate);
  if (!within(resolved, root)) return false;
  return !blockedRoots.some((blocked) => within(resolved, blocked));
}

function errorReason(error) {
  const code = String(error && error.code || 'filesystem-error').toLowerCase();
  return ['eacces', 'eperm', 'enoent', 'ebusy', 'eloop', 'enametoolong'].includes(code) ? code : 'filesystem-error';
}

function topRecord(topPath) {
  if (!topPath) return null;
  let record = top.get(topPath);
  if (!record) {
    record = { path: topPath, logicalBytes: 0, files: 0, directories: 0 };
    top.set(topPath, record);
  }
  return record;
}

async function scanDirectory(item) {
  if (cancelled) return;
  if (Date.now() >= deadline) {
    increment('time-budget');
    return;
  }
  if (!policyAllows(item.directory)) {
    increment('policy-blocked');
    return;
  }
  let ownStat;
  try {
    ownStat = await fs.lstat(item.directory);
  } catch (error) {
    increment(errorReason(error));
    return;
  }
  if (ownStat.isSymbolicLink()) {
    increment('reparse-point');
    return;
  }
  if (!ownStat.isDirectory()) {
    increment('not-directory');
    return;
  }
  if (entriesObserved >= workerData.maxEntries) {
    entryBudgetHit = true;
    increment('max-entries');
    return;
  }
  directories += 1;
  entriesObserved += 1;
  maxDepthObserved = Math.max(maxDepthObserved, item.depth);
  if (item.depth === 0) rootModifiedAt = ownStat.mtime.toISOString();
  const aggregate = topRecord(item.topPath);
  if (aggregate && item.depth > 0) aggregate.directories += 1;
  let children;
  try {
    children = await fs.readdir(item.directory, { withFileTypes: true });
  } catch (error) {
    increment(errorReason(error));
    return;
  }
  if (children.length === 0) emptyDirectories += 1;
  for (const child of children) {
    if (cancelled) break;
    if (Date.now() >= deadline) {
      increment('time-budget');
      break;
    }
    if (entriesBudgeted >= workerData.maxEntries) {
      entryBudgetHit = true;
      increment('max-entries');
      break;
    }
    entriesBudgeted += 1;
    const childPath = path.join(item.directory, child.name);
    if (!policyAllows(childPath)) {
      increment('policy-blocked');
      continue;
    }
    if (child.isSymbolicLink()) {
      increment('reparse-point');
      continue;
    }
    const nextTop = item.depth === 0 && child.isDirectory() ? childPath : item.topPath;
    if (child.isDirectory()) {
      if (item.depth >= workerData.maxDepth) {
        increment('max-depth');
        continue;
      }
      queue.push({ directory: childPath, depth: item.depth + 1, topPath: nextTop });
      if (projectMarkers.has(child.name) && markers.length < 512) markers.push({ path: childPath, marker: child.name });
      continue;
    }
    if (!child.isFile()) {
      increment('special-entry');
      continue;
    }
    let childStat;
    try {
      childStat = await fs.lstat(childPath);
    } catch (error) {
      increment(errorReason(error));
      continue;
    }
    if (childStat.isSymbolicLink()) {
      increment('reparse-point');
      continue;
    }
    if (entriesObserved >= workerData.maxEntries) {
      entryBudgetHit = true;
      increment('max-entries');
      break;
    }
    files += 1;
    entriesObserved += 1;
    logicalBytes += childStat.size;
    const fileAggregate = topRecord(item.topPath);
    if (fileAggregate) {
      fileAggregate.files += 1;
      fileAggregate.logicalBytes += childStat.size;
    }
    if (projectMarkers.has(child.name) && markers.length < 512) markers.push({ path: childPath, marker: child.name });
  }
}

(async () => {
  while (queue.length && !cancelled && Date.now() < deadline) {
    const batch = queue.splice(0, workerData.concurrency);
    await Promise.all(batch.map(scanDirectory));
  }
  if (cancelled) increment('cancelled');
  if (Date.now() >= deadline && !skips['time-budget']) increment('time-budget');
  if (entryBudgetHit && !skips['max-entries']) increment('max-entries');
  const skipReasons = Object.fromEntries(Object.entries(skips).sort(([left], [right]) => left.localeCompare(right)));
  const exhausted = Boolean(skipReasons['max-depth'] || skipReasons['max-entries'] || skipReasons['time-budget']);
  const partial = cancelled || exhausted || Object.keys(skipReasons).some((reason) => !['special-entry'].includes(reason));
  parentPort.postMessage({
    type: 'result',
    result: {
      root,
      logicalBytes,
      files,
      directories,
      emptyDirectories,
      entriesObserved,
      maxDepthObserved,
      topDirectories: [...top.values()]
        .sort((left, right) => right.logicalBytes - left.logicalBytes || left.path.localeCompare(right.path))
        .slice(0, workerData.topN),
      projectMarkerCandidates: markers.sort((left, right) => left.path.localeCompare(right.path)),
      skipReasons,
      observedTimestamps: { startedAt, completedAt: new Date().toISOString(), ...(rootModifiedAt ? { rootModifiedAt } : {}) },
      budget: {
        maxDepth: workerData.maxDepth,
        maxEntries: workerData.maxEntries,
        maxWallTimeMs: workerData.maxWallTimeMs,
        exhausted,
      },
      partial,
      cancellationRequested: cancelled,
      mutationsObserved: 0,
    },
  });
})().catch((error) => {
  increment(errorReason(error));
  parentPort.postMessage({
    type: 'result',
    result: {
      root,
      logicalBytes,
      files,
      directories,
      emptyDirectories,
      entriesObserved,
      maxDepthObserved,
      topDirectories: [...top.values()].slice(0, workerData.topN),
      projectMarkerCandidates: markers,
      skipReasons: Object.fromEntries(Object.entries(skips)),
      observedTimestamps: { startedAt, completedAt: new Date().toISOString(), ...(rootModifiedAt ? { rootModifiedAt } : {}) },
      budget: { maxDepth: workerData.maxDepth, maxEntries: workerData.maxEntries, maxWallTimeMs: workerData.maxWallTimeMs, exhausted: false },
      partial: true,
      cancellationRequested: cancelled,
      mutationsObserved: 0,
    },
  });
});
`;
