import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraWorkScheduler, type AstraWorkAdapter } from '../../../src/agent-v3/work-scheduler';

// Deliberately exits without releasing its lease; no tools/models/network/user data.
const directory = process.argv[2];
if (!directory) throw new Error('fixture-directory-required');
const parent = await realpath('.test-tmp'), root = await realpath(directory);
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(root) !== parent
  || !path.basename(root).startsWith('astra-v3-scheduler-')
  || await readFile(path.join(root, '.fixture-marker'), 'utf8') !== 'astra-work-scheduler-synthetic-only') throw new Error('fixture-scope');
const adapter: AstraWorkAdapter = { id: 'fixture', version: 'v1', compile: input => ({ input,
  resources: { kernelSlots: 0, modelSlots: 0, declaredBytes: 1024, exclusiveKeys: [] }, bindingDigest: 'fixture',
  storage: { streams: [], maxActivations: 4 } }),
  execute: async () => ({ state: 'observed', progressDigest: 'fixture', checkpointRef: 'fixture', checkpointRevision: 1 }),
  control: () => { throw new Error('unused'); }, reconcile: () => { throw new Error('unused'); } };
const journal = new AstraJournal(path.join(root, 'owner.sqlite'));
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'process_owner',
  adapters: [adapter], now: () => 1000, limits: { leaseMs: 1000 } });
let result: object;
try {
  scheduler.acquire();
  scheduler.submit({ requestId: 'persisted_queued', adapterId: adapter.id, input: {} });
  result = { status: 'acquired' };
} catch (error) { result = { status: 'rejected', code: error instanceof Error ? error.message : 'unknown' }; }
process.stdout.write(JSON.stringify(result), () => process.exit(0));
