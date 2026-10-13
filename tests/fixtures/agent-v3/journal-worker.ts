// Disposable-process crash/concurrency fixture. NEVER point at a user database.
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AstraJournal } from '../../../src/agent-v3/journal';

const [directory, mode, requestId] = process.argv.slice(2);
if (!directory || !mode || !requestId || !/^[a-z_]+$/u.test(requestId)) throw new Error('fixture-arguments');
const parent = await realpath('.test-tmp'), root = await realpath(directory);
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(root) !== parent
  || !path.basename(root).startsWith('astra-v3-journal-')
  || await readFile(path.join(root, '.fixture-marker'), 'utf8') !== 'astra-v3-journal-tests-synthetic-only') throw new Error('fixture-scope');
const file = path.join(root, mode === 'reservation-race' ? 'capacity-process.sqlite' : 'process.sqlite');
if (mode === 'uncommitted-exit') {
  const db = new DatabaseSync(file);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE astra_streams SET checkpoint=? WHERE stream_id=?').run(Buffer.from('{"broken":true}'), 'process_task');
  // Intentional process exit, with neither COMMIT/ROLLBACK nor database.close().
  process.exit(17);
} else if (mode === 'commit-exit' || mode === 'race' || mode === 'reservation-race') {
  const journal = new AstraJournal(file);
  let output: object;
  try {
    output = mode === 'reservation-race' ? { status: 'committed', receipt: journal.appendAtomic({
      primary: { streamId: requestId, requestId, expectedRevision: 0,
        checkpoint: { synthetic: true }, events: [{ type: 'capacity.admitted' }] },
      reserve: Array.from({ length: 8 }, (_, group) => ({ id: `${requestId}_${group}`,
        allocations: Array.from({ length: 64 }, (_, index) => ({ streamId: `${requestId}_${group}_${index}`,
          commits: 1, eventBytes: 1024, checkpointBytes: 1024 })) })),
    }).receipt } : { status: 'committed', receipt: journal.append({ streamId: 'process_task', requestId,
      expectedRevision: mode === 'race' ? 1 : 0, checkpoint: { synthetic: true, value: '4103' }, events: [{ type: 'synthetic-observation' }] }) };
  } catch (error) {
    output = { status: 'rejected', code: error instanceof Error ? error.message : 'unknown' };
  }
  // Flush the tiny IPC result, then bypass graceful journal shutdown deliberately.
  process.stdout.write(JSON.stringify({ ...output, openingRecovery: journal.openingRecovery() }), () => process.exit(0));
} else throw new Error('fixture-mode');
