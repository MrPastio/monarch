import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron } from 'playwright-core';
import { mkdtemp, realpath, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { startReferenceModel, runReferenceComposer, referenceCase } from './native-reference-scenario.mjs';
import { runComputerComposer } from './computer-composer-scenario.mjs';
const parent = await realpath('.test-tmp'); assert.equal(path.parse(parent).root.toUpperCase(), 'D:\\');
const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-native-')));
const marker = 'astra-v3-oscar-bridge-synthetic-only';
const composerMode = process.argv.includes('--composer');
const multi = process.argv.includes('--conversations');
const referenceMode = process.argv.includes('--references');
const computerMode = process.argv.includes('--computer');
const realComputerMode = process.argv.includes('--real-computer');
assert.ok(!computerMode || composerMode && !referenceMode, 'computer scenario requires composer and no model scenario');
assert.ok(!realComputerMode || computerMode, 'real computer scenario requires computer mode');
assert.ok(!referenceMode || composerMode && multi, 'reference scenario requires the real composer and conversations');
let referenceModel;
const scenario = referenceMode ? await referenceCase(process.argv.find(arg => arg.startsWith('--reference-case='))?.slice('--reference-case='.length) ?? 'project') : null;
await writeFile(path.join(root, '.fixture-marker'), marker, { flag: 'wx' });
const entry = path.join(root, 'host.cjs');
const require = createRequire(import.meta.url);
await build({ entryPoints: [fileURLToPath(new URL('./native-desktop-host.ts', import.meta.url))], outfile: entry,
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'warning',
  plugins: [{ name: 'owned-existing-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === 'electron' || isBuiltin(args.path) || path.isAbsolute(args.path)) return;
      // Electron does not inherit the ordinary Node NODE_PATH lookup here.
      // Resolve existing dependencies explicitly, without installing/copying them.
      return { path: require.resolve(args.path, { paths: [args.resolveDir || process.cwd()] }), external: true };
    });
  } }],
  banner: { js: 'process.on("uncaughtException", error => { process.stderr.write(String(error.stack || error) + "\\n"); require("electron").app.exit(1); });' } });
