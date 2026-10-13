/** Real native capture of ONE process-owned synthetic window. Candidate listing
 * is fixture-only; no enumeration of user windows, model or product boot.
 * Default forbids native input; --replace-owned-text permits two direct module
 * replacements. --astra-approved-action permits exactly one replacement through
 * authenticated HTTP -> Astra task -> scheduler -> Kernel -> native bridge.
 * --oscar-turn composes that same action through the real durable Oscar Turn and
 * conversation outbox without changing the executor or native authority.
 * Default native choice is interactive for independent UI QA; --controlled-choice
 * explicitly bypasses only the chooser and NEVER counts as native-dialog acceptance. */
import path from 'node:path';
import { mkdtemp, realpath, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MonarchKernel } from '../../../src/core/kernel';
import { ComputerModule } from '../../../src/modules/computer';
import { ComputerUseNativeBridge, type ComputerNativeProvider } from '../../../src/modules/computer/native-bridge';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { MonarchAstraTaskFacade } from '../../../src/app/astra-task-facade';
import { AstraComputerSelectionStore, type AstraWindowChoice } from '../../../src/app/astra-computer-selection-store';
import { AstraComputerPicker } from '../../../src/app/astra-computer-picker';
import { createMonarchHttpServer } from '../../../src/app/http-server';
import type { MonarchApplication } from '../../../src/app/application';
import { AstraOscarBridge } from '../../../src/app/astra-oscar-bridge';
import { OscarTurnCoordinator, type OscarPersistedMessage } from '../../../src/oscar-turn/coordinator';
import { InMemoryOscarTurnStore, LocalJsonOscarTurnStore } from '../../../src/oscar-turn/turn-store';
import { isolatedLocalSecurity } from './local-security';

