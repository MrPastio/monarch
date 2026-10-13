// Owned subprocess: exit AFTER native output returned but BEFORE its Store commit.
// No Kernel, product profile or model discovery. The parent owns the loopback host.
import { writeSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AstraJournal, type AstraJson } from '../../../src/agent-v3/journal';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { AstraModelWorkAdapter, type AstraModelWorkCheckpoint } from '../../../src/agent-v3/model-work-adapter';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';

const [rootArg, file, scopeId, endpoint, hostGeneration, modelDigest] = process.argv.slice(2);
const root = await realpath(rootArg!), parent = await realpath('.test-tmp');
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(root) !== parent
  || !path.basename(root).startsWith('astra-v3-live-smollm2-')
  || (await readFile(path.join(root, '.fixture-marker'), 'utf8')).trim() !== 'astra-v3-live-smollm2-owned-cpu-only'
  || !/^model-crash-[a-f0-9-]+\.sqlite$/u.test(file ?? '') || !/^[A-Za-z0-9_-]{1,96}$/u.test(scopeId ?? '')) throw Error('crash-fixture-scope');
const journal = new AstraJournal(path.join(root, file!));
const client = new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: endpoint!,
  hostGeneration: hostGeneration!, bearerToken: 'astra-owned-live-smoke', timeoutMs: 12000 });
const adapter = new AstraModelWorkAdapter({ deployment: 'isolated-validation', journal, client, isSourceCurrent: () => true });
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: scopeId!, adapters: [adapter],
  limits: { leaseMs: 500, activationTimeoutMs: 15000, maxJobs: 4, maxActive: 1 } });
scheduler.acquire();
const job = scheduler.submit({ requestId: 'live_crash_request', adapterId: adapter.id, startWithinMs: 10000, finishWithinMs: 30000,
  input: { source: { executionId: 'crash_goal', revision: 1, mandatory: [
    { ref: 'goal', kind: 'goal', text: 'Read the selected synthetic file selected.txt.' },
    { ref: 'authority', kind: 'authority', text: 'Host-selected read only. Output proposes an action, never executes it.' },
    { ref: 'workflow', kind: 'workflow', text: 'read_requirement pending. Choose its read catalog entry.' },
    { ref: 'budget', kind: 'budget', text: 'One model decision and one read; no completed facts yet.' },
  ], optional: [] }, candidates: [{ handle: 'read_handle', requirementId: 'read_requirement', targetHandle: 'file_handle',
    request: { requestId: 'live_crash_recovered_read', relativePath: 'selected.txt', maxBytes: 8192 } }],
    catalogRevision: 1, expectedModelDigest: modelDigest!, maxOutputTokens: 256, timeoutMs: 10000, maxAttempts: 1,
    contextLimits: { tokenizerTimeoutMs: 5000 } } as AstraJson });
const append = journal.appendAtomic.bind(journal);
journal.appendAtomic = (commit, guard) => {
  if (commit.primary.streamId.startsWith('model_work_')
    && (commit.primary.checkpoint as unknown as AstraModelWorkCheckpoint).phase === 'returned') {
    writeSync(1, JSON.stringify({ marker: 'owned-crash-after-native-before-store', jobId: job.id, scopeId }) + '\n');
    process.exit(61); // Deliberately no journal.close(), no scheduler finalizer.
  }
  return append(commit, guard);
};
await scheduler.drain();
throw Error('expected-owned-controller-crash-did-not-happen');
