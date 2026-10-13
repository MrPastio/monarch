/** Actual Electron/IPC/HTTP/Kernel proof host. Dialog answers are CONTROLLED
 * synthetic ports until live Windows modal acceptance is available. */
import path from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { oscarBridgeHost, oscarBridgeMarker } from './oscar-bridge-host';
import { conversationMemoryHost } from './conversation-memory-host';
import { attachAstraDesktopHost } from '../../../src/app/astra-desktop-host';
import { AstraDesktopConversations } from '../../../src/app/astra-desktop-conversations';
import { createMonarchHttpServer } from '../../../src/app/http-server';
import type { MonarchApplication } from '../../../src/app/application';
import { ComputerModule, type ComputerNativeProvider } from '../../../src/modules/computer';
import { ComputerUseNativeBridge } from '../../../src/modules/computer/native-bridge';
import type { SyntheticComputerSource } from './computer-source';
let closeConversationMemory: (() => Promise<void>) | undefined;
async function main() {
  const root = process.argv.at(-1)!;
  const parent = realpathSync('.test-tmp');
  if (realpathSync(root) !== root || path.dirname(root) !== parent || path.parse(parent).root.toUpperCase() !== 'D:\\'
    || !path.basename(root).startsWith('astra-v3-oscar-native-') || readFileSync(path.join(root, '.fixture-marker'), 'utf8') !== oscarBridgeMarker)
    throw Error('native-owned-root-required');
  for (const name of ['userData', 'sessionData', 'crashDumps', 'logs'] as const) {
    const directory = path.join(root, name); mkdirSync(directory, { recursive: true }); app.setPath(name, directory);
  }
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update');
  // The fixture owns shutdown ordering. Destroying the renderer must not quit
  // Electron while coordinator/journal shutdown is still awaiting completion.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const token = 'owned-native-desktop-attestation', actor = { source: 'desktop' as const,
    id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') };
  const multi = process.env.MONARCH_ASTRA_TEST_CONVERSATIONS === '1';
  const computerMode = process.env.MONARCH_ASTRA_TEST_COMPUTER === '1';
  const realComputer = process.env.MONARCH_ASTRA_TEST_REAL_COMPUTER ? JSON.parse(process.env.MONARCH_ASTRA_TEST_REAL_COMPUTER) as {
    windowRef: string; processId: number; title: string; controlPort: number; controlToken: string } : null;
  if (realComputer && (!computerMode || Object.keys(realComputer).length !== 5 || !/^hwnd:[0-9a-fA-F]{1,16}$/u.test(realComputer.windowRef)
    || !Number.isSafeInteger(realComputer.processId) || typeof realComputer.title !== 'string' || !Number.isSafeInteger(realComputer.controlPort)
    || !/^[a-f0-9-]{36}$/u.test(realComputer.controlToken))) throw Error('invalid-real-computer-fixture');
  const referenceModel = process.env.MONARCH_ASTRA_TEST_REFERENCE_MODEL ? JSON.parse(process.env.MONARCH_ASTRA_TEST_REFERENCE_MODEL) as {
    endpoint: string; hostGeneration: string; modelDigest: string; bearerToken: string; realModel: boolean; timeoutMs?: number } : null;
  const cases = referenceModel ? JSON.parse(readFileSync(path.resolve('tests/fixtures/agent-v3/reference-cases.json'), 'utf8')) as Record<string, { materials: string[] }> : null;
  const caseId = process.env.MONARCH_ASTRA_TEST_REFERENCE_CASE ?? 'project';
  if (cases && !Object.hasOwn(cases, caseId)) throw Error('unknown-reference-case');
  const materials = cases?.[caseId]?.materials;
  let modelGenerations = 0; const preparedSurfaces: string[] = [];
  const modelTransport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/prepare')) preparedSurfaces.push(JSON.parse(String(init!.body)).surface);
    if (String(url).endsWith('/generate')) modelGenerations++;
    return fetch(url, init);
  };
  const realControl = async (input: unknown) => { if (!realComputer) throw Error('real-computer-unavailable');
    const response = await fetch('http://127.0.0.1:' + realComputer.controlPort, { method: 'POST', headers: {
      Authorization: 'Bearer ' + realComputer.controlToken, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(3000) });
    const value = await response.json(); if (!response.ok) throw Error('real-computer-control:' + JSON.stringify(value)); return value as any; };
  let realComputerSource: SyntheticComputerSource | undefined;
  if (realComputer) {
    const bridge = new ComputerUseNativeBridge({ monarchRoot: process.cwd(), runtimeRoot: path.join(root, 'real-computer-native'),
      prebuiltBinaryPath: 'D:\\Monarch-test-tmp-astra-v3\\astra-v3-computer-native-0l8LqK\\native\\bin\\monarch-computer-use.exe' });
    const inspected = await bridge.inspectWindow(realComputer.windowRef, AbortSignal.timeout(3000));
    if (inspected.processId !== realComputer.processId || inspected.title !== realComputer.title) throw Error('real-computer-identity');
    const window = { windowRef: realComputer.windowRef, processId: realComputer.processId, processInstanceId: inspected.processInstanceId,
      processName: 'electron-owned-fixture', title: realComputer.title, minimized: false, foreground: false,
      bounds: { x: 0, y: 0, width: 680, height: 360 } };
    let captures = 0, listings = 0, inputs = 0;
    const provider: ComputerNativeProvider = { status: () => bridge.status(), listWindows: async () => { listings++; return [structuredClone(window)]; },
      observe: async (...args) => { if (args[0] !== window.windowRef) throw Error('real-computer-capture-target'); captures++;
        const identity = await realControl({ kind: 'identity' }); if (identity.windowRef !== window.windowRef || identity.destroyed || !identity.visible)
          throw Error('real-computer-window-changed'); return bridge.observe(...args); },
      act: async (request, signal) => { if (request.windowRef !== window.windowRef || request.expectedProcessId !== window.processId
          || request.expectedProcessInstanceId !== window.processInstanceId || request.expectedTitle !== window.title || request.action.kind !== 'type'
          || request.action.textMode !== 'replace' || request.action.text !== '  ASTRA_OSCAR_ACTION_🟠  ' || inputs !== 0)
          throw Error('real-computer-input-forbidden'); inputs++; return bridge.act(request, signal); } };
    const module = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'real-computer-runtime'),
      observationRoot: path.join(root, 'observations'), controlStatePath: path.join(root, 'real-computer-control.json'), nativeProvider: provider,
      visionAnalyzer: { analyze: async () => { throw Error('vision-forbidden'); } } });
    realComputerSource = { module, provider, window, counts: () => ({ captures, listings, inputs }) };
  }
  let memory!: Awaited<ReturnType<typeof conversationMemoryHost>>;
  const host = await oscarBridgeHost(root, { actor, durableSelections: true, computer: computerMode, computerPlans: computerMode,
    ...(realComputerSource ? { computerSource: realComputerSource } : {}),
    persistMessage: message => memory.persist(message),
    ...(referenceModel ? { referenceInputs: true, model: { ...referenceModel, fetch: modelTransport } } : {}) });
  const directory = multi ? new AstraDesktopConversations({ deployment: 'isolated-validation', scopeId: 'native_desktop', canonicalRoot: root,
    journal: host.journal, actor, initialConversationId: 'conversation', getTurn: id => host.coordinator.getTurn(id) }) : null;
  // Exact predetermined synthetic cohort only. No product history discovery.
  memory = await conversationMemoryHost(root, directory?.reservedSourceIds() ?? []); closeConversationMemory = memory.close;
  await host.start();
  let failProjection = false; const find = host.bridge.find.bind(host.bridge);
  host.bridge.find = turn => { if (failProjection) throw Error('owned-projection-unavailable'); return find(turn); };
  let kernelCalls = 0, dialogCalls = 0, holdState = false, releaseState: (() => void) | null = null;
  let holdDialog = false, releaseDialog: (() => void) | null = null;
  let loseConversationReply = false, lostConversationReplies = 0;
  const nativeIpc: Pick<typeof ipcMain, 'handle' | 'removeHandler'> = {
    handle: (channel, handler) => ipcMain.handle(channel, async (event, value) => {
      const result = await handler(event, value);
      if (loseConversationReply && channel === 'monarch:astra-conversations' && ['create', 'select'].includes(value?.kind)) {
        loseConversationReply = false; lostConversationReplies++; throw Error('synthetic-conversation-reply-lost-after-commit');
      }
      return result;
    }), removeHandler: channel => ipcMain.removeHandler(channel),
  };
  const dispatch = host.kernel.executeActionProposal.bind(host.kernel);
  host.kernel.executeActionProposal = (...args) => { kernelCalls++; return dispatch(...args); };
  for (const [name, text] of [['selected.txt', 'baseline'], ['Выбранный вход.txt', materials ? materials[0]! : 'Native selected bytes 🟠'],
    ...(materials ? [['Второй материал.txt', materials[1]!]] : [])])
    if (!existsSync(path.join(root, name!))) await writeFile(path.join(root, name!), text!, { flag: 'wx' });
  const publicRoot = path.join(root, 'public'); await mkdir(path.join(publicRoot, 'modules'), { recursive: true });
  for (const name of ['api.js', 'astra-turn-panel.js', 'astra-turn-panel.css', 'astra-desktop-pane.js'])
    await copyFile(path.resolve('src/ui/public/modules', name), path.join(publicRoot, 'modules', name));
  await writeFile(path.join(publicRoot, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'"><title>Astra V3 · native isolated</title></head><body style="margin:0;background:#100f0d"><main></main><script type="module" src="/entry.js"></script></body></html>`);
  if (process.env.MONARCH_ASTRA_TEST_UI === 'oscar-composer') {
    await copyFile(path.join(root, 'oscar-entry.mjs'), path.join(publicRoot, 'modules', 'entry.js'));
    await copyFile(path.resolve('src/ui/public/index.html'), path.join(publicRoot, 'oscar-source.html'));
    for (const name of ['styles-v2.css', 'ui-refresh.css']) await copyFile(path.resolve('src/ui/public', name), path.join(publicRoot, name));
    await writeFile(path.join(publicRoot, 'index.html'), (await readFile(path.join(publicRoot, 'index.html'), 'utf8'))
      .replace('</head>', '<link rel="stylesheet" href="/styles-v2.css"><link rel="stylesheet" href="/ui-refresh.css"></head>')
      .replace('src="/entry.js"', 'src="/modules/entry.js"'));
  } else await writeFile(path.join(publicRoot, 'entry.js'), "import { mountAstraDesktopPane } from './modules/astra-desktop-pane.js'; await mountAstraDesktopPane(document.querySelector('main')); ");
  let inner: ReturnType<typeof createMonarchHttpServer>;
  const unexpectedApiRequests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/') && !/^\/api\/oscar\/(?:turns(?:\/|$)|turn-cancellations$|astra\/selections(?:\/|$))/u.test(pathname)
      && !(computerMode && request.method === 'GET' && /^\/api\/astra\/v3\/computer-observe-tasks\/[A-Za-z0-9_-]+$/u.test(pathname))) {
      unexpectedApiRequests.push(request.method + ' ' + pathname); response.writeHead(403); response.end('owned-astra-route-only'); return;
    }
    inner.emit('request', request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const application = new Proxy<MonarchApplication>({} as MonarchApplication, { get: (_target, key) => {
    if (key === 'oscarTurnCoordinator') return host.coordinator;
    if (key === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: false, internetEnabled: false, historyContextEnabled: false });
    throw Error('native-product-access-forbidden:' + String(key));
  } });
  inner = createMonarchHttpServer({ app: application, publicDirectory: publicRoot, host: '127.0.0.1', port: (server.address() as { port: number }).port,
    desktopAttestationToken: token, apiToken: 'unused-native-api', requireApiToken: true, astraOscarTurns: true, astraSelections: host.selections!,
    ...(computerMode ? { astraTasks: host.facade } : {}) });
  const window = new BrowserWindow({ show: false, width: 1100, height: 960, webPreferences: { offscreen: true, backgroundThrottling: false,
    contextIsolation: true, sandbox: true, nodeIntegration: false,
    preload: path.resolve('desktop/electron/astra-isolated-preload.cjs') } });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(origin + '/') && details.url !== 'about:blank' });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const desktop = attachAstraDesktopHost({ deployment: 'isolated-validation', scopeId: 'native_desktop', canonicalRoot: root,
    journal: host.journal, selections: host.selections!, coordinator: host.coordinator, ipcMain: nativeIpc, window, origin, actor,
    conversationId: 'conversation', desktopAttestationToken: token,
    referenceInputs: host.facade.referenceInputsEnabled,
    ...(computerMode ? { computer: { selections: host.windowSelections!, actionPlans: host.actionPlans!, facade: host.facade, kernel: host.kernel,
      module: host.computer!.module,
      dialog: { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) } } } : {}),
    ...(multi ? { conversations: { readHistory: (id: string, options: { messageLimit: number; before?: number }) =>
      memory.history(id, options.messageLimit, options.before).catch(error => { if (error.statusCode === 404) return null; throw error; }) } } : {}),
    dialog: { showOpenDialog: async () => { dialogCalls++; if (holdDialog) await new Promise<void>(resolve => { releaseDialog = resolve; });
      return { canceled: false, filePaths: [path.join(root, referenceModel && dialogCalls === 3 ? 'Второй материал.txt' : 'Выбранный вход.txt')] }; },
      showSaveDialog: async () => { dialogCalls++; return { canceled: false, filePath: path.join(root, 'Выбранный итог.txt') }; } } });
  const save = desktop.state.pending.bind(desktop.state);
  desktop.state.pending = async (...args) => { const result = await save(...args); if (holdState) await new Promise<void>(resolve => { releaseState = resolve; }); return result; };
  let stopping: Promise<void> | null = null;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      clearTimeout(deadline); releaseState?.(); releaseDialog?.(); desktop.dispose();
      // Close the renderer's live SSE/HTTP consumers BEFORE closing their server.
      // window-all-closed above holds Electron until all durable owners stop.
      window.destroy();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await host.close(); await memory.close();
      process.stdout.write('owned-native-host-stopped\n');
    })();
    return stopping;
  };
  (globalThis as unknown as { astraNativeProof: unknown }).astraNativeProof = { root, origin, stop,
    progressFault: (active: boolean) => host.progressFault(active),
    projectionFailure: async (active: boolean) => { failProjection = active; await host.flush(); },
    holdPending: () => { holdState = true; }, releasePending: () => { holdState = false; releaseState?.(); releaseState = null; },
    holdDialog: () => { holdDialog = true; }, releaseDialog: () => { holdDialog = false; releaseDialog?.(); releaseDialog = null; },
    loseConversationReply: () => { loseConversationReply = true; },
    evidence: async () => { let content: string | null = null; try { content = await readFile(path.join(root, 'Выбранный итог.txt'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const history = await memory.history().catch(error => { if (error.statusCode === 404) return null; throw error; });
      const sources = desktop.directory?.read();
      const histories = sources ? await Promise.all(sources.conversations.map(async source => ({ conversationId: source.conversationId,
        history: await memory.history(source.conversationId).catch(error => { if (error.statusCode === 404) return null; throw error; }) }))) : [];
      const computer = host.computer ? { ...host.computer.counts(),
        inputs: realComputerSource ? host.computer.counts().inputs : host.computerActionCalls(),
        ...(realComputer ? { actualValue: (await realControl({ kind: 'read-owned-value' })).value } : {}) } : undefined;
      return { kernelCalls, dialogCalls, lostConversationReplies, ...host.counts(), computer, modelGenerations, preparedSurfaces, content, surface: desktop.state.read(), unexpectedApiRequests, sources, histories,
        history, progressionFailures: host.progressionFailures, conversationMemory: await memory.evidence(),
        turns: (await host.persistentStore.listTurns()).map(turn => ({ id: turn.id, status: turn.status, sourceText: turn.request.text, outcome: turn.outcome?.kind })) }; } };
  const deadline = setTimeout(() => { void stop().finally(() => app.quit()); }, 5 * 60 * 1000);
  await window.loadURL(origin); process.stdout.write(JSON.stringify({ marker: 'astra-native-ready', origin, root }) + '\n');
}
void main().catch(async error => { process.stderr.write(String(error.stack || error) + '\n');
  try { await closeConversationMemory?.(); } finally { app.exit(1); } });
