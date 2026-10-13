import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { oscarBridgeHost, oscarBridgeMarker } from '../tests/fixtures/agent-v3/oscar-bridge-host.ts';
import { createMonarchHttpServer } from '../src/app/http-server.ts';
import { oscarAstraNativeRequest } from '../src/ui/public/modules/oscar-astra-native.js';

// Called only after the parent probe's marked exact-child preflight.
export async function runRecoveryDraftHttp(root, host, source) {
  await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
  await writeFile(path.join(root, 'selected.txt'), source, { flag: 'wx' });
  const token = 'synthetic-recovery-http-token', route = '/api/oscar/turns';
  const actor = { id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/api').digest('hex'), source: 'api' };
  const transport = (url, init) => {
    if (!String(url).startsWith(host.endpoint + '/')) throw Error('external-model-network-forbidden');
    return fetch(url, init);
  };
  const s = await oscarBridgeHost(root, { actor, durableSelections: true, referenceInputs: true,
    model: { ...host, fetch: transport, bearerToken: 'synthetic-draft-recovery', timeoutMs: 60000 } });
  const calls = [], dispatch = s.kernel.executeActionProposal.bind(s.kernel);
  s.kernel.executeActionProposal = (...args) => {
    const proposal = args[0], index = calls.length; calls.push(proposal);
    if (index > 2 || proposal.capabilityId !== (index === 0 ? 'workspace.files.read' : 'workspace.files.write')
      || proposal.args.path !== path.join(root, index === 0 ? 'selected.txt' : 'Новый отчёт.txt')
      || (index > 0 && (proposal.args.overwrite !== false || typeof proposal.args.content !== 'string'
        || Buffer.byteLength(proposal.args.content) > 4096))) throw Error('unexpected-http-kernel-dispatch');
    return dispatch(...args);
  };
  const app = new Proxy({}, { get(_target, key) {
    if (key === 'oscarTurnCoordinator') return s.coordinator;
    if (key === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: false, internetEnabled: false, historyContextEnabled: false });
    throw Error('unexpected-product-access:' + String(key));
  } });
  const api = createMonarchHttpServer({ app, publicDirectory: root, apiToken: token,
    desktopAttestationToken: 'synthetic-unused-desktop', requireApiToken: true,
    allowNonLoopbackMutations: false, astraOscarTurns: true, astraSelections: s.selections });
  try {
    await s.start();
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + api.address().port;
    const call = async (pathname, body) => {
      const response = await fetch(base + pathname, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json();
      if (!response.ok) throw Error('oscar-http:' + response.status + ':' + JSON.stringify(value));
      return value;
    };
    const request = oscarAstraNativeRequest({ conversationId: 'conversation', localAnalysis: true, referenceInputs: true, mode: 'draft',
      target: { key: 'destination', selectionId: s.selectionId, targetId: 'output', access: 'exclusive-create', label: 'Новый отчёт.txt' },
      references: [{ key: 'source', selectionId: s.selectionId, targetId: 'selected', access: 'observe', label: 'selected.txt' }] },
    'Составь краткое резюме прикреплённого материала на русском языке. Укажи название проекта, сколько задач выполнено, сколько осталось и следующий шаг.',
    { clientRequestId: 'request', inputMessageId: 'message' });
    const admitted = await call(route, request), item = route + '/' + admitted.turn.id;
    const waitFor = async terminal => {
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        const cp = await call(item);
        if (terminal(cp) || ['failed', 'cancelled'].includes(cp.turn.status)) return cp;
        if (s.progressionFailures.length) throw Error(JSON.stringify(s.progressionFailures));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('autonomous-progression-timeout');
    };
    // GET-only observation; no manual drain/flush/wake hides stalled progression.
    const pending = await waitFor(cp => cp.turn.status === 'waiting-for-approval');
    const outputPath = path.join(root, 'Новый отчёт.txt');
    const outputBeforeApproval = await readFile(outputPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (outputBeforeApproval !== null) throw Error('http-write-before-approval');
    const approval = pending.events.filter(event => event.type === 'approval.required').at(-1)?.payload;
    if (!approval) throw Error('http-no-approval:' + JSON.stringify(pending.turn));
    await call(item + '/astra-input', { version: 1, conversationId: 'conversation', inputMessageId: 'message', input: { kind: 'decide',
      decision: { approvalId: approval.id, approvalDigest: approval.digest, messageId: 'synthetic-approval', decision: 'approve' } } });
    const final = await waitFor(cp => cp.turn.status === 'succeeded');
    const replay = await call(route, request);
    const output = await readFile(outputPath, 'utf8');
    let delivered = await s.delivered();
    const deliveryDeadline = Date.now() + 10000;
    // Task status and outbox acknowledgement are separate durable transitions.
    // Observe the actual delivery store; never flush it from the test.
    while (!delivered.some(message => message.messageId === final.turn.outputMessageId) && Date.now() < deliveryDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100)); delivered = await s.delivered();
    }
    const metrics = await (await transport(host.endpoint + '/metrics', { headers: { Authorization: 'Bearer synthetic-draft-recovery' } })).json();
    const sourceUnchanged = await readFile(path.join(root, 'selected.txt'), 'utf8') === source;
    const semanticCheck = /[а-яё]/iu.test(output) && /ORBIT/iu.test(output) && /7/u.test(output) && /2/u.test(output);
    const accepted = final.turn.status === 'succeeded' && final.turn.outcome?.kind === 'partial'
      && replay.turn.id === admitted.turn.id && sourceUnchanged && semanticCheck && calls.length === 3
      && metrics.calls === 1 && metrics.mock === false && metrics.fallback === false && !metrics.slotReserved
      && s.counts().legacyCalls === 0 && s.counts().answerCalls === 0
      && delivered.filter(message => message.messageId === final.turn.outputMessageId && message.role === 'assistant'
        && message.conversationId === request.conversationId && message.requiredPreviousMessageId === 'synthetic-approval').length === 1;
    return { scope: 'ordinary-Oscar-HTTP-real-prepared-model', ordinaryHttpAdmission: true,
      accepted, pending, final, replayTurnId: replay.turn.id, delivered, calls, metrics, output, sourceUnchanged, outputBeforeApproval, semanticCheck,
      counts: s.counts(), progressionFailures: s.progressionFailures, installed: false, nativePicker: false };
  } finally {
    await new Promise(resolve => { api.close(resolve); api.closeAllConnections(); });
    await s.close();
  }
}
