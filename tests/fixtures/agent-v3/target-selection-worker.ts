import { writeSync } from 'node:fs';
import { oscarBridgeHost, oscarBridgeRequest } from './oscar-bridge-host';
const [root, stage] = process.argv.slice(2);
if (!root || !['pending', 'revoked'].includes(stage ?? '')) throw Error('owned-selection-crash-stage');
const s = await oscarBridgeHost(root, { durableSelections: true });
let dispatches = 0; const execute = s.kernel.executeActionProposal.bind(s.kernel);
s.kernel.executeActionProposal = (...args) => { dispatches++; return execute(...args); };
await s.start(); const request = oscarBridgeRequest('literal'); request.astra!.selectionId = s.selectionId;
const cp = await s.coordinator.submit(request); await s.flush();
if (!s.bridge.find((await s.coordinator.getTurn(cp.turn.id))!.turn)?.approval || dispatches !== 1) throw Error('selection-cut-not-at-approval');
if (stage === 'revoked') s.selections!.revoke(s.selectionId, { actor: cp.turn.request.astra!.actor, conversationId: cp.turn.conversationId });
// The revoked cut is synchronous after durable denial, before its host wake can
// project cancellation. Startup must not reconstruct an active selection.
writeSync(1, JSON.stringify({ marker: 'owned-astra-selection-exit', stage, turnId: cp.turn.id, selectionId: s.selectionId,
  dispatches, ...s.counts() }) + '\n'); process.exit(68);
