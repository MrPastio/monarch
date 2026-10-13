import { oscarBridgeHost, oscarBridgeRequest } from './oscar-bridge-host';
import { writeSync } from 'node:fs';

const [root, stage] = process.argv.slice(2);
if (!root || !['admitted', 'cancel-stored', 'terminal-stored', 'delivered', 'effect-unrecorded'].includes(stage ?? '')) throw Error('owned-crash-stage-required');
const s = await oscarBridgeHost(root);
let dispatches = 0, turnId = '';
const execute = s.kernel.executeActionProposal.bind(s.kernel);
s.kernel.executeActionProposal = async (...args) => { dispatches++; const result = await execute(...args);
  if (stage === 'effect-unrecorded' && result.result.ok) crash(turnId);
  return result; };
const crash = (turnId: string): never => {
  writeSync(1, JSON.stringify({ marker: 'owned-astra-oscar-exit', stage, turnId, dispatches, ...s.counts() }) + '\n');
  process.exit(68);
};
if (stage === 'admitted') {
  const save = s.persistentStore.saveTurn.bind(s.persistentStore);
  s.persistentStore.saveTurn = async (turn, options) => {
    if (turn.taskId) return crash(turn.id); // Astra commit exists; Oscar link does not.
    return save(turn, options);
  };
}
if (stage === 'terminal-stored') {
  const save = s.persistentStore.saveTurn.bind(s.persistentStore);
  s.persistentStore.saveTurn = async (turn, options) => {
    const saved = await save(turn, options);
    if (turn.outcome) return crash(turn.id); // Terminal+outbox committed together.
    return saved;
  };
}
if (stage === 'delivered') s.hooks.afterPersist = message => {
  if (message.astraCertificateDigest) {
    // This synchronous point is after the synthetic backend wrote its receipt,
    // before the coordinator can acknowledge Astra or its own delivery outbox.
    crash(message.turnId);
  }
};
// Admission cut uses the real source-restore barrier: there is a committed Astra
// task, but no opportunity for an unreceipted physical read before the cut.
if (stage !== 'admitted') await s.start();
const admitted = await s.coordinator.submit(oscarBridgeRequest(stage === 'cancel-stored' || stage === 'effect-unrecorded' ? 'literal' : 'read'));
turnId = admitted.turn.id;
if (stage === 'admitted') await s.start();
await s.flush();
if (stage === 'effect-unrecorded') {
  const approval = s.bridge.find((await s.coordinator.getTurn(turnId))!.turn)?.approval;
  if (!approval) throw Error('fixture-approval-not-pending');
  await s.coordinator.submitAstraInput(turnId, 'desktop', { kind: 'decide', decision: {
    approvalId: approval.id, approvalDigest: approval.digest, messageId: 'exact_approval', decision: 'approve' } });
  await s.flush();
}
if (stage === 'cancel-stored') {
  const view = s.bridge.find((await s.coordinator.getTurn(admitted.turn.id))!.turn);
  if (!view?.approval) throw Error('fixture-approval-not-pending');
  await s.coordinator.stop();
  await s.coordinator.cancel(admitted.turn.id, 'desktop');
  await crash(admitted.turn.id);
}
throw Error('fixture-crash-point-not-reached');