function check(value: unknown, code: string): asserts value { if (!value) throw Error('owned-live-computer:' + code); }
async function main() {
  const controlledChoice = process.argv.includes('--controlled-choice');
  const replaceOwnedText = process.argv.includes('--replace-owned-text');
  const approvedAction = process.argv.includes('--astra-approved-action');
  const restartReconcile = process.argv.includes('--restart-reconcile');
  const oscarTurn = process.argv.includes('--oscar-turn');
  check(!restartReconcile || approvedAction, 'restart-reconcile-requires-approved-action');
  check(!oscarTurn || approvedAction && !restartReconcile, 'oscar-turn-requires-approved-nonrestart-action');
  const parent = await realpath('.test-tmp'); check(parent === 'D:\\Monarch-test-tmp-astra-v3', 'parent');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-live-computer-')));
  check(path.dirname(root) === parent, 'child'); await writeFile(path.join(root, '.fixture-marker'), 'astra-owned-native-window-only', { flag: 'wx' });
  await mkdir(path.join(root, 'temp')); console.log('OWNED_LIVE_COMPUTER_ROOT', root);
  const env: NodeJS.ProcessEnv = { ...process.env, TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp') }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [path.resolve('tests/fixtures/agent-v3/computer-observe-window.mjs'), root,
    ...(replaceOwnedText || approvedAction ? ['owned-replace-qa'] : [])],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  type OwnedWindow = AstraWindowChoice & { marker: string; controlPort: number; controlToken: string };
  let output = '', stdout = '', errors = '', resolveReady!: (value: OwnedWindow) => void, rejectReady!: (error: Error) => void;
  let liveWindow: OwnedWindow | undefined;
  const ready = new Promise<OwnedWindow>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-16384); output += String(chunk);
    if (output.length > 65536) { rejectReady(Error('owned-stdout-budget')); child.kill(); return; }
    for (;;) { const end = output.indexOf('\n'); if (end < 0) break; const line = output.slice(0, end); output = output.slice(end + 1);
      if (!line.startsWith('ASTRA_WINDOW_EVENT ')) continue; // Electron diagnostics are not protocol events; retained separately.
      try { const value = JSON.parse(line.slice('ASTRA_WINDOW_EVENT '.length)); if (value.kind === 'ready') resolveReady(value);
        else if (value.kind === 'error') rejectReady(Error(value.error));
      } catch { rejectReady(Error('owned-window-protocol')); } }
  });
  child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-4096); });
  child.once('error', error => rejectReady(error));
  child.once('exit', code => rejectReady(Error('owned-window-exit:' + code + ':' + errors)));
  const startupTimer = setTimeout(() => rejectReady(Error('owned-window-startup-timeout')), 20000);
  let kernel: MonarchKernel | undefined, journal: AstraJournal | undefined, facade: MonarchAstraTaskFacade | undefined;
  let coordinator: OscarTurnCoordinator | undefined, turnBridge: AstraOscarBridge | undefined;
  const oscarDeliveries: OscarPersistedMessage[] = [];
  const invocations: unknown[] = [], nativeFailures: string[] = [];
  let restartSettlementCuts = 0, restartNativeActions = 0, restartKernelInvocations = 0;
  let picker: AstraComputerPicker | undefined, server: ReturnType<typeof createMonarchHttpServer> | undefined;
  try {
    const window = liveWindow = await ready; clearTimeout(startupTimer); check(window.processId === child.pid, 'process-binding');
    check(Number.isInteger(window.controlPort) && window.controlPort > 0 && window.controlPort <= 65535
      && /^[a-f0-9-]{36}$/u.test(window.controlToken), 'control-binding');
    const command = async (input: unknown, signal: AbortSignal) => {
      const response = await fetch('http://127.0.0.1:' + window.controlPort, { method: 'POST', headers: { Authorization: 'Bearer ' + window.controlToken,
        'Content-Type': 'application/json' }, body: JSON.stringify(input), signal }); const value = await response.json();
      check(response.ok, 'owned-control:' + JSON.stringify(value)); return value;
    };
    console.log('OWNED_WINDOW_READY', JSON.stringify({ title: window.title, processId: window.processId }));
    const bridge = new ComputerUseNativeBridge({ monarchRoot: process.cwd(), runtimeRoot: path.join(root, 'native'),
      prebuiltBinaryPath: 'D:\\Monarch-test-tmp-astra-v3\\astra-v3-computer-native-0l8LqK\\native\\bin\\monarch-computer-use.exe' });
    const ownedSummary = await bridge.inspectWindow(window.windowRef, AbortSignal.timeout(3000));
    check(ownedSummary.processId === child.pid && ownedSummary.title === window.title
      && /^process:[a-f0-9]{64}$/u.test(ownedSummary.processInstanceId), 'owned-process-incarnation');
    window.processInstanceId = ownedSummary.processInstanceId;
    let captures = 0, listings = 0, models = 0, nativeActions = 0;
    const allowedText = approvedAction ? ['  ASTRA_APPROVED_HTTP_REPLACE_🟠  '] : ['  ASTRA_NATIVE_REPLACE_🟠  ', ''];
    const provider: ComputerNativeProvider = { status: () => bridge.status(), listWindows: async () => { listings++;
      return [{ ...window, minimized: false, foreground: false, bounds: { x: 0, y: 0, width: 680, height: 360 } }]; },
      observe: async (...args) => { check(args[0] === window.windowRef, 'capture-target'); captures++;
        const identity = await command({ kind: 'identity' }, AbortSignal.timeout(1000));
        check(identity.windowRef === window.windowRef && !identity.destroyed && identity.visible, 'owned-window-identity-changed:' + JSON.stringify(identity));
        try { return await bridge.observe(...args); } catch (error) { nativeFailures.push(String(error)); throw error; } },
      act: async (request, signal) => {
        check((replaceOwnedText || approvedAction) && request.windowRef === window.windowRef && request.expectedProcessId === child.pid
          && request.expectedProcessInstanceId === window.processInstanceId
          && request.expectedTitle === window.title && request.action.kind === 'type' && request.action.textMode === 'replace'
          && request.action.text === allowedText[nativeActions] && nativeActions < 2, 'native-input-forbidden');
        nativeActions++; return bridge.act(request, signal);
      } };
    const computer = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'runtime'), observationRoot: path.join(root, 'observations'),
      controlStatePath: path.join(root, 'control.json'), nativeProvider: provider, visionAnalyzer: { analyze: async () => { throw Error('vision-forbidden'); } } });
    kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: restartReconcile ? 'agency' : false, permissionProfile: { sandboxMode: 'read-only',
      approvalPolicy: approvedAction ? 'on-request' : 'never' } });
    const execute = kernel.executeActionProposal.bind(kernel);
    kernel.executeActionProposal = async (...args) => { const value = await execute(...args);
      const actionOutput = value.proposal.capabilityId.startsWith('computer.window.') && value.result.ok
        ? value.result.output as Record<string, any> : undefined;
      invocations.push({ capabilityId: value.proposal.capabilityId, ok: value.result.ok, error: value.result.error,
        summary: value.result.summary, metadata: value.result.metadata, ...(actionOutput ? { recoveryShape: {
          outputKeys: Object.keys(actionOutput), afterKeys: Object.keys(actionOutput.after ?? {}),
          windowKeys: Object.keys(actionOutput.after?.window ?? {}), screenshotKeys: Object.keys(actionOutput.after?.screenshot ?? {}),
          performed: actionOutput.performed, verified: actionOutput.verified, actionReceiptId: actionOutput.actionReceiptId,
          beforeObservationId: actionOutput.beforeObservationId, afterObservationId: actionOutput.afterObservationId,
          afterObservationMatches: actionOutput.after?.observationId === actionOutput.afterObservationId,
          observedAt: actionOutput.after?.observedAt, processId: actionOutput.after?.window?.processId,
          processInstanceId: actionOutput.after?.window?.processInstanceId,
          titleDigest: typeof actionOutput.after?.window?.title === 'string'
            ? 'sha256:' + createHash('sha256').update(actionOutput.after.window.title).digest('hex') : null,
          screenshotSha256: actionOutput.after?.screenshot?.sha256, textVerification: actionOutput.textVerification } } : {}) }); return value; };
    kernel.registerModule(computer); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start(); computer.control.start('owned-fixture-user');
    journal = new AstraJournal(path.join(root, 'journal.sqlite'));
    if (restartReconcile) {
      const appendAtomic = journal.appendAtomic.bind(journal);
      journal.appendAtomic = ((operation, guard) => {
        const checkpoint = operation.primary.checkpoint as Record<string, unknown>;
        if (operation.primary.streamId.startsWith('computer_action_') && checkpoint.phase === 'settled') {
          restartSettlementCuts++; throw Error('owned-after-ledger-before-astra-restart-cut');
        }
        return appendAtomic(operation, guard);
      }) as typeof journal.appendAtomic;
    }
    const token = 'owned-native-desktop';
    const actor = { source: 'desktop' as const, id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') };
    const source = { actor, conversationId: 'owned_native_chat', epoch: 'owned_page' };
    const store = new AstraComputerSelectionStore({ deployment: 'isolated-validation', journal, scopeId: 'native_computer', onRevoked: () => facade?.notifySourceChange() });
    let actionPlan: any;
    facade = new MonarchAstraTaskFacade({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: 'native_computer', kernel, journal,
      computerCatalog: store, catalog: { resolve: () => { throw Error('file-read-forbidden'); } }, policy: { expectedModelDigest: 'sha256:' + 'c'.repeat(64) },
      ...(approvedAction ? { computerActionCatalog: { resolve: (selectionId: string, context: any) => {
        check(actionPlan && selectionId === actionPlan.selectionId && context.actor.id === actor.id && context.actor.source === actor.source
          && context.conversationId === source.conversationId, 'action-plan-not-found'); return structuredClone(actionPlan);
      } } } : {}),
      client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: 'http://127.0.0.1:1', bearerToken: 'not-used', hostGeneration: 'no-model',
        fetch: async () => { models++; throw Error('model-forbidden'); } }) });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId: 'native_computer', journal, adapters: facade.adapters }); facade.attach(scheduler);
    if (oscarTurn) {
      turnBridge = new AstraOscarBridge(facade, () => actor);
      coordinator = new OscarTurnCoordinator({ astra: turnBridge,
        persistentStore: new LocalJsonOscarTurnStore(path.join(root, 'oscar-turns.json')),
        volatileStore: new InMemoryOscarTurnStore(),
        answerExecutor: async () => { throw Error('answer-execution-forbidden'); },
        persistMessage: async message => {
          const previous = oscarDeliveries.find(item => item.messageId === message.messageId);
          check(!previous || JSON.stringify(previous) === JSON.stringify(message), 'oscar-delivery-conflict');
          check(!message.requiredPreviousMessageId || oscarDeliveries.some(item => item.messageId === message.requiredPreviousMessageId),
            'oscar-delivery-predecessor');
          if (!previous) oscarDeliveries.push(structuredClone(message));
          return { disposition: previous ? 'duplicate' as const : 'created' as const };
        } });
      await facade.startWithSourceRestore(() => coordinator!.start());
    } else facade.start();
    picker = new AstraComputerPicker({ deployment: 'isolated-validation', store, kernel, currentSource: () => source,
      choose: async (windows, signal) => { if (controlledChoice) return 0; console.log('OWNED_NATIVE_DIALOG_WAITING');
        return (await command({ kind: 'choose', windows }, signal)).selected; } });
    const picked = await picker.pick({ version: 1, requestId: 'owned_pick' }, () => { check(child.exitCode === null, 'window-exited'); });
    check(picked.status === 'selected', 'selection-cancelled');
    const app = oscarTurn ? new Proxy({} as MonarchApplication, { get: (_, key) => {
      if (key === 'oscarTurnCoordinator') return coordinator;
      if (key === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: false, internetEnabled: false, historyContextEnabled: false });
      throw Error('product-access-forbidden:' + String(key));
    } }) : {} as MonarchApplication;
    server = createMonarchHttpServer({ app, publicDirectory: root, apiToken: token, desktopAttestationToken: token, requireApiToken: true,
      astraTasks: facade, astraOscarTurns: oscarTurn });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/astra/v3/computer-observe-tasks';
    const headers = { Authorization: 'Bearer ' + token, 'x-monarch-desktop-attestation': token, 'Content-Type': 'application/json' };
    const request = { version: 1, clientRequestId: 'owned_capture', conversationId: source.conversationId, inputMessageId: 'owned_message',
      text: 'Read only the selected synthetic test window.', selectionId: picked.selection.selectionId, privacyMode: 'persistent' };
    const submitted = await fetch(base, { method: 'POST', headers, body: JSON.stringify(request) }); const body = await submitted.json();
    check(submitted.status === 202, 'admission:' + JSON.stringify(body));
    const url = base + '/' + body.task.id + '?conversationId=' + request.conversationId + '&inputMessageId=' + request.inputMessageId;
    let view = body.task; const deadline = Date.now() + 20000;
    while (!view.message && Date.now() < deadline) { await delay(50); const response = await fetch(url, { headers }); check(response.ok, 'poll'); view = (await response.json()).task; }
    await writeFile(path.join(root, 'task-result.json'), JSON.stringify(view, null, 2), { flag: 'wx' });
    check(view.status === 'observed' && view.observation?.authorizesInput === false, 'not-observed:' + view.status);
    check(JSON.stringify(view.observation.elements).includes(window.marker), 'native-text-not-observed');
    const images = (await readdir(path.join(root, 'observations'))).filter(name => name.endsWith('.png')); check(images.length === 1, 'screenshot-count');
    const screenshotPath = path.join(root, 'observations', images[0]!);
    const imageHash = 'sha256:' + createHash('sha256').update(await readFile(screenshotPath)).digest('hex'); check(view.observation.screenshotDigest === imageHash, 'image-digest');
    await fetch(base, { method: 'POST', headers, body: JSON.stringify(request) });
    check(captures === 1 && listings === 1 && models === 0, 'call-count');
    if (approvedAction) {
      const targets = view.observation.elements.filter((item: any) => item.controlType === 'Edit' && item.enabled && !item.offscreen);
      check(targets.length === 1, 'owned-approved-edit-target');
      const action = { kind: 'type' as const, elementId: targets[0].elementId, text: allowedText[0]!, textMode: 'replace' as const };
      actionPlan = { selectionId: 'owned_native_action_plan', actor, conversationId: source.conversationId, revision: 1,
        windowRef: window.windowRef, processId: window.processId, processInstanceId: window.processInstanceId,
        title: window.title, expiresAt: Date.now() + 60_000, timeoutMs: 5000,
        observation: view.observation, action };
      if (oscarTurn) {
        check(coordinator && turnBridge, 'oscar-runtime-missing');
        const turnBase = base.slice(0, base.indexOf('/api/astra/v3/')) + '/api/oscar/turns';
        const actionRequest = { version: 1, clientRequestId: 'owned_oscar_native_action', conversationId: source.conversationId,
          inputMessageId: 'owned_oscar_action_message', text: 'Replace the selected owned editor with the exact reviewed text once.',
          privacyMode: 'persistent', astra: { selectionId: actionPlan.selectionId, goal: { kind: 'computer-action' } } };
        const admitted = await fetch(turnBase, { method: 'POST', headers, body: JSON.stringify(actionRequest) });
        let checkpoint: any = await admitted.json(); check(admitted.status < 300, 'oscar-action-admission:' + JSON.stringify(checkpoint));
        const turnUrl = turnBase + '/' + checkpoint.turn.id; let actionDeadline = Date.now() + 20_000;
        while (checkpoint.turn.status !== 'waiting-for-approval' && Date.now() < actionDeadline) {
          await delay(50); const response = await fetch(turnUrl, { headers }); check(response.ok, 'oscar-approval-poll'); checkpoint = await response.json();
        }
        const approval = checkpoint.events.filter((event: any) => event.type === 'approval.required').at(-1)?.payload;
        check(checkpoint.turn.status === 'waiting-for-approval' && approval?.approvalKind === 'computer-action'
          && approval.action?.text === action.text && approval.action?.textMode === 'replace' && nativeActions === 0,
        'oscar-action-approval-card:' + JSON.stringify(checkpoint));
        const publicApproval = JSON.stringify(approval);
        check(!publicApproval.includes('hwnd:') && !publicApproval.includes('processId') && !publicApproval.includes('processInstanceId')
          && !Object.hasOwn(approval, 'source') && !Object.hasOwn(approval, 'window'), 'oscar-native-identity-leak');
        const decision = { version: 1, conversationId: actionRequest.conversationId, inputMessageId: actionRequest.inputMessageId,
          input: { kind: 'decide', decision: { approvalId: approval.id, approvalDigest: approval.digest,
            messageId: 'owned_oscar_action_approval', decision: 'approve' } } };
        const accepted = await fetch(turnUrl + '/astra-input', { method: 'POST', headers, body: JSON.stringify(decision) });
        check(accepted.status < 300, 'oscar-action-decision:' + await accepted.text());
        actionDeadline = Date.now() + 20_000;
        while (checkpoint.turn.status !== 'succeeded' && Date.now() < actionDeadline) {
          await delay(50); const response = await fetch(turnUrl, { headers }); check(response.ok, 'oscar-result-poll'); checkpoint = await response.json();
        }
        // Terminal Turn state and conversation delivery are distinct durable
        // phases. Drain the real coordinator outbox; never infer delivery from
        // task success or bypass it by writing the assistant message directly.
        for (let i = 0; i < 4 && !oscarDeliveries.some(item => item.role === 'assistant'); i++) {
          await (coordinator as unknown as { drainOutbox(): Promise<void> }).drainOutbox(); await facade.drain();
        }
        const refreshed = await fetch(turnUrl, { headers }); check(refreshed.ok, 'oscar-delivery-read'); checkpoint = await refreshed.json();
        const task = turnBridge.find(checkpoint.turn), actual = await command({ kind: 'read-owned-value' }, AbortSignal.timeout(1000));
        const assistant = oscarDeliveries.find(item => item.role === 'assistant');
        check(checkpoint.turn.status === 'succeeded' && checkpoint.turn.outcome?.kind === 'partial'
          && task?.status === 'observed' && task.message?.verification === 'internal-computer-action-proof'
          && task.message.predecessorMessageId === actionRequest.inputMessageId && nativeActions === 1 && actual.value === action.text
          && oscarDeliveries.some(item => item.role === 'user' && item.messageId === actionRequest.inputMessageId)
          && assistant?.requiredPreviousMessageId === actionRequest.inputMessageId && assistant.taskId === task.id
          && task.message?.delivery === 'acknowledged',
        'oscar-native-result:' + JSON.stringify({ checkpoint, task, nativeActions, actual, oscarDeliveries }));
        const replay = await fetch(turnUrl + '/astra-input', { method: 'POST', headers, body: JSON.stringify(decision) });
        check(replay.status < 300 && nativeActions === 1, 'oscar-action-replay');
        await writeFile(path.join(root, 'astra-approved-native-action-proof.json'), JSON.stringify({ status: 'passed',
          route: 'authenticated-HTTP-OscarTurn-AstraTask-Scheduler-Kernel-ComputerModule-CSharp', turnId: checkpoint.turn.id,
          taskId: task.id, approvalId: approval.id, exactTextDigest: 'sha256:' + createHash('sha256').update(action.text).digest('hex'),
          actualValue: actual.value, nativeActions, realNativeInput: true, astraApprovedEffect: true, throughOscarTurn: true,
          processIncarnationBound: true, processInstanceId: window.processInstanceId, assistantDeliveryBound: true,
          businessCompletionCertified: false, modelCalls: models, userWindowEnumeration: false }, null, 2), { flag: 'wx' });
      } else {
      let actionBase = base.replace('/computer-observe-tasks', '/computer-action-tasks');
      const actionRequest = { version: 1, clientRequestId: 'owned_approved_action', conversationId: source.conversationId,
        inputMessageId: 'owned_action_message', text: 'Replace the selected owned editor with the exact reviewed text once.',
        selectionId: actionPlan.selectionId, privacyMode: 'persistent' };
      const admitted = await fetch(actionBase, { method: 'POST', headers, body: JSON.stringify(actionRequest) });
      const admittedBody = await admitted.json(); check(admitted.status === 202, 'action-admission:' + JSON.stringify(admittedBody));
      const actionUrl = actionBase + '/' + admittedBody.task.id + '?conversationId=' + actionRequest.conversationId
        + '&inputMessageId=' + actionRequest.inputMessageId;
      let actionView = admittedBody.task; let actionDeadline = Date.now() + 20_000;
      while (!actionView.approval && Date.now() < actionDeadline) { await delay(50); const response = await fetch(actionUrl, { headers });
        check(response.ok, 'action-approval-poll'); actionView = (await response.json()).task; }
      check(actionView.status === 'awaiting-approval' && actionView.approval?.action?.text === action.text
        && actionView.approval?.action?.textMode === 'replace' && nativeActions === 0, 'action-approval-card');
      const approval = structuredClone(actionView.approval);
      const decisionUrl = actionUrl.slice(0, actionUrl.indexOf('?')) + '/decide';
      const decision = await fetch(decisionUrl, { method: 'POST', headers, body: JSON.stringify({ version: 1,
        conversationId: actionRequest.conversationId, inputMessageId: actionRequest.inputMessageId,
        approvalId: approval.id, approvalDigest: approval.digest,
        replyMessageId: 'owned_action_approval', decision: 'approve' }) });
      check(decision.ok, 'action-decision:' + await decision.text());
      actionDeadline = Date.now() + 20_000;
      while (!(restartReconcile ? actionView.status === 'indeterminate' && nativeActions === 1 : actionView.message) && Date.now() < actionDeadline) {
        await delay(50); const response = await fetch(actionUrl, { headers });
        check(response.ok, 'action-result-poll'); actionView = (await response.json()).task; }
      const actual = await command({ kind: 'read-owned-value' }, AbortSignal.timeout(1000));
      check(nativeActions === 1 && actual.value === action.text && (restartReconcile ? actionView.status === 'indeterminate'
        && !actionView.message && restartSettlementCuts > 0 : actionView.status === 'observed'
          && actionView.message?.verification === 'internal-computer-action-proof'
          && actionView.message?.predecessorMessageId === actionRequest.inputMessageId),
      'approved-action-result:' + JSON.stringify({ actionView, nativeActions, actual, restartSettlementCuts }));

      if (restartReconcile) {
        picker?.dispose(); picker = undefined;
        if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
        await facade.stop(); facade = undefined;
        await kernel.stop(); kernel = undefined;
        journal.close(); journal = undefined;

        const restartProvider: ComputerNativeProvider = { status: () => bridge.status(),
          listWindows: async () => { throw Error('restart-window-enumeration-forbidden'); },
          observe: async () => { throw Error('restart-capture-forbidden'); },
          act: async () => { restartNativeActions++; throw Error('restart-native-action-forbidden'); } };
        const restartComputer = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'runtime-restart'),
          observationRoot: path.join(root, 'observations-restart'), controlStatePath: path.join(root, 'control-restart.json'),
          nativeProvider: restartProvider, visionAnalyzer: { analyze: async () => { throw Error('restart-vision-forbidden'); } } });
        kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: 'agency', permissionProfile: {
          sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
        const restartExecute = kernel.executeActionProposal.bind(kernel);
        kernel.executeActionProposal = async (...args) => { restartKernelInvocations++; return restartExecute(...args); };
        kernel.registerModule(restartComputer); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
        journal = new AstraJournal(path.join(root, 'journal.sqlite'));
        const restartStore = new AstraComputerSelectionStore({ deployment: 'isolated-validation', journal, scopeId: 'native_computer',
          onRevoked: () => facade?.notifySourceChange() });
        facade = new MonarchAstraTaskFacade({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: 'native_computer', kernel, journal,
          computerCatalog: restartStore, catalog: { resolve: () => { throw Error('restart-file-read-forbidden'); } },
          computerActionCatalog: { resolve: (selectionId: string, context: any) => {
            check(actionPlan && selectionId === actionPlan.selectionId && context.actor.id === actor.id && context.actor.source === actor.source
              && context.conversationId === source.conversationId, 'restart-action-plan-not-found'); return structuredClone(actionPlan);
          } }, policy: { expectedModelDigest: 'sha256:' + 'c'.repeat(64) },
          client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: 'http://127.0.0.1:1', bearerToken: 'not-used',
            hostGeneration: 'no-model', fetch: async () => { models++; throw Error('restart-model-forbidden'); } }) });
        const restartScheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId: 'native_computer', journal,
          adapters: facade.adapters }); facade.attach(restartScheduler); facade.start();
        server = createMonarchHttpServer({ app: {} as MonarchApplication, publicDirectory: root, apiToken: token,
          desktopAttestationToken: token, requireApiToken: true, astraTasks: facade });
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
        actionBase = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/astra/v3/computer-action-tasks';
        const recoveredResponse = await fetch(actionBase + '/' + actionView.id + '/reconcile', { method: 'POST', headers,
          body: JSON.stringify({ version: 1, conversationId: actionRequest.conversationId, inputMessageId: actionRequest.inputMessageId }) });
        const recoveredPayload = await recoveredResponse.json();
        check(recoveredResponse.ok, 'restart-reconcile-http:' + JSON.stringify(recoveredPayload));
        actionView = recoveredPayload.task;
        const recoveredUrl = actionBase + '/' + actionView.id + '?conversationId=' + actionRequest.conversationId
          + '&inputMessageId=' + actionRequest.inputMessageId;
        actionDeadline = Date.now() + 10_000;
        while (!actionView.message && Date.now() < actionDeadline) { await delay(50); const response = await fetch(recoveredUrl, { headers });
          check(response.ok, 'restart-result-poll'); actionView = (await response.json()).task; }
        check(actionView.status === 'observed' && actionView.message?.verification === 'internal-computer-action-proof'
          && actionView.message?.predecessorMessageId === actionRequest.inputMessageId
          && nativeActions === 1 && restartNativeActions === 0 && restartKernelInvocations === 0,
        'restart-recovery-result:' + JSON.stringify({ actionView, nativeActions, restartNativeActions, restartKernelInvocations }));
        const durableLedger = await readFile(path.join(root, 'agency', 'action-ledger.json'), 'utf8');
        check(!durableLedger.includes(window.title) && !durableLedger.includes(action.text) && !durableLedger.includes('elements')
          && durableLedger.includes('monarch.computer-action-recovery-output.v1'), 'restart-ledger-privacy');
      }

      const replayUrl = actionBase + '/' + actionView.id + '/decide';
      const replay = await fetch(replayUrl, { method: 'POST', headers, body: JSON.stringify({ version: 1,
        conversationId: actionRequest.conversationId, inputMessageId: actionRequest.inputMessageId,
        approvalId: approval.id, approvalDigest: approval.digest,
        replyMessageId: 'owned_action_approval', decision: 'approve' }) });
      check(replay.status === 200 && nativeActions === 1 && restartNativeActions === 0, 'action-replay-dispatch');
      await writeFile(path.join(root, 'astra-approved-native-action-proof.json'), JSON.stringify({ status: 'passed',
        route: 'authenticated-HTTP-AstraTask-Scheduler-Kernel-ComputerModule-CSharp', taskId: actionView.id,
        approvalId: approval.id, exactTextDigest: 'sha256:' + createHash('sha256').update(action.text).digest('hex'),
        actualValue: actual.value, nativeActions, realNativeInput: true, astraApprovedEffect: true,
        processIncarnationBound: true, processInstanceId: window.processInstanceId,
        restartReconciled: restartReconcile, restartSettlementCuts, restartNativeActions, restartKernelInvocations,
        businessCompletionCertified: false, modelCalls: models, userWindowEnumeration: false }, null, 2), { flag: 'wx' });
      }
    }
    if (replaceOwnedText) {
      // Separate explicit owned-fixture permit, NOT authority from the observation
      // task or a product Astra effect adapter. Exercise the real module/C# path.
      let observationId = view.observation.observationId, elements = view.observation.elements;
      const replacements = [];
      for (const [index, text] of allowedText.entries()) {
        const targets = elements.filter((item: any) => item.controlType === 'Edit' && item.enabled && !item.offscreen);
        check(targets.length === 1, 'owned-edit-target');
        const result = await computer.executeCapability({ id: 'owned_replace_' + index, intentId: 'owned_replace_' + index,
          moduleId: 'computer', capabilityId: 'computer.window.type', createdAt: new Date().toISOString(), requestedBy: 'user:owned-qa',
          source: 'smoke', confirmed: false, input: { windowRef: window.windowRef, observationId, elementId: targets[0].elementId,
            text, textMode: 'replace' } }, { emit: async () => {}, audit: async () => {} } as any);
        const actual = await command({ kind: 'read-owned-value' }, AbortSignal.timeout(1000));
        await writeFile(path.join(root, 'native-text-attempt-' + index + '.json'), JSON.stringify({ result, actual }, null, 2), { flag: 'wx' });
        check(result.ok, 'native-replace:' + JSON.stringify(result));
        const output = result.output as any;
        check(actual.value === text && output.textVerification?.textMode === 'replace'
          && output.textVerification.valueVerifiedAfterDispatch === true
          && output.textVerification.textSha256 === createHash('sha256').update(text).digest('hex'), 'native-value-proof');
        replacements.push({ text, verification: output.textVerification });
        observationId = output.afterObservationId; elements = output.after.elements;
      }
      check(nativeActions === 2, 'native-action-count');
      await writeFile(path.join(root, 'native-text-proof.json'), JSON.stringify({ status: 'passed', route: 'owned-fixture-ComputerModule-CSharp',
        astraApprovedEffect: false, realNativeInput: true, replacements }, null, 2), { flag: 'wx' });
    }
    const proof = { status: 'passed', taskId: view.id, realNativeCapture: true, realNativeChooser: !controlledChoice, fixtureOnlyCandidateListing: true,
      userWindowEnumeration: false, nativeInput: replaceOwnedText || approvedAction, nativeActions, modelCalls: models, captures, screenshotPath, screenshotDigest: imageHash,
      astraApprovedEffect: approvedAction, processIncarnationBound: true, processInstanceId: window.processInstanceId,
      nativeCompletionCertified: false };
    await writeFile(path.join(root, 'native-capture-proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' }); console.log('REAL_NATIVE_CAPTURE_PASS', JSON.stringify(proof));
  } finally {
    clearTimeout(startupTimer); picker?.dispose();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await coordinator?.stop().catch(() => undefined);
    await facade?.stop(); await kernel?.stop(); journal?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once('exit', () => resolve())); const timer = setTimeout(() => child.kill(), 5000);
      if (liveWindow) await fetch('http://127.0.0.1:' + liveWindow.controlPort, { method: 'POST', headers: { Authorization: 'Bearer ' + liveWindow.controlToken,
        'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'stop' }), signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      else child.kill();
      await stopped; clearTimeout(timer);
    }
    await writeFile(path.join(root, 'window-worker-diagnostics.json'), JSON.stringify({ stdout, stderr: errors, exitCode: child.exitCode, signalCode: child.signalCode }, null, 2), { flag: 'wx' });
    await writeFile(path.join(root, 'invocation-diagnostics.json'), JSON.stringify({ invocations, nativeFailures }, null, 2), { flag: 'wx' });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
