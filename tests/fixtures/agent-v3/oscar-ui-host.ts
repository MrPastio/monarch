/** Explicit synthetic-only rendered acceptance host. Never normal Application.
 * Run from the repository root; only the marked D: child may be read/written/removed. */
import path from 'node:path';
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createMonarchHttpServer } from '../../../src/app/http-server';
import type { MonarchApplication } from '../../../src/app/application';
import { oscarBridgeHost, oscarBridgeMarker } from './oscar-bridge-host';

const parent = await realpath('.test-tmp');
if (path.parse(parent).root.toUpperCase() !== 'D:\\') throw Error('D-owned-junction-required');
const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-ui-')));
await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
await writeFile(path.join(root, 'selected.txt'), 'Синтетический вход 🟠', { flag: 'wx' });
const token = 'astra-owned-ui-fixture-token';
const actor = { id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/api').digest('hex'), source: 'api' as const };
const host = await oscarBridgeHost(root, { actor, durableSelections: true }); await host.start();
let kernelCalls = 0;
const dispatch = host.kernel.executeActionProposal.bind(host.kernel);
host.kernel.executeActionProposal = (...args) => { kernelCalls++; return dispatch(...args); };
const publicRoot = path.join(root, 'public'); await mkdir(path.join(publicRoot, 'modules'), { recursive: true });
for (const name of ['api.js', 'astra-turn-panel.js', 'astra-turn-panel.css'])
  await copyFile(path.resolve('src/ui/public/modules', name), path.join(publicRoot, 'modules', name));
const config = { deployment: 'isolated-validation', conversationId: 'conversation' };
await writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Astra V3 · изолированная проверка</title></head><body style="margin:0;background:#100f0d"><main id="astra"></main><script type="module" src="/entry.js"></script></body></html>', { flag: 'wx' });
await writeFile(path.join(publicRoot, 'entry.js'), `import { mountAstraTurnPanel, astraSelectionTargets } from './modules/astra-turn-panel.js';
import { fetchOscarAstraSelections } from './modules/api.js';
const config = ${JSON.stringify(config)};
config.targets = astraSelectionTargets(await fetchOscarAstraSelections(config.conversationId));
// The URL carries only a task ID for explicit durable reload, not source authority.
const turnId = new URL(location.href).searchParams.get('turnId'); if (turnId) config.turnId = turnId;
const pendingRequestId = new URL(location.href).searchParams.get('pendingRequestId'); if (pendingRequestId) config.pendingRequestId = pendingRequestId;
mountAstraTurnPanel(document.querySelector('#astra'), config, { onTurnLinked(turnId) {
  const url = new URL(location.href); url.searchParams.delete('pendingRequestId'); url.searchParams.set('turnId', turnId); history.replaceState(null, '', url);
}, onSubmissionPending(requestId) {
  const url = new URL(location.href); url.searchParams.delete('turnId'); url.searchParams.set('pendingRequestId', requestId); history.replaceState(null, '', url);
}, onSubmissionCancelled() {
  const url = new URL(location.href); url.searchParams.delete('pendingRequestId'); history.replaceState(null, '', url);
} });`, { flag: 'wx' });
const app = new Proxy<MonarchApplication>({} as MonarchApplication, { get: (_target, key) => {
  if (key === 'oscarTurnCoordinator') return host.coordinator;
  if (key === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: false, internetEnabled: false, historyContextEnabled: false });
  throw Error('product-access-forbidden:' + String(key));
} });
let inner: ReturnType<typeof createMonarchHttpServer>;
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(deadline);
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await host.close();
  if (await realpath(root) !== root || path.dirname(root) !== parent || !path.basename(root).startsWith('astra-v3-oscar-ui-')
    || await readFile(path.join(root, '.fixture-marker'), 'utf8') !== oscarBridgeMarker) throw Error('cleanup-boundary');
  await rm(root, { recursive: true, force: false }); process.stdout.write('owned-ui-cleanup-complete\n');
}
const server = createServer((request, response) => {
  if (!request.url?.startsWith('/__fixture/')) { inner.emit('request', request, response); return; }
  if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end(); return; }
  void (async () => {
    if (request.method === 'POST' && request.url === '/__fixture/stop') { response.writeHead(200).end('{}'); await stop(); return; }
    if (request.method !== 'GET' || request.url !== '/__fixture/evidence') { response.writeHead(404).end(); return; }
    let content: string | null = null;
    try { content = await readFile(path.join(root, 'Новый отчёт.txt'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ kernelCalls, ...host.counts(), content,
      contentDigest: content === null ? null : createHash('sha256').update(content).digest('hex'),
      turns: (await host.persistentStore.listTurns()).map(turn => ({ id: turn.id, status: turn.status, outcome: turn.outcome?.kind })) }));
  })().catch(error => { response.writeHead(500).end(JSON.stringify({ error: String(error) })); });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
inner = createMonarchHttpServer({ app, publicDirectory: publicRoot, apiToken: token, requireApiToken: true,
  host: '127.0.0.1', port: (server.address() as { port: number }).port,
  astraSelections: host.selections!,
  desktopAttestationToken: 'unused-owned-desktop-only', allowNonLoopbackMutations: false, astraOscarTurns: true });
const deadline = setTimeout(() => { void stop(); }, 15 * 60 * 1000);
process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, root }) + '\n');