assert.ok((await stat(entry)).size < 6 * 1024 * 1024);
if (composerMode) await build({ stdin: { resolveDir: path.resolve('src/ui/public/modules'), sourcefile: 'astra-oscar-owned-entry.mjs', contents: `
  const response = await fetch('/oscar-source.html'); if (!response.ok) throw Error('owned-source-markup');
  const source = new DOMParser().parseFromString(await response.text(), 'text/html');
  const original = source.querySelector('#oscar-section'), section = original.cloneNode(false);
  section.append(original.querySelector('.oscar-thread-shell'), original.querySelector('.claude-bottom-composer'));
  // Only actual composer/thread markup, no product boot scripts or unused menu images.
  for (const image of section.querySelectorAll('img')) image.remove();
  document.querySelector('main').append(section);
  const { initOscarPane } = await import('./oscar-pane.js');
  await initOscarPane(() => { throw Error('legacy-render-forbidden'); }, { astra: { deployment: 'isolated-validation', bridge: window.monarchAstraDesktop } });
  let secondOwnerDenied = false; try { initOscarPane(() => {}); } catch { secondOwnerDenied = true; }
  if (!secondOwnerDenied) throw Error('second-composer-owner-accepted');
  document.documentElement.dataset.astraSingleOwner = 'denied';
` }, outfile: path.join(root, 'oscar-entry.mjs'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome144', logLevel: 'warning' });
const artifact = await mkdtemp('D:/Monarch-artifacts/astra-v3-native-20260831-');
let electron, page, passed = false, closing = false; const errors = [], consoleMessages = [], requestFailures = [], proofs = [];
const env = { ...process.env, NODE_PATH: path.resolve('node_modules'), TEMP: root, TMP: root };
if (composerMode) env.MONARCH_ASTRA_TEST_UI = 'oscar-composer'; else delete env.MONARCH_ASTRA_TEST_UI;
if (multi) env.MONARCH_ASTRA_TEST_CONVERSATIONS = '1'; else delete env.MONARCH_ASTRA_TEST_CONVERSATIONS;
const taskLabel = composerMode ? 'Сообщение Oscar' : 'Задача', submitLabel = composerMode ? 'Отправить' : 'Выполнить выбранное действие';
delete env.ELECTRON_RUN_AS_NODE;
let targetRoot, targetChild, targetDescriptor;
async function startRealComputer() {
  targetRoot = await realpath(await mkdtemp(path.join(parent, 'astra-v3-live-computer-')));
  await writeFile(path.join(targetRoot, '.fixture-marker'), 'astra-owned-native-window-only', { flag: 'wx' });
  const targetEnv = { ...process.env, TEMP: targetRoot, TMP: targetRoot }; delete targetEnv.ELECTRON_RUN_AS_NODE;
  targetChild = spawn(path.resolve('node_modules/electron/dist/electron.exe'),
    [path.resolve('tests/fixtures/agent-v3/computer-observe-window.mjs'), targetRoot, 'owned-replace-qa'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: targetEnv });
  let buffered = '', diagnostics = '';
  targetDescriptor = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('real-computer-start-timeout:' + diagnostics)), 20000);
    targetChild.once('error', error => { clearTimeout(timer); reject(error); });
    targetChild.once('exit', code => { clearTimeout(timer); reject(Error('real-computer-early-exit:' + code + ':' + diagnostics)); });
    targetChild.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
    targetChild.stdout.on('data', chunk => { buffered += String(chunk);
      for (;;) { const end = buffered.indexOf('\n'); if (end < 0) break; const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line.startsWith('ASTRA_WINDOW_EVENT ')) continue;
        try { const value = JSON.parse(line.slice('ASTRA_WINDOW_EVENT '.length)); if (value.kind === 'ready') { clearTimeout(timer); resolve(value); } }
        catch (error) { clearTimeout(timer); reject(error); }
      }
    });
  });
  assert.equal(targetDescriptor.processId, targetChild.pid); env.MONARCH_ASTRA_TEST_REAL_COMPUTER = JSON.stringify({
    windowRef: targetDescriptor.windowRef, processId: targetDescriptor.processId, title: targetDescriptor.title,
    controlPort: targetDescriptor.controlPort, controlToken: targetDescriptor.controlToken });
}
async function stopRealComputer() {
  if (!targetChild) return;
  const exit = new Promise(resolve => targetChild.once('exit', resolve));
  if (targetChild.exitCode === null && targetDescriptor) await fetch('http://127.0.0.1:' + targetDescriptor.controlPort, { method: 'POST', headers: {
    Authorization: 'Bearer ' + targetDescriptor.controlToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'stop' }) }).catch(() => {});
  if (targetChild.exitCode === null) await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (targetChild.exitCode === null) { targetChild.kill(); await exit; }
}
async function launch() {
  closing = false;
  electron = await _electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: [entry, root], cwd: process.cwd(), env, timeout: 25000 });
  electron.process().stderr.on('data', data => { const value = String(data); if (/Error|error|forbidden/i.test(value)) console.log('ELECTRON_DIAGNOSTIC', value.slice(-1500)); });
  electron.process().stdout.on('data', data => console.log('NATIVE_HOST', String(data).slice(-2000)));
  console.log('ELECTRON_BOOT', await electron.evaluate(({ app }) => ({ argv: process.argv, appPath: app.getAppPath(), ready: app.isReady() })));
  page = await electron.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleMessages.push(message.text()); });
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure()?.errorText, closing }));
  await page.getByRole('button', { name: 'Выбрать файл для чтения' }).waitFor({ timeout: 20000 });
  assert.equal(await page.title(), 'Astra V3 · native isolated'); assert.ok(new URL(page.url()).hostname === '127.0.0.1');
  assert.ok((await page.locator('main').innerText()).includes('Astra V3'));
  if (composerMode) assert.equal(await page.locator('html').getAttribute('data-astra-single-owner'), 'denied');
}
const proof = () => electron.evaluate(async () => globalThis.astraNativeProof.evidence());
let secondConversation;
async function selectConversation(id) {
  await page.getByLabel('Разговор Astra', { exact: true }).selectOption(id);
  await page.locator('section[data-conversation-id="' + id + '"]').waitFor();
}
async function refreshHistory(count) {
  const history = page.getByRole('region', { name: 'История разговора', exact: true });
  await history.getByRole('button', { name: 'Обновить историю', exact: true }).click();
  for (let i = 0; i < 60 && await history.locator('article').count() !== count; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await history.locator('article').count(), count); return history;
}
async function waitHistory(count) {
  for (let i = 0; i < 80; i++) {
    const result = await proof();
    if (result.history?.messages.length === count) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('native-history-delivery-timeout:' + count);
}
async function close() {
  if (!electron) return;
  closing = true;
  // Stop existing runtime owners before terminating Electron; no fixture cleanup
  // while it might still hold the SQLite/Turn stores or native profile.
  await electron.evaluate(async () => { await globalThis.astraNativeProof.stop(); });
  await electron.close(); electron = null;
}
try {
  if (computerMode) env.MONARCH_ASTRA_TEST_COMPUTER = '1'; else delete env.MONARCH_ASTRA_TEST_COMPUTER;
  if (realComputerMode) await startRealComputer(); else delete env.MONARCH_ASTRA_TEST_REAL_COMPUTER;
  if (referenceMode) {
    referenceModel = await startReferenceModel(process.argv.find(arg => arg.startsWith('--real-model-root='))?.slice('--real-model-root='.length), scenario);
    env.MONARCH_ASTRA_TEST_REFERENCE_MODEL = JSON.stringify(referenceModel.descriptor);
    env.MONARCH_ASTRA_TEST_REFERENCE_CASE = scenario.id;
  } else delete env.MONARCH_ASTRA_TEST_REFERENCE_MODEL;
  console.log('OWNED_NATIVE_ROOT', root); await launch();
  if (computerMode) {
    await runComputerComposer({ current: () => ({ page, electron }), launch, close, proof, artifact, errors, consoleMessages,
      realComputer: realComputerMode });
    passed = true;
  } else if (referenceMode) {
    await runReferenceComposer({ current: () => ({ page, electron }), launch, close, proof, artifact, model: referenceModel, errors, consoleMessages, scenario,
      recoverFault: process.argv.includes('--recover-fault') });
    passed = true;
  } else {
  const rejected = await page.evaluate(async () => { try { await window.monarchAstraDesktop.pickTarget({ version: 1, requestId: 'bad', access: 'observe', path: 'untrusted' }); return false; } catch { return true; } });
  assert.equal(rejected, true); assert.equal((await proof()).dialogCalls, 0);
  if (multi) {
    const originalSource = await page.evaluate(async () => (await window.monarchAstraDesktop.bootstrap()).source);
    const draft = '  Неотправленный черновик первого чата 🟠\n';
    await page.getByLabel(taskLabel, { exact: true }).fill(draft);
    await electron.evaluate(() => globalThis.astraNativeProof.loseConversationReply());
    await page.getByRole('button', { name: 'Новый разговор', exact: true }).click();
    await page.getByLabel('Разговор Astra').locator('option:checked').filter({ hasText: 'Разговор 2' }).waitFor({ state: 'attached' });
    secondConversation = (await proof()).sources.activeConversationId;
    assert.notEqual(secondConversation, 'conversation'); assert.equal((await proof()).sources.conversations.length, 2);
    assert.equal(await page.getByLabel(taskLabel, { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('Выбранная цель').locator('option').count(), 0);
    const staleDenied = await page.evaluate(async source => {
      try { await window.monarchAstraDesktop.savePending('stale_first_chat', source); return false; } catch { return true; }
    }, originalSource); assert.equal(staleDenied, true);
    assert.equal((await proof()).lostConversationReplies, 1);
    await electron.evaluate(() => globalThis.astraNativeProof.loseConversationReply());
    await selectConversation('conversation'); assert.equal((await proof()).lostConversationReplies, 2);
    assert.equal(await page.getByLabel(taskLabel, { exact: true }).inputValue(), draft);
    const beforeDialog = (await proof()).dialogCalls;
    await electron.evaluate(() => globalThis.astraNativeProof.holdDialog());
    await page.evaluate(() => {
      window.ownedLatePicker = window.monarchAstraDesktop.bootstrap().then(boot => window.monarchAstraDesktop.pickTarget({
        version: 1, requestId: 'late_picker', access: 'observe', source: boot.source })).then(() => 'UNEXPECTED_SUCCESS', error => String(error));
    });
    for (let i = 0; i < 40 && (await proof()).dialogCalls === beforeDialog; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await proof()).dialogCalls, beforeDialog + 1);
    await selectConversation(secondConversation); await electron.evaluate(() => globalThis.astraNativeProof.releaseDialog());
    assert.match(await page.evaluate(() => window.ownedLatePicker), /source-changed/);
    assert.equal(await page.getByLabel('Выбранная цель').locator('option').count(), 0);
    await selectConversation('conversation'); assert.equal((await proof()).kernelCalls, 0);
  }
  await page.getByRole('button', { name: 'Выбрать файл для чтения' }).click();
  await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Выбранный вход.txt' }).waitFor({ state: 'attached' });
  await electron.evaluate(() => globalThis.astraNativeProof.holdPending());
  await page.getByLabel(taskLabel, { exact: true }).fill('Прочитай выбранный файл.');
  await page.getByRole('button', { name: submitLabel, exact: true }).click();
  // Poll the exact owned host state, not timing or an assumed IPC receipt.
  for (let i = 0; i < 50 && (await proof()).surface.state !== 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await proof()).surface.state, 'pending'); assert.equal((await proof()).kernelCalls, 0); assert.deepEqual((await proof()).turns, []);
  await page.reload(); await page.getByRole('button', { name: 'Проверить отправку' }).waitFor();
  await electron.evaluate(() => globalThis.astraNativeProof.releasePending());
  assert.equal(new URL(page.url()).search, ''); assert.equal((await proof()).kernelCalls, 0);
  await page.screenshot({ path: path.join(artifact, 'native-pending-desktop.png') });
  if (composerMode) await page.getByRole('button', { name: 'Остановить задачу Astra' }).click();
  else await page.getByRole('button', { name: 'Отменить отправку' }).click();
  await page.getByRole('status').filter({ hasText: 'Отмена отправки принята' }).waitFor(); assert.equal((await proof()).surface.state, 'idle');
  await page.getByRole('button', { name: 'Выбрать файл для чтения' }).click();
  await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Выбранный вход.txt' }).waitFor({ state: 'attached' });
  const sourceText = '  Прочитай выбранный файл.\nТекст 🟠 без изменения  ';
  const sourceInput = page.getByLabel(taskLabel, { exact: true });
  if (composerMode) {
    await sourceInput.fill('  Прочитай выбранный файл.'); await sourceInput.press('Shift+Enter');
    await sourceInput.pressSequentially('Текст 🟠 без изменения  ');
    assert.equal(await sourceInput.inputValue(), sourceText); await sourceInput.press('Enter');
  } else { await sourceInput.fill(sourceText); await page.getByRole('button', { name: submitLabel, exact: true }).click(); }
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 20000 });
  proofs.push(await waitHistory(2)); assert.equal(proofs.at(-1).kernelCalls, 1); assert.equal(proofs.at(-1).surface.state, 'linked');
  const readTurn = proofs.at(-1).surface.turnId;
  assert.equal(proofs.at(-1).turns.find(turn => turn.id === readTurn).sourceText, sourceText);
  const readHistory = proofs.at(-1).history.messages;
  assert.equal(readHistory[0].content, sourceText); assert.equal(readHistory[0].turn_id, readTurn);
  await close(); await launch();
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor(); assert.equal((await proof()).surface.turnId, readTurn);
  assert.equal((await proof()).kernelCalls, 0);
  assert.deepEqual((await proof()).history.messages, readHistory);
  await page.getByRole('button', { name: 'Выбрать новый файл' }).click();
  await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Выбранный итог.txt' }).waitFor({ state: 'attached' });
  const content = '  Native IPC: точные байты 🟠\n';
  await page.getByLabel(taskLabel, { exact: true }).fill('Обработай выбранную цель согласно явно заданному действию.');
  await page.getByLabel('Содержимое файла — без изменений').fill(content);
  await page.getByRole('button', { name: submitLabel, exact: true }).click();
  await page.getByRole('heading', { name: 'Разрешить создание файла?' }).waitFor({ timeout: 20000 });
  assert.equal((await proof()).content, null); assert.equal((await proof()).kernelCalls, 1);
  await page.screenshot({ path: path.join(artifact, 'native-approval-desktop.png') });
  proofs.push(await waitHistory(3)); const createTurn = proofs.at(-1).surface.turnId;
  const pendingHistory = proofs.at(-1).history.messages;
  if (multi) {
    await selectConversation(secondConversation);
    assert.equal(await page.getByRole('heading', { name: 'Разрешить создание файла?' }).count(), 0);
    assert.equal(await page.getByLabel('Выбранная цель').locator('option').count(), 0);
    await page.getByRole('button', { name: 'Выбрать файл для чтения' }).click();
    await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Выбранный вход.txt' }).waitFor({ state: 'attached' });
    await page.getByLabel(taskLabel, { exact: true }).fill('Только второй разговор: прочитай выбранный файл.');
    await page.getByRole('button', { name: submitLabel, exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 20000 });
    for (let i = 0; i < 80 && (await proof()).histories.find(item => item.conversationId === secondConversation)?.history?.messages.length !== 2; i++)
      await new Promise(resolve => setTimeout(resolve, 50));
    const secondHistory = (await proof()).histories.find(item => item.conversationId === secondConversation).history;
    assert.equal(secondHistory.messages.length, 2); const visible = await refreshHistory(2);
    assert.equal(await visible.locator('article').first().locator('pre').textContent(), secondHistory.messages[0].content);
    assert.equal(secondHistory.messages[1].causal_parent_id, secondHistory.messages[0].client_message_id);
    assert.equal((await proof()).content, null); assert.equal((await proof()).kernelCalls, 2);
    await page.screenshot({ path: path.join(artifact, 'native-second-conversation.png') });
    await selectConversation('conversation');
    await page.getByRole('heading', { name: 'Разрешить создание файла?' }).waitFor();
    assert.equal((await proof()).surface.turnId, createTurn); assert.deepEqual((await proof()).history.messages, pendingHistory);
    proofs[proofs.length - 1] = await proof();
  }
  await close(); await launch();
  await page.getByRole('heading', { name: 'Разрешить создание файла?' }).waitFor({ timeout: 20000 });
  assert.equal((await proof()).surface.turnId, createTurn); assert.equal((await proof()).kernelCalls, 0);
  assert.deepEqual((await proof()).history.messages, pendingHistory);
  await page.getByText(/Runtime требует внимания/).waitFor({ state: 'hidden', timeout: 5000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await electron.evaluate(() => globalThis.astraNativeProof.projectionFailure(true));
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await page.getByText('Runtime требует внимания: source-projection-failed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Разрешить один раз' }).isDisabled(), true);
  assert.equal((await proof()).kernelCalls, 0); assert.equal((await proof()).content, null);
  await page.screenshot({ path: path.join(artifact, 'native-projection-failure-mobile.png') });
  await electron.evaluate(() => globalThis.astraNativeProof.projectionFailure(false));
  await page.getByRole('button', { name: 'Обновить состояние' }).click();
  await page.getByText(/Runtime требует внимания/).waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(await page.getByRole('button', { name: 'Разрешить один раз' }).isEnabled(), true);
  assert.equal((await proof()).kernelCalls, 0);
  await page.screenshot({ path: path.join(artifact, 'native-approval-mobile.png') });
  assert.equal(await page.locator('.astra-content').textContent(), content);
  await page.getByRole('button', { name: 'Разрешить один раз' }).click();
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 20000 });
  proofs.push(await waitHistory(5)); assert.equal(proofs.at(-1).content, content); assert.equal(proofs.at(-1).kernelCalls, 1);
  assert.equal(proofs.at(-1).history.messages.at(-1).turn_id, createTurn);
  assert.equal(proofs.at(-1).history.messages.at(-1).provenance.verification, 'system-state');
  if (multi) {
    const visible = await refreshHistory(4); await visible.getByRole('button', { name: 'Предыдущие сообщения' }).click();
    for (let i = 0; i < 60 && await visible.locator('article').count() !== 1; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await visible.locator('article').count(), 1);
    assert.equal(await visible.locator('article pre').textContent(), sourceText);
    await selectConversation(secondConversation); assert.equal((await proof()).surface.state, 'linked');
    await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor(); await refreshHistory(2);
    assert.equal((await proof()).kernelCalls, 1); assert.equal((await proof()).sources.conversations.length, 2);
    await page.screenshot({ path: path.join(artifact, 'native-second-conversation-mobile.png') });
    await close(); await launch();
    assert.equal((await proof()).sources.activeConversationId, secondConversation);
    await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor(); await refreshHistory(2);
    assert.equal((await proof()).kernelCalls, 0); await page.setViewportSize({ width: 390, height: 844 });
    proofs.push(await proof());
    await selectConversation('conversation');
    await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor();
    proofs[proofs.length - 1] = await proof();
    await page.getByLabel('Разговор Astra').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifact, 'native-conversations-first-viewport-mobile.png') });
  }
  await assert.rejects(readFile(path.join(root, 'deliveries.json')), { code: 'ENOENT' });
  assert.equal(proofs.at(-1).surface.turnId, createTurn);
  const foreign = await electron.evaluate(async ({ BrowserWindow }, preload) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await window.loadURL(globalThis.astraNativeProof.origin);
      return await window.webContents.executeJavaScript("window.monarchDesktop.getMutationAttestation().then(() => false, () => true)"); }
    finally { window.destroy(); }
  }, path.resolve('desktop/electron/astra-isolated-preload.cjs'));
  assert.equal(foreign, true); assert.deepEqual(errors, []);
  assert.ok(consoleMessages.every(message => /\b404\b/.test(message)), JSON.stringify(consoleMessages));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(artifact, 'native-complete-mobile.png') });
  for (const item of proofs) { assert.equal(item.modelCalls, 0); assert.equal(item.legacyCalls, 0); assert.equal(item.answerCalls, 0); assert.deepEqual(item.unexpectedApiRequests, []); }
  for (const item of proofs) { assert.equal(item.conversationMemory.productMainImported, false);
    const admittedIds = multi ? ['conversation', secondConversation] : ['conversation'];
    assert.ok(item.conversationMemory.requests.every(route => admittedIds.some(id => route === 'GET /api/conversations/' + id || route === 'POST /api/conversations/' + id + '/messages'))); }
  console.log(JSON.stringify({ result: 'PASS', proofKind: 'real-Electron-IPC-HTTP-Kernel-controlled-dialog', roots: [root],
    readTurn, createTurn, kernelCallsAcrossHosts: proofs.reduce((sum, item) => sum + item.kernelCalls, 0), exactBytes: Buffer.byteLength(content),
    nativeModal: 'NOT_TESTED', uiSurface: composerMode ? 'existing-Oscar-composer-and-thread' : 'isolated-pane',
    exactSourcePreserved: true, conversations: multi ? 2 : 1, staleSourceAndLatePickerDenied: multi,
    lostConversationRepliesRecovered: multi ? 2 : 0, fullRestarts: multi ? 3 : 2,
    historyStore: 'real-Python-MemoryStore-SQLite', historyMessages: proofs.at(-1).history.messages.length,
    errors, consoleMessages, artifact, retainedState: proofs.at(-1).surface }));
  passed = true;
  }
} catch (error) {
  console.error('NATIVE_CHECK_FAILED', String(error), 'CONSOLE', consoleMessages, 'PAGE_ERRORS', errors, 'REQUEST_FAILURES', requestFailures);
  if (page && !page.isClosed()) {
    console.error('NATIVE_CHECK_VISIBLE', (await page.locator('main').innerText()).slice(-4000));
    await page.screenshot({ path: path.join(artifact, 'native-failure.png'), timeout: 5000 }).catch(() => {});
  }
  if (electron) console.error('NATIVE_CHECK_STATE', await proof().catch(() => null));
  throw error;
} finally {
  try { await close(); } finally { try { await referenceModel?.close(); } finally { await stopRealComputer(); } }
  assert.equal(await realpath(root), root); assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('astra-v3-oscar-native-'));
  assert.equal(await readFile(path.join(root, '.fixture-marker'), 'utf8'), marker);
  if (passed) { await rm(root, { recursive: true, force: false });
    if (targetRoot) await rm(targetRoot, { recursive: true, force: false }); console.log('OWNED_NATIVE_CLEANUP_COMPLETE'); }
  else console.log('FAILED_NATIVE_ROOT_RETAINED', root);
}
