import { _electron } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

function check(value, code) { if (!value) throw Error('astra-product-renderer:' + code); }
/** Choose a value the way a person does. Shared selects are enhanced into a
 * trigger + listbox placed right after the native control (ui-select.js); the
 * native select stays the value authority but is no longer visible. */
async function chooseSelect(page, select, value) {
  const triggerId = await select.evaluate(element => element.nextElementSibling?.classList.contains('max-model-trigger')
    ? element.nextElementSibling.id : null);
  if (!triggerId) { await select.selectOption(value); return; }
  const text = await select.evaluate((element, wanted) => [...element.options].find(option => option.value === wanted)?.text ?? null, value);
  check(text, 'enhanced-select-option:' + value);
  const trigger = page.locator('#' + triggerId);
  await trigger.click();
  const listbox = page.locator('#' + await trigger.getAttribute('aria-controls'));
  await listbox.locator('[role="option"]').filter({ hasText: text }).first().click();
  check(await select.inputValue() === value, 'enhanced-select-value:' + value);
}
/** The native select behind an accessible label; the enhanced trigger and
 * listbox share that label, so `getByLabel` alone is ambiguous. */
const nativeSelect = (page, label) => page.locator('select[aria-label="' + label + '"]');
const parent = await realpath('.test-tmp');
const defaultOff = process.argv.includes('--default-off');
const workspaceMode = process.argv.includes('--workspace');
const maxQwenModelTask = process.argv.includes('--max-qwen-model-task');
const maxSafetyBlockedTask = process.argv.includes('--max-safety-blocked-task');
const maxOutputSafetyBlockedTask = process.argv.includes('--max-output-safety-blocked-task');
const maxProviderFailedTask = process.argv.includes('--max-provider-failed-task');
const maxAnalysisRuntimeRestartTask = process.argv.includes('--max-analysis-runtime-restart-task');
const maxMultiAnalysisMissingTask = process.argv.includes('--max-multi-analysis-missing-task');
const maxMultiAnalysisTask = process.argv.includes('--max-multi-analysis-task') || maxMultiAnalysisMissingTask;
const maxRuntimeRestartTask = process.argv.includes('--max-runtime-restart-task') || maxAnalysisRuntimeRestartTask;
const maxUnselectedModelTask = process.argv.includes('--max-unselected-model-task');
const maxAnalysisProviderFailedTask = process.argv.includes('--max-analysis-provider-failed-task');
const maxAnalysisSafetyBlockedTask = process.argv.includes('--max-analysis-safety-blocked-task');
const maxAnalysisTask = process.argv.includes('--max-analysis-task') || maxAnalysisProviderFailedTask
  || maxAnalysisSafetyBlockedTask || maxAnalysisRuntimeRestartTask || maxMultiAnalysisTask;
const maxModelTask = process.argv.includes('--max-model-task') || maxQwenModelTask
  || maxSafetyBlockedTask || maxOutputSafetyBlockedTask || maxProviderFailedTask || maxRuntimeRestartTask || maxAnalysisTask;
const maxConfiguredTask = maxModelTask || maxUnselectedModelTask;
const maxPreview = process.argv.includes('--max-preview') || maxConfiguredTask;
const computerActionMode = process.argv.includes('--computer-deny') ? 'deny'
  : process.argv.includes('--computer-close') ? 'close'
  : process.argv.includes('--computer-scroll') ? 'scroll'
  : process.argv.includes('--computer-key') ? 'key'
  : process.argv.includes('--computer-click') ? 'click'
  : process.argv.includes('--computer-action') ? 'replace' : '';
const computerAction = Boolean(computerActionMode);
const cooperativeCursor = process.argv.includes('--cooperative-cursor');
const cooperativeYield = process.argv.includes('--cooperative-yield');
const computerObserve = process.argv.includes('--computer-observe') || computerAction;
check(!(defaultOff && computerObserve), 'computer-observe-default-off');
check(!(defaultOff && maxPreview), 'max-preview-default-off');
check(!maxConfiguredTask || maxPreview, 'max-model-without-preview');
check(!cooperativeCursor || computerAction, 'cooperative-cursor-without-action');
check(!cooperativeCursor || process.env.MONARCH_ALLOW_SYSTEM_CURSOR_TEST === '1', 'cooperative-cursor-explicit-opt-in');
check(!cooperativeYield || computerActionMode === 'scroll', 'cooperative-yield-requires-scroll');
check(!(cooperativeCursor && cooperativeYield), 'cooperative-modes-exclusive');
const packagedPayloadInput = process.env.MONARCH_ASTRA_RENDERER_PAYLOAD_ROOT || '';
const expectedSourceRevision = process.env.MONARCH_ASTRA_RENDERER_SOURCE_REVISION || '';
let appRoot = process.cwd();
let electronExecutable = path.resolve('node_modules/electron/dist/electron.exe');
let nodeExecutable = process.execPath;
let route = 'source-Electron-main-preload-product-renderer';
if (packagedPayloadInput) {
  check(path.isAbsolute(packagedPayloadInput), 'payload-root-absolute');
  const payloadRoot = await realpath(packagedPayloadInput);
  appRoot = await realpath(path.join(payloadRoot, 'app'));
  electronExecutable = await realpath(path.join(payloadRoot, 'runtime', 'electron', 'electron.exe'));
  nodeExecutable = await realpath(path.join(payloadRoot, 'runtime', 'node', 'node.exe'));
  const seal = JSON.parse(await readFile(path.join(appRoot, '.monarch-public-snapshot'), 'utf8'));
  check(expectedSourceRevision.length === 40 && seal.sourceRevision === expectedSourceRevision,
    'payload-source-revision');
  route = 'exact-offline-payload-Electron-main-preload-product-renderer';
}
const root = await mkdtemp(path.join(parent, 'astra-v3-product-renderer-'));
check(path.dirname(await realpath(root)) === parent, 'root-parent');
await writeFile(path.join(root, '.fixture-marker'), 'astra-product-renderer-v1', { flag: 'wx' });
const roots = Object.fromEntries(['install', 'config', 'data', 'generated', 'logs', 'secrets', 'state', 'models', 'workspace', 'user-data',
  'coder-workspace', 'coder-sandbox', 'appdata', 'localappdata', 'temp'].map(name => [name, path.join(root, name)]));
await Promise.all(Object.values(roots).map(directory => mkdir(directory, { recursive: true })));
await writeFile(path.join(roots.workspace, 'owned.txt'), 'ASTRA_RENDERER_OWNED', { flag: 'wx' });
await writeFile(path.join(roots.workspace, 'owned-second.txt'), 'ASTRA_RENDERER_SECOND', { flag: 'wx' });
const pageErrors = [], consoleErrors = [];
const failedResponses = [], requests = [];
const oscarMessages = new Map(), oscarRequests = [];
let runtimeRestartGateEntered = false;
let runtimeRestartGateRelease = null;
const oscarServer = createServer((request, response) => { void (async () => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  response.setHeader('content-type', 'application/json');
  if (workspaceMode && request.method === 'GET' && /^\/api\/conversations(?:\/[^/]+)?$/u.test(url.pathname)) {
    check(typeof request.headers['x-oscar-token'] === 'string' && request.headers['x-oscar-token'].length >= 32, 'history-auth');
    const conversationId = decodeURIComponent(url.pathname.split('/')[3] || '');
    const messages = [...oscarMessages.values()].map(message => ({ ...message, id: message.client_message_id,
      created_at: new Date().toISOString() }));
    response.end(JSON.stringify(conversationId ? { id: conversationId, title: 'Native QA', messages } : [])); return;
  }
  if (workspaceMode && request.method === 'GET' && url.pathname === '/internal/astra/v3/model-descriptor') {
    check(typeof request.headers['x-oscar-token'] === 'string' && request.headers['x-oscar-token'].length >= 32, 'descriptor-auth');
    response.end(JSON.stringify({ schemaVersion: 1, hostGeneration: 'owned_workspace_model_host',
      modelDigest: 'sha256:90293b8cdaf9c973012bf4df8a1e92bde7d74ad66a4fe56cf905ccd563d660c5',
      memoryGuard: 'chat-validity-v1', configurationOnly: true, authority: 'none' })); return;
  }
  if (request.method === 'GET' && url.pathname === '/__astra/runtime-restart-gate') {
    check(maxRuntimeRestartTask && !runtimeRestartGateEntered, 'runtime-restart-gate-request');
    runtimeRestartGateEntered = true;
    await new Promise(resolve => { runtimeRestartGateRelease = resolve; });
    response.end(JSON.stringify({ ok: true })); return;
  }
  oscarRequests.push(url.pathname);
  if (request.method !== 'POST' || !/^\/api\/conversations\/[^/]+\/messages$/u.test(url.pathname)
    || typeof request.headers['x-oscar-token'] !== 'string' || request.headers['x-oscar-token'].length < 32) {
    response.writeHead(404); response.end(JSON.stringify({ ok: false, error: 'fixture-route-unavailable' })); return;
  }
  let text = ''; for await (const chunk of request) { text += String(chunk); if (text.length > 131_072) throw Error('oscar-fixture-body-budget'); }
  const body = JSON.parse(text), id = body.client_message_id;
  check(typeof id === 'string' && id.length > 0 && typeof body.content === 'string' && ['user', 'assistant'].includes(body.role),
    'oscar-fixture-message');
  if (body.causal_parent_id) check(oscarMessages.has(body.causal_parent_id), 'oscar-fixture-causal-parent');
  const duplicate = oscarMessages.has(id);
  if (!duplicate) oscarMessages.set(id, structuredClone(body));
  const conversationId = decodeURIComponent(url.pathname.split('/')[3]);
  const message = duplicate ? null : { conversation_id: conversationId, role: body.role, content: body.content,
    client_message_id: id, turn_id: body.turn_id, ...(body.causal_parent_id ? { causal_parent_id: body.causal_parent_id } : {}),
    ...(body.task_id ? { task_id: body.task_id } : {}), ...(body.outcome ? { outcome: body.outcome } : {}),
    ...(body.provenance ? { provenance: body.provenance } : {}) };
  response.end(JSON.stringify({ ok: true, disposition: duplicate ? 'duplicate' : 'created', duplicate,
    message, ...(body.content_mode === 'exact' ? { content_mode: 'exact',
      content_sha256: createHash('sha256').update(body.content, 'utf8').digest('hex') } : {}),
    ...(body.causal_parent_id ? { causal_parent_id: body.causal_parent_id } : {}) }));
})().catch(error => { response.writeHead(500); response.end(JSON.stringify({ ok: false, error: String(error) })); }); });
await new Promise((resolve, reject) => { oscarServer.once('error', reject); oscarServer.listen(0, '127.0.0.1', resolve); });
const oscarAddress = oscarServer.address(); check(oscarAddress && typeof oscarAddress !== 'string', 'oscar-fixture-address');
const oscarApiBase = 'http://127.0.0.1:' + oscarAddress.port;
let electron, ownedChild, ownedWindow, cursorMover;
const electronPidRegistry = path.resolve('.test-tmp', 'renderer-fixture-pids');
try {
  if (computerObserve) {
    const targetEnv = { ...process.env, TEMP: roots.temp, TMP: roots.temp };
    delete targetEnv.ELECTRON_RUN_AS_NODE;
    ownedChild = spawn(electronExecutable, [path.resolve('tests/fixtures/agent-v3/computer-observe-window.mjs'), root,
      ...(['replace', 'deny'].includes(computerActionMode) ? ['owned-replace-qa']
        : computerActionMode === 'click' ? ['owned-click-qa']
          : computerActionMode === 'key' ? ['owned-key-qa']
            : computerActionMode === 'scroll' ? ['owned-scroll-qa'] : [])],
      { cwd: process.cwd(), env: targetEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', errors = '';
    ownedWindow = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('astra-product-renderer:owned-window-timeout:' + errors)), 20_000);
      ownedChild.stdout.on('data', chunk => { pending += String(chunk); check(pending.length <= 65_536, 'owned-window-output-budget');
        for (;;) { const end = pending.indexOf('\n'); if (end < 0) break; const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.startsWith('ASTRA_WINDOW_EVENT ')) continue;
          const event = JSON.parse(line.slice('ASTRA_WINDOW_EVENT '.length));
          if (event.kind === 'ready') { clearTimeout(timer); resolve(event); }
        } });
      ownedChild.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-4096); });
      ownedChild.once('error', reject); ownedChild.once('exit', code => reject(Error('astra-product-renderer:owned-window-exit:' + code + ':' + errors)));
    });
    check(ownedWindow.processId === ownedChild.pid && ownedWindow.marker === 'ASTRA_OWNED_WINDOW_VALUE_42', 'owned-window-binding');
  }
  const launchStarted = performance.now();
  electron = await _electron.launch({ executablePath: electronExecutable,
    args: [path.join(appRoot, 'desktop', 'electron', 'main.mjs'), ...(workspaceMode ? [] : !defaultOff ? ['--astra-v3-same-owner-pilot'] : ['--disable-astra-v3']),
      ...(maxPreview ? ['--astra-max-preview'] : []),
      `--user-data-dir=${roots['user-data']}`],
    cwd: appRoot, timeout: 45_000, env: { ...process.env, APPDATA: roots.appdata, LOCALAPPDATA: roots.localappdata,
      TEMP: roots.temp, TMP: roots.temp, MONARCH_DATA_ROOT: roots.data,
      MONARCH_NODE_PATH: nodeExecutable, MONARCH_PAYLOAD_ROOT: path.join(root, 'payload'),
      MONARCH_GENERATED_ROOT: roots.generated,
      OSCAR_API_BASE: oscarApiBase, OSCAR_AUTO_START: '0',
      MONARCH_LOGS_ROOT: roots.logs, MONARCH_SECRETS_ROOT: roots.secrets, MONARCH_STATE_ROOT: roots.state,
      MONARCH_CONFIG_ROOT: roots.config, MONARCH_MODELS_ROOT: roots.models, MONARCH_WORKSPACE_ROOT: roots.workspace,
      MONARCH_CODER_WORKSPACE_ROOT: roots['coder-workspace'], MONARCH_CODER_SANDBOX_ROOT: roots['coder-sandbox'] } });
  // The caller kills this process at its own timeout, and a killed process
  // runs no `finally`: Electron and its runtime then lived on (live: a whole
  // day, holding port 4317). The test's afterEach ends what is listed here.
  await mkdir(electronPidRegistry, { recursive: true });
  await writeFile(path.join(electronPidRegistry, process.pid + '.pid'), String(electron.process().pid));
  if (maxConfiguredTask) await electron.evaluate((_electron, fixture) => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.__astraMaxFixtureCalls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.href === 'https://api.groq.com/openai/v1/chat/completions') {
        if (init?.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string') {
          throw Error('astra-max-main-fixture:request');
        }
        const body = JSON.parse(init.body);
        if (body.tool_choice !== 'none' || body.tools !== undefined || typeof body.model !== 'string') {
          throw Error('astra-max-main-fixture:authority');
        }
        const primary = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(body.model);
        globalThis.__astraMaxFixtureCalls.push({ model: body.model, toolChoice: body.tool_choice,
          schema: body.response_format?.json_schema?.name || null,
          ...(fixture.multiAnalysis && primary ? { groundedBoth: JSON.stringify(body.messages || []).includes('ASTRA_RENDERER_OWNED')
            && JSON.stringify(body.messages || []).includes('ASTRA_RENDERER_SECOND') } : {}) });
        if (fixture.providerFailed) throw Error('astra-max-main-fixture:provider-unavailable');
        if (fixture.runtimeRestart && body.model === 'openai/gpt-oss-120b'
          && globalThis.__astraMaxRuntimeRestartEntered !== true) {
          globalThis.__astraMaxRuntimeRestartEntered = true;
          const gate = await originalFetch(fixture.runtimeRestartGate, { redirect: 'error' });
          if (!gate.ok) throw Error('astra-max-main-fixture:restart-gate');
        }
        const content = body.model === 'openai/gpt-oss-safeguard-20b'
          ? fixture.safetyBlocked && globalThis.__astraMaxFixtureCalls.length === 1
            ? { decision: 'block', reasonCode: 'fixture-blocked', summary: 'Blocked by isolated fixture.' }
            : fixture.outputSafetyBlocked && globalThis.__astraMaxFixtureCalls.length === 3
              ? { decision: 'block', reasonCode: 'fixture-blocked', summary: 'Blocked by isolated fixture.' }
            : { decision: 'allow', reasonCode: 'fixture-allowed', summary: 'Allowed by isolated fixture.' }
          : ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(body.model)
            ? fixture.analysis
              ? { kind: 'respond', text: 'MAX прочитал: ASTRA_RENDERER_OWNED.' }
              : { kind: 'create', requirementId: 'draft_file', capabilityHandle: 'create_file',
                targetHandle: 'selected_file', content: 'ASTRA_MAX_UI_MODEL_DRAFT' }
            : null;
        if (!content) throw Error('astra-max-main-fixture:model');
        const wireContent = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(body.model)
          ? { proposal: content } : content;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wireContent) }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('astra-max-main-fixture:external-network-forbidden');
      return originalFetch(input, init);
    };
  }, { safetyBlocked: maxSafetyBlockedTask || maxAnalysisSafetyBlockedTask, outputSafetyBlocked: maxOutputSafetyBlockedTask,
    providerFailed: maxProviderFailedTask || maxAnalysisProviderFailedTask,
    runtimeRestart: maxRuntimeRestartTask, analysis: maxAnalysisTask, multiAnalysis: maxMultiAnalysisTask,
    runtimeRestartGate: oscarApiBase + '/__astra/runtime-restart-gate' });
  const page = await electron.firstWindow({ timeout: 45_000 });
  if (computerAction) await electron.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window || window.isDestroyed()) throw Error('astra-product-renderer:main-window-missing');
    const bounds = window.getBounds(); window.setBounds({ ...bounds, x: 720, y: 0 });
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text() + ':' + message.location().url); });
  page.on('request', request => requests.push(request.url()));
  page.on('response', response => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });
  if (workspaceMode) {
    await page.waitForSelector('[data-oscar-astra-select="observe"]', { state: 'attached', timeout: 30000 }).catch(async error => {
      console.log(JSON.stringify({ stage: 'workspace-bootstrap', pageErrors, consoleErrors,
        body: (await page.locator('body').innerText()).slice(0, 4000) })); throw error;
    });
  }
  await page.waitForSelector(workspaceMode || defaultOff ? '#oscar-composer' : '#oscar-section.astra-oscar-host', { timeout: 30_000 }).catch(async error => {
    console.log(JSON.stringify({ stage: 'visible-surface', pageErrors, consoleErrors,
      body: (await page.locator('body').innerText()).slice(0, 4000) }));
    await page.screenshot({ path: path.join(root, 'surface-failure.png') }); throw error;
  });
  if (!defaultOff && !workspaceMode) await page.waitForSelector('#oscar-composer .astra-desktop-picker', { timeout: 30_000 });
  const composerMountedMs = Math.round(performance.now() - launchStarted);
  await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('startup-complete'), null, { timeout: 15_000 });
  const startupTiming = { launchToComposerMs: composerMountedMs,
    launchToShellMs: Math.round(performance.now() - launchStarted),
    desktop: await electron.evaluate(() => performance.getEntriesByType('mark')
      .filter(entry => entry.name.startsWith('monarch:startup:'))
      .map(entry => ({ phase: entry.name.slice('monarch:startup:'.length), elapsedMs: entry.detail.processElapsedMs }))),
    renderer: await page.evaluate(() => ({ navigationMs: Math.round(performance.now()),
      startupType: document.documentElement.dataset.startupType })) };
  let uiRead = null;
  let workspaceIntegration = null;
  if (workspaceMode) {
    await page.locator('#oscar-input').fill('Сохранённый черновик обычного чата');
    await page.locator('#oscar-composer-menu > summary').click();
    await electron.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, path.join(roots.workspace, 'owned.txt'));
    await electron.evaluate(({ dialog }) => {
      const original = dialog.showOpenDialog; globalThis.__astraPickCalls = 0;
      dialog.showOpenDialog = async (...args) => { globalThis.__astraPickCalls++; return original(...args); };
    });
    await page.locator('[data-oscar-astra-select="observe"]').click();
    await page.locator('#oscar-astra-attachment:not(.hidden)').waitFor({ timeout: 15_000 }).catch(async error => {
      const trace = { pickCalls: await electron.evaluate(() => globalThis.__astraPickCalls),
        notices: await page.evaluate(() => [...document.querySelectorAll('.astra-error, [role="status"], [role="alert"], .toast, .oscar-composer-feedback')]
          .map(node => node.textContent?.trim()).filter(Boolean).slice(0, 8)) };
      throw Error('astra-product-renderer:attachment-not-selected:' + JSON.stringify(trace), { cause: error });
    });
    check(await page.locator('#oscar-input').inputValue() === 'Сохранённый черновик обычного чата', 'native-picker-draft-preserved');
    // The native select is enhanced into a trigger + listbox; choose the mode
    // the way a person does. Without local analysis there is no choice at all.
    const attachmentMode = page.locator('#oscar-astra-attachment select');
    if ((await attachmentMode.evaluate(select => [...select.options].map(option => option.value))).includes('analyze')) {
      const trigger = page.locator('#oscar-astra-attachment .max-model-trigger');
      await trigger.click();
      const listbox = page.locator('#' + await trigger.getAttribute('aria-controls'));
      await listbox.locator('[role="option"]', { hasText: 'Прочитать точно' }).click();
    }
    check(await attachmentMode.inputValue() === 'observe', 'attachment-mode-observe');
    await page.locator('#oscar-input').fill('Прочитай выбранный файл.');
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/oscar/turns' && response.request().method() === 'POST');
    await page.locator('#oscar-input').press('Enter');
    const checkpoint = await (await accepted).json(), turnId = checkpoint.turn.id;
    await page.waitForFunction(() => document.querySelector('#oscar-thread')?.textContent?.includes('ASTRA_RENDERER_OWNED'), null, { timeout: 30000 });
    const screenshot = path.join(root, 'astra-native-chat-desktop.png');
    await page.screenshot({ path: screenshot });
    check(await page.locator('#oscar-input').isVisible(), 'legacy-composer-visible');
    check(await page.locator('#astra-workspace, .astra-workspace-entry, #oscar-thread .astra-turn-panel').count() === 0, 'no-separate-astra-interface');
    check(checkpoint.turn.conversationId !== 'astra_product_pilot', 'native-conversation-owner');
    workspaceIntegration = { certifiedRead: true, legacyComposerPreserved: true, draftPreserved: true,
      nativeChat: true, noSeparatePanel: true, localAnalysisChoice: true, turnId, screenshot };
    uiRead = { result: await page.locator('#oscar-thread').innerText(), turnId };
  }
  if (!defaultOff && !workspaceMode) {
    const selectedPaths = [path.join(roots.workspace, 'owned.txt'), path.join(roots.workspace, 'owned-second.txt')];
    await electron.evaluate(({ dialog }, value) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: value.multi ? value.paths : [value.paths[0]] });
    }, { paths: selectedPaths, multi: maxMultiAnalysisTask });
    await page.getByRole('button', { name: 'Выбрать файл для чтения', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#oscar-composer select option[value^="selection_"]'));
    if (maxMultiAnalysisTask) check((await page.getByLabel('Выбранная цель').locator('option:checked').textContent())?.includes('2 файла'),
      'multi-analysis-selection-label');
    await page.locator('#oscar-input').fill('Прочитай только выбранный fixture-файл и верни точное содержимое.');
    await page.locator('#oscar-input').press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('#oscar-thread .astra-result')]
      .some(element => element.textContent?.includes('ASTRA_RENDERER_OWNED')), null, { timeout: 30_000 });
    uiRead = await page.evaluate(() => ({ result: [...document.querySelectorAll('#oscar-thread .astra-result')]
      .map(element => element.textContent || '').join('\n'), turnId: new URL(location.href).searchParams.get('astraTurnId') }));
    check(uiRead.result.includes('ASTRA_RENDERER_OWNED') && /^oscar_turn_[a-f0-9]{32}$/u.test(uiRead.turnId || ''), 'ui-read');
  }
  let uiComputerObserve = null;
  if (computerObserve) {
    await electron.evaluate(({ dialog }, title) => {
      globalThis.__astraProductDialogTrace = [];
      dialog.showMessageBox = async (_window, options) => {
        const detail = String(options.detail || '');
        globalThis.__astraProductDialogTrace.push(detail.slice(0, 700));
        if (detail.includes(title)) return { response: 0, checkboxChecked: false };
        const next = options.buttons.indexOf('Следующее');
        return { response: next >= 0 ? next : options.cancelId, checkboxChecked: false };
      };
    }, ownedWindow.title);
    await page.getByRole('button', { name: 'Выбрать окно для наблюдения', exact: true }).click();
    try {
      await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Наблюдать окно' }).waitFor({ state: 'attached' });
    } catch (error) {
      const diagnostic = await Promise.all([page.locator('.astra-error').allTextContents(),
        electron.evaluate(() => globalThis.__astraProductDialogTrace || [])]);
      throw Error('astra-product-renderer:window-selection:' + JSON.stringify(diagnostic), { cause: error });
    }
    await page.locator('#oscar-input').fill('Наблюдай только выбранное fixture-окно и верни сохранённый снимок.');
    await page.locator('#oscar-input').press('Enter');
    const details = page.getByRole('button', { name: 'Показать сохранённое наблюдение', exact: true });
    await details.waitFor({ timeout: 30_000 }); await details.click();
    const observed = page.locator('pre').filter({ hasText: 'ASTRA_OWNED_WINDOW_VALUE_42' });
    await observed.waitFor({ timeout: 15_000 });
    uiComputerObserve = { markerRendered: true, turnId: new URL(page.url()).searchParams.get('astraTurnId'),
      targetProcessId: ownedWindow.processId };
    check(/^oscar_turn_[a-f0-9]{32}$/u.test(uiComputerObserve.turnId || ''), 'ui-computer-turn');
    if (computerAction) {
      await page.getByRole('button', { name: 'Подготовить действие из снимка', exact: true }).click();
      await page.getByRole('region', { name: 'Подготовка точного действия', exact: true }).waitFor();
      await chooseSelect(page, nativeSelect(page, 'Тип действия'), ['replace', 'deny'].includes(computerActionMode) ? 'type' : computerActionMode);
      if (!['key', 'close'].includes(computerActionMode)) {
        const element = nativeSelect(page, 'Элемент окна');
        const targetLabel = computerActionMode === 'click' ? 'Button · Owned click test button'
          : computerActionMode === 'scroll' ? 'Button · Owned scroll test target' : 'Edit · Owned replacement test value';
        const elementId = await element.locator('option').filter({ hasText: targetLabel }).getAttribute('value');
        check(elementId, 'ui-computer-action-element'); await chooseSelect(page, element, elementId);
      }
      const exactText = '  ASTRA_RENDERER_NATIVE_ACTION_🟠  ';
      if (['replace', 'deny'].includes(computerActionMode)) {
        await page.getByLabel('Точный текст действия', { exact: true }).fill(exactText);
        await chooseSelect(page, nativeSelect(page, 'Режим текста'), 'replace');
      } else {
        if (computerActionMode === 'click') {
          await chooseSelect(page, nativeSelect(page, 'Кнопка мыши'), 'left');
          await chooseSelect(page, nativeSelect(page, 'Число кликов'), '1');
        } else if (computerActionMode === 'scroll') await page.getByLabel('Величина прокрутки', { exact: true }).fill('-360');
        else if (computerActionMode === 'key') await chooseSelect(page, nativeSelect(page, 'Клавиша'), 'f2');
      }
      await page.getByRole('button', { name: 'Сохранить план без разрешения на ввод', exact: true }).click();
      try {
        await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Действие с подтверждением' })
          .waitFor({ state: 'attached' });
      } catch (error) {
        throw Error('astra-product-renderer:action-plan:'
          + JSON.stringify(await page.locator('.astra-error').allTextContents()), { cause: error });
      }
      await page.locator('#oscar-input').fill('Выполни ровно подготовленное действие после отдельного подтверждения.');
      await page.locator('#oscar-input').press('Enter');
      await page.getByRole('heading', { name: 'Разрешить точное действие с окном?', exact: true }).waitFor({ timeout: 30_000 });
      if (cooperativeCursor) {
        cursorMover = await launchCursorMover(root, 100, 4_000);
        await new Promise(resolve => setTimeout(resolve, 250));
        check(cursorMover.exitCode === null, 'cooperative-cursor-not-active-at-consent');
      }
      const takeoverSignal = cooperativeYield ? requestTakeoverOnVisualLease(roots.state) : null;
      await page.getByRole('button', { name: computerActionMode === 'deny' ? 'Отклонить' : 'Разрешить один раз', exact: true }).click();
      if (takeoverSignal) await takeoverSignal;
      try {
        const terminal = page.getByRole('status').filter({ hasText: computerActionMode === 'deny'
          ? /Заблокировано/u : /Обработка завершена|Результат действия неизвестен/u });
        await terminal.waitFor({ timeout: 30_000 });
        check((await terminal.textContent())?.includes(computerActionMode === 'deny' ? 'Заблокировано'
          : cooperativeYield ? 'Результат действия неизвестен' : 'Обработка завершена'),
          computerActionMode === 'deny' ? 'ui-computer-action-denial' : 'ui-computer-action-indeterminate');
      } catch (error) {
        const native = computerActionMode === 'close' ? { exitCode: ownedChild.exitCode }
          : await fetch('http://127.0.0.1:' + ownedWindow.controlPort, { method: 'POST',
            headers: { authorization: 'Bearer ' + ownedWindow.controlToken, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: computerActionMode === 'click' ? 'read-owned-clicks'
              : computerActionMode === 'key' ? 'read-owned-keys'
                : computerActionMode === 'scroll' ? 'read-owned-wheels' : 'read-owned-value' }),
            signal: AbortSignal.timeout(2000) }).then(response => response.json());
        throw Error('astra-product-renderer:action-result:' + JSON.stringify({ native,
          errors: await page.locator('.astra-error').allTextContents(), statuses: await page.getByRole('status').allTextContents() }), { cause: error });
      }
      const readback = computerActionMode === 'close'
        ? await new Promise((resolve, reject) => {
          if (ownedChild.exitCode !== null) { resolve({ closed: true, exitCode: ownedChild.exitCode }); return; }
          const timer = setTimeout(() => { ownedChild.off('exit', onExit); reject(Error('owned-window-close-timeout')); }, 5000);
          const onExit = code => { clearTimeout(timer); resolve({ closed: true, exitCode: code }); };
          ownedChild.once('exit', onExit);
        })
        : await fetch('http://127.0.0.1:' + ownedWindow.controlPort, { method: 'POST',
          headers: { authorization: 'Bearer ' + ownedWindow.controlToken, 'content-type': 'application/json' },
          body: JSON.stringify({ kind: computerActionMode === 'click' ? 'read-owned-clicks'
            : computerActionMode === 'key' ? 'read-owned-keys'
              : computerActionMode === 'scroll' ? 'read-owned-wheels' : 'read-owned-value' }),
          signal: AbortSignal.timeout(2000) }).then(response => response.json());
      check(cooperativeYield ? Array.isArray(readback.wheels) && readback.wheels.length === 0
        : computerActionMode === 'click' ? readback.clicks === 1
        : computerActionMode === 'key' ? readback.keys?.length === 1 && readback.keys[0] === 'F2'
          : computerActionMode === 'scroll' ? readback.wheels?.length >= 1 && readback.wheels.length <= 4
            && readback.wheels.every(value => Number.isFinite(value) && value > 0)
            : computerActionMode === 'close' ? readback.closed === true && readback.exitCode === 0
          : computerActionMode === 'deny' ? readback.value === 'ASTRA_OWNED_WINDOW_VALUE_42'
            : readback.value === exactText, 'ui-computer-native-readback:' + JSON.stringify(readback));
      const controlAfterAction = JSON.parse(await readFile(path.join(roots.state, 'computer-use', 'control.json'), 'utf8'));
      if (cooperativeYield) check(controlAfterAction.enabled === true && controlAfterAction.activeLeaseId === null,
        'cooperative-yield-control-state');
      uiComputerObserve.action = { kind: computerActionMode, exactNativeReadback: true,
        syntheticPointerMotionActiveAtConsent: cooperativeCursor,
        cooperativeYieldVerified: cooperativeYield,
        computerUseRemainedEnabled: cooperativeYield ? controlAfterAction.enabled === true : null,
        turnId: new URL(page.url()).searchParams.get('astraTurnId') };
    }
  }
  let maxSetup = null;
  // Settings -> MAX owns connections (provider card -> key -> consent); the
  // composer entry only reports readiness and toggles MAX for new messages.
  const maxGroqView = () => page.evaluate(async () => {
    const view = await window.monarchDesktop.astraMax.providers();
    const groq = (view.providers || []).find(provider => provider.id === 'groq');
    return { state: groq?.state ?? null, connectionVerified: groq?.connectionVerified === true, selectedProviderId: view.selectedProviderId ?? null };
  });
  // The MAX entry lives in the model menu. With nothing connected one click
  // opens Settings -> MAX; with a ready service one click toggles MAX, asking
  // once about sharing memory (the fixture declines, so nothing leaves).
  const openModelMenu = async () => {
    await page.locator('.nav-item[data-scroll-target="oscar-section"]').click();
    // The diagnostic pilot docks the entry in its composer; the ordinary chat
    // keeps it inside the model menu.
    await page.locator('#oscar-section').waitFor({ state: 'visible', timeout: 10_000 });
    const entry = page.locator('[data-astra-max-open]');
    const docked = await entry.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false);
    if (!docked) await page.locator('#oscar-model-dropdown-btn').click();
    await page.locator('[data-astra-max-open]').waitFor({ state: 'visible', timeout: 10_000 });
  };
  const closeModelMenu = async () => {
    if (await page.locator('#oscar-model-popover:not(.hidden)').count() && await page.locator('#oscar-model-dropdown-btn').isVisible())
      await page.locator('#oscar-model-dropdown-btn').click();
  };
  const selectMaxFromMenu = async () => {
    await openModelMenu();
    await page.locator('[data-astra-max-open][data-state="ready"]').click();
    const memory = page.locator('#max-memory-consent-dialog[open]');
    await memory.waitFor({ timeout: 3_000 }).then(() => memory.locator('button[value="declined"]').click(), () => {});
    await page.waitForFunction(() => document.querySelector('[data-astra-max-open]')?.dataset.selected === 'true',
      null, { timeout: 10_000 });
    await closeModelMenu();
  };
  if (maxPreview) {
    await page.waitForFunction(() => document.querySelector('[data-astra-max-open]')?.dataset.state === 'not-configured',
      null, { timeout: 30_000 });
    await openModelMenu();
    await page.locator('[data-astra-max-open]').click();
    // Without a connection the MAX entry opens the in-chat connection dialog on its service picker.
    await page.locator('#max-connection-dialog[open] [data-max-pick-grid] [data-pick="groq"]').waitFor({ timeout: 10_000 });
    maxSetup = await page.evaluate(() => ({
      stateBefore: document.querySelector('[data-astra-max-open]')?.dataset.state || null,
      entryOpensConnect: Boolean(document.querySelector('#max-connection-dialog[open] [data-max-pick-grid] [data-pick]')),
      rendererMethods: Object.keys(window.monarchDesktop.astraMax || {}).sort(),
      keyValue: document.querySelector('#astra-max-key')?.value || '',
    }));
    check(maxSetup.stateBefore === 'not-configured' && maxSetup.entryOpensConnect
      && ['configureProvider', 'providers', 'selectProvider', 'status'].every(method => maxSetup.rendererMethods.includes(method))
      && !maxSetup.rendererMethods.some(method => /key|secret|token|credential/iu.test(method)) && maxSetup.keyValue === '',
      'max-setup-surface:' + JSON.stringify(maxSetup));
    if (maxConfiguredTask) {
      await page.locator('#max-connection-dialog[open] [data-pick="groq"]').click();
      await page.locator('#astra-max-key').waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('#astra-max-key').fill('gsk_isolated_ui_fixture_12345678901234567890');
      for (const id of ['astra-max-cloud-check', 'astra-max-context-check', 'astra-max-terms-check']) {
        const box = page.locator('#' + id);
        if (!await box.isChecked()) await page.locator('label:has(#' + id + ') .ds-check').click();
        check(await box.isChecked(), 'max-consent-check:' + id);
      }
      await page.locator('#astra-max-connect').click();
      await page.waitForFunction(() => document.querySelector('[data-astra-max-open]')?.dataset.state === 'ready',
        null, { timeout: 15_000 });
      await page.locator('#max-connection-dialog[open]').waitFor({ state: 'detached', timeout: 10_000 });
      if (!maxUnselectedModelTask) await selectMaxFromMenu();
      const groqAfterSave = await maxGroqView();
      Object.assign(maxSetup, {
        stateAfter: await page.locator('[data-astra-max-open]').getAttribute('data-state'),
        selectedForNewDrafts: await page.locator('[data-astra-max-open]').getAttribute('data-selected'),
        modelChoiceAfterSave: await page.locator('[data-astra-max-open]').getAttribute('data-model-choice'),
        connectionVerifiedAfterSave: String(groqAfterSave.connectionVerified),
        keyValueAfter: await page.locator('#astra-max-key').inputValue(),
      });
      check(maxSetup.stateAfter === 'ready' && maxSetup.selectedForNewDrafts === String(!maxUnselectedModelTask)
        && maxSetup.modelChoiceAfterSave === 'gpt-oss-120b' && groqAfterSave.state === 'ready'
        && maxSetup.connectionVerifiedAfterSave === 'false' && maxSetup.keyValueAfter === '',
        'max-setup-configured:' + JSON.stringify(maxSetup));
      await openModelMenu();
      await page.locator('[data-astra-max-open][data-state="ready"]').waitFor({ timeout: 10_000 });
      maxSetup.selectionReadyAfterRefresh = true;
      maxSetup.selectedAfterRefresh = await page.locator('[data-astra-max-open]').getAttribute('data-selected');
      maxSetup.connectionVerifiedAfterRefresh = String((await maxGroqView()).connectionVerified);
      check(maxSetup.selectedAfterRefresh === String(!maxUnselectedModelTask)
        && maxSetup.connectionVerifiedAfterRefresh === 'false', 'max-selection-refresh');
    }
    if (!maxConfiguredTask) {
      await page.locator('#max-editor-close').click();
      await page.locator('#max-connection-dialog[open]').waitFor({ state: 'detached', timeout: 10_000 });
    }
    await closeModelMenu();
    await page.locator('.nav-item[data-scroll-target="oscar-section"]').click();
  }
  let uiMaxModelCreate = null;
  let uiMaxAnalysis = null;
  let runtimeRestart = null;
  if (maxConfiguredTask && !maxAnalysisTask) {
    const selectedPath = path.join(roots.workspace, 'max-model-draft.txt');
    await electron.evaluate(({ dialog }, value) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: value });
    }, selectedPath);
    await page.getByRole('button', { name: 'Выбрать новый файл', exact: true }).click();
    try {
      await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Создать ' })
        .waitFor({ state: 'attached', timeout: 10_000 });
    } catch (error) {
      const diagnostic = await Promise.all([page.locator('.astra-error').allTextContents(),
        page.getByLabel('Выбранная цель').locator('option').allTextContents()]);
      throw Error('astra-product-renderer:max-model-target:' + JSON.stringify(diagnostic), { cause: error });
    }
    const sourceKind = page.locator('.astra-composer-options label').filter({ hasText: 'Как подготовить файл' }).locator('select');
    if (!await sourceKind.evaluate(element => !element.closest('label')?.hidden && !element.hidden)) {
      const diagnostic = await page.evaluate(() => [...document.querySelectorAll('.astra-composer-options label')]
        .map(element => ({ text: element.textContent, hidden: element.hidden,
          select: element.querySelector('select')?.value || null })));
      throw Error('astra-product-renderer:max-model-source-kind:' + JSON.stringify(diagnostic));
    }
    await chooseSelect(page, sourceKind, 'draft');
    await page.locator('#oscar-input').fill('Создай короткий тестовый черновик через MAX.');
    await page.locator('#oscar-input').press('Enter');
    if (maxRuntimeRestartTask) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !runtimeRestartGateEntered) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      check(runtimeRestartGateEntered, 'runtime-restart-provider-frontier');
      const desktopPid = electron.process().pid;
      const before = await waitForRuntimeChild(desktopPid);
      process.kill(before.processId);
      const after = await waitForRuntimeChild(desktopPid, before.processId);
      check(typeof runtimeRestartGateRelease === 'function', 'runtime-restart-gate-release');
      runtimeRestartGateRelease(); runtimeRestartGateRelease = null;
      runtimeRestart = { desktopPid, exitedRuntimePid: before.processId, recoveredRuntimePid: after.processId,
        exactSourceChild: before.exactSourceChild && after.exactSourceChild, providerPendingAtExit: true };
    }
    if (maxUnselectedModelTask) {
      const refused = page.locator('.astra-error').filter({ hasText: 'Выбери MAX в меню моделей и отправь задачу снова.' });
      await refused.waitFor({ timeout: 20_000 });
      const calls = await electron.evaluate(() => structuredClone(globalThis.__astraMaxFixtureCalls || []));
      const approvalCreated = await page.getByRole('heading', { name: 'Разрешить создание файла?', exact: true }).count() !== 0;
      const fileCreated = Boolean(await stat(selectedPath).catch(() => null));
      check(calls.length === 0 && !approvalCreated && !fileCreated, 'max-unselected-side-effect');
      check(!new URL(page.url()).searchParams.has('astraTurnId') && !new URL(page.url()).searchParams.has('astraPendingRequestId'),
        'max-unselected-turn-pointer');
      uiMaxModelCreate = { selectionRequired: true, taskCreated: false, providerCalls: calls,
        approvalCreated, fileCreated, message: await refused.textContent(), turnId: null };
    } else if (maxSafetyBlockedTask || maxOutputSafetyBlockedTask || maxProviderFailedTask) {
      const terminal = page.getByRole('status').filter({ hasText: 'Заблокировано' });
      await terminal.waitFor({ timeout: 20_000 });
      const approvalCreated = await page.getByRole('heading', { name: 'Разрешить создание файла?', exact: true }).count() !== 0;
      check(!approvalCreated,
        'max-safety-approval-created');
      const fileCreated = Boolean(await stat(selectedPath).catch(() => null));
      check(!fileCreated, 'max-safety-write');
      const calls = await electron.evaluate(() => structuredClone(globalThis.__astraMaxFixtureCalls || []));
      const expectedModels = maxSafetyBlockedTask || maxProviderFailedTask
        ? ['openai/gpt-oss-safeguard-20b']
        : ['openai/gpt-oss-safeguard-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b'];
      check(calls.map(item => item.model).join(',') === expectedModels.join(','), 'max-safety-call-order');
      const summary = await page.locator('#oscar-thread .astra-result').last().textContent();
      if (maxProviderFailedTask) check(summary === 'Модель не ответила. Проверь подключение и отправь задачу снова. Создание файла не произошло.',
        'max-provider-user-guidance');
      uiMaxModelCreate = { safetyBlocked: !maxProviderFailedTask,
        safetyStage: maxProviderFailedTask ? null : maxSafetyBlockedTask ? 'input' : 'output',
        providerFailed: maxProviderFailedTask, summary,
        approvalCreated, fileCreated,
        providerCalls: calls, modelId: null, content: null, terminal: await terminal.textContent(),
        turnId: new URL(page.url()).searchParams.get('astraTurnId') };
    } else {
    // Direct Access is the base mode of the Desktop surface: the Kernel admits
    // this exact create without an approval card. The write itself and its
    // content are still verified against the model draft.
    const approvalCreated = await page.getByRole('heading', { name: 'Разрешить создание файла?', exact: true }).count() > 0;
    try {
      await page.locator('#oscar-thread section.astra-turn-panel [role="status"]')
        .filter({ hasText: /Обработка завершена|Завершено не полностью/u })
        .waitFor({ timeout: maxRuntimeRestartTask ? 60_000 : 30_000 });
    } catch (error) {
      const diagnostic = await Promise.all([page.locator('.astra-error').allTextContents(),
        page.getByRole('status').allTextContents(), page.locator('#oscar-thread').innerText()]);
      throw Error('astra-product-renderer:max-model-terminal:' + JSON.stringify(diagnostic), { cause: error });
    }
    const approvalContent = await readFile(selectedPath, 'utf8');
    check(approvalContent === 'ASTRA_MAX_UI_MODEL_DRAFT' && !approvalCreated, 'max-model-write-readback');
    const userPresentation = await page.locator('#oscar-thread section.astra-turn-panel').innerText();
    check(userPresentation.includes('Время работы:'), 'max-model-elapsed-time');
    const calls = await electron.evaluate(() => structuredClone(globalThis.__astraMaxFixtureCalls || []));
    const primaryModel = maxQwenModelTask ? 'qwen/qwen3.8-27b' : 'openai/gpt-oss-120b';
    check(calls.map(item => item.model).join(',')
      === `openai/gpt-oss-safeguard-20b,${primaryModel},openai/gpt-oss-safeguard-20b`, 'max-model-call-order');
    uiMaxModelCreate = { exactApprovalRequired: false, directWrite: true, exactReadback: true, providerCalls: calls,
      userFacingElapsed: true, modelId: primaryModel, content: approvalContent,
      turnId: new URL(page.url()).searchParams.get('astraTurnId') };
    }
    maxSetup.connectionVerifiedAfterTask = String((await maxGroqView()).connectionVerified);
    const expectedVerified = !maxUnselectedModelTask && !maxSafetyBlockedTask && !maxOutputSafetyBlockedTask && !maxProviderFailedTask;
    check(maxSetup.connectionVerifiedAfterTask === String(expectedVerified), 'max-connection-truth-after-task');
  }
  if (maxAnalysisTask) {
    if (maxMultiAnalysisMissingTask) await unlink(path.join(roots.workspace, 'owned-second.txt'));
    await page.locator('#oscar-input').fill('Что записано в выбранном файле?');
    await page.locator('#oscar-input').press('Enter');
    if (maxAnalysisRuntimeRestartTask) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !runtimeRestartGateEntered) await new Promise(resolve => setTimeout(resolve, 25));
      check(runtimeRestartGateEntered, 'max-analysis-runtime-restart-provider-frontier');
      const desktopPid = electron.process().pid;
      const before = await waitForRuntimeChild(desktopPid);
      process.kill(before.processId);
      const after = await waitForRuntimeChild(desktopPid, before.processId);
      check(typeof runtimeRestartGateRelease === 'function', 'max-analysis-runtime-restart-gate-release');
      runtimeRestartGateRelease(); runtimeRestartGateRelease = null;
      runtimeRestart = { desktopPid, exitedRuntimePid: before.processId, recoveredRuntimePid: after.processId,
        exactSourceChild: before.exactSourceChild && after.exactSourceChild, providerPendingAtExit: true };
    }
    if (maxMultiAnalysisMissingTask) {
      const terminal = page.getByRole('status').filter({ hasText: 'Завершено не полностью' }).last();
      await terminal.waitFor({ timeout: 20_000 });
      const response = await page.locator('#oscar-thread .astra-result').last().textContent();
      const finalCalls = await electron.evaluate(() => structuredClone(globalThis.__astraMaxFixtureCalls || []));
      check(finalCalls.length === 0
        && response === 'Оскар не смог прочитать все выбранные файлы. Проверь, что они существуют и доступны, затем выбери их заново и отправь задачу снова.',
      'max-multi-analysis-missing');
      uiMaxAnalysis = { response, providerCalls: finalCalls, approvalCreated: false,
        missingRead: true, terminal: await terminal.textContent(),
        turnId: new URL(page.url()).searchParams.get('astraTurnId') };
    } else if (maxAnalysisProviderFailedTask || maxAnalysisSafetyBlockedTask) {
      const terminal = page.getByRole('status').filter({ hasText: 'Заблокировано' }).last();
      await terminal.waitFor({ timeout: 20_000 });
      const response = await page.locator('#oscar-thread .astra-result').last().textContent();
      const finalCalls = await electron.evaluate(() => structuredClone(globalThis.__astraMaxFixtureCalls || []));
      const expectedResponse = maxAnalysisSafetyBlockedTask
        ? 'Проверка безопасности остановила задачу. Измени запрос или выбранные файлы и попробуй снова.'
        : 'Модель не ответила. Проверь подключение MAX и отправь задачу снова.';
      check(finalCalls.map(item => item.model).join(',') === 'openai/gpt-oss-safeguard-20b'
        && response === expectedResponse,
      'max-analysis-provider-failure');
      uiMaxAnalysis = { response, providerCalls: finalCalls, approvalCreated: false,
        providerFailed: maxAnalysisProviderFailedTask, safetyBlocked: maxAnalysisSafetyBlockedTask,
        turnId: new URL(page.url()).searchParams.get('astraTurnId') };
    } else {
      const result = page.locator('#oscar-thread .astra-result').filter({ hasText: 'MAX прочитал: ASTRA_RENDERER_OWNED.' });
      await result.waitFor({ timeout: 20_000 });
      await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).last().waitFor({ timeout: 20_000 });
      const finalCalls = await electron.evaluate(() => structuredClone(globalThis.__astraMaxFixtureCalls || []));
      const primaryModel = maxQwenModelTask ? 'qwen/qwen3.8-27b' : 'openai/gpt-oss-120b';
      check(finalCalls.map(item => item.model).join(',')
        === `openai/gpt-oss-safeguard-20b,${primaryModel},openai/gpt-oss-safeguard-20b`, 'max-analysis-call-order');
      const approvalCreated = await page.getByRole('heading', { name: 'Разрешить создание файла?', exact: true }).count() !== 0;
      const userPresentation = await page.locator('#oscar-thread section.astra-turn-panel').last().innerText();
      check(!approvalCreated && userPresentation.includes('Время работы:'), 'max-analysis-presentation');
      const groundedBoth = finalCalls.find(item => item.model === primaryModel)?.groundedBoth;
      if (maxMultiAnalysisTask) check(groundedBoth === true, 'max-multi-analysis-grounding');
      uiMaxAnalysis = { response: await result.textContent(), providerCalls: finalCalls, approvalCreated,
        ...(maxMultiAnalysisTask ? { groundedBoth } : {}),
        userFacingElapsed: true, turnId: new URL(page.url()).searchParams.get('astraTurnId') };
    }
    maxSetup.connectionVerifiedAfterTask = String((await maxGroqView()).connectionVerified);
    const analysisVerified = !maxAnalysisProviderFailedTask && !maxAnalysisSafetyBlockedTask && !maxMultiAnalysisMissingTask;
    check(maxSetup.connectionVerifiedAfterTask === String(analysisVerified), 'max-analysis-connection-truth');
  }
  const evidence = await page.evaluate(async () => {
    const info = await window.monarchDesktop.getAppInfo();
    const attestation = await window.monarchDesktop.getMutationAttestation().catch(() => '');
    const exposed = Object.keys(window.monarchDesktop.astraPilot || {}).sort();
    const hiddenLegacy = [...document.querySelectorAll('#oscar-section button, #oscar-section select, #oscar-section details')]
      .filter(element => !['oscar-send', 'oscar-stop'].includes(element.id)
        && !element.closest('.astra-oscar-host .astra-desktop-picker') && !element.closest('.astra-oscar-host .astra-turn-panel'))
      .filter(element => !element.closest('.astra-max-pilot-dock'))
      .every(element => element.hidden || element.disabled || !element.checkVisibility());
    const visibleLegacy = [...document.querySelectorAll('#oscar-section button, #oscar-section select, #oscar-section details')]
      .filter(element => !['oscar-send', 'oscar-stop'].includes(element.id)
        && !element.closest('.astra-oscar-host .astra-desktop-picker') && !element.closest('.astra-oscar-host .astra-turn-panel'))
      .filter(element => !element.closest('.astra-max-pilot-dock'))
      .filter(element => !(element.hidden || element.disabled || !element.checkVisibility()))
      .map(element => element.id || element.className || element.tagName).slice(0, 8);
    const panelText = [...document.querySelectorAll('#oscar-thread .astra-turn-panel')]
      .map(element => element instanceof HTMLElement ? element.innerText : '').join('\n');
    const plainLanguagePanel = !/Astra V3|Runtime требует|sha256:|Отпечаток содержимого|Задача:\s*oscar_turn_/iu.test(panelText);
    return { pilot: info?.astra?.pilot === true, maxPreview: info?.astra?.maxPreview === true,
      deploymentSurface: document.querySelector('#oscar-section')?.classList.contains('astra-oscar-host'),
      composerMounted: Boolean(document.querySelector('#oscar-composer .astra-desktop-picker')),
      legacyComposerMounted: Boolean(document.querySelector('#oscar-composer #oscar-input')),
      conversationId: document.querySelector('#oscar-thread [data-conversation-id]')?.dataset.conversationId
        || document.querySelector('#oscar-thread > section')?.dataset.conversationId || null,
      exposed, hiddenLegacy, visibleLegacy, plainLanguagePanel, attestationAvailable: attestation.length >= 32,
      bodyText: document.querySelector('#oscar-section')?.textContent?.slice(0, 4000) || '',
      url: location.href };
  });
  check(workspaceMode ? evidence.pilot && !evidence.deploymentSurface && !evidence.composerMounted && evidence.legacyComposerMounted : defaultOff
    ? !evidence.pilot && !evidence.deploymentSurface && !evidence.composerMounted && evidence.legacyComposerMounted
    : evidence.pilot && evidence.deploymentSurface && evidence.composerMounted && evidence.hiddenLegacy,
  'surface:' + JSON.stringify({ pilot: evidence.pilot, deploymentSurface: evidence.deploymentSurface,
    composerMounted: evidence.composerMounted, legacyComposerMounted: evidence.legacyComposerMounted, hiddenLegacy: evidence.hiddenLegacy, visibleLegacy: evidence.visibleLegacy }));
  check(defaultOff || evidence.plainLanguagePanel, 'plain-language-panel');
  check(evidence.exposed.join(',') === ['computerActionPlans','issueComputerAction','pickTarget','pickTelegramTarget','pickWindow','windowSelections'].join(','),
    'preload-surface');
  check(!/host-token|astra-host|MONARCH_ASTRA|selectedPath|hwnd:/iu.test(JSON.stringify(evidence)), 'authority-leak');
  check(pageErrors.length === 0, 'renderer-page-errors:' + pageErrors.join('|'));
  // The isolated Oscar receipt fixture intentionally does not implement the
  // unrelated settings backend, so an authenticated background read is 404.
  check(failedResponses.every(item => maxUnselectedModelTask && item.status === 400 && new URL(item.url).pathname === '/api/oscar/turns'
    || [401, 403, 404].includes(item.status) && new URL(item.url).pathname === '/api/settings/read'),
    'unexpected-response:' + JSON.stringify(failedResponses));
  check(requests.every(value => { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1'; }),
    'external-request');
  const proof = { result: 'PASS', status: 'passed', root, route, startupTiming,
    exactDevSwitch: !defaultOff && !workspaceMode, defaultOffVerified: defaultOff, defaultPackagedActivation: false,
    isolatedRoots: Object.values(roots).every(value => value.startsWith(root)),
    modelTasksSubmitted: maxModelTask ? 1 : 0, modelTaskAttempts: maxConfiguredTask ? 1 : 0,
    externalNetworkRequests: 0, safeUiInvoked: false, localOscarReceipts: oscarMessages.size,
    unexpectedOscarRequests: oscarRequests.filter(value => !/^\/api\/conversations\/[^/]+\/messages$/u.test(value)),
    uiRead, workspaceIntegration, uiComputerObserve, uiMaxModelCreate, uiMaxAnalysis, maxSetup, ...evidence, pageErrors, consoleErrors,
    runtimeRestart,
    ancillarySettingsUnavailable: failedResponses, failedResponses };
  await writeFile(path.join(root, 'product-renderer-proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(proof));
} catch (error) {
  if (electron) {
    const page = electron.windows()[0];
    if (page) {
      console.log(JSON.stringify({ stage: 'interaction-failed', pageErrors, consoleErrors,
        panel: await page.locator(workspaceMode ? '#oscar-thread' : '#astra-workspace').textContent().catch(() => ''),
        root }));
      await page.screenshot({ path: path.join(root, 'interaction-failure.png') }).catch(() => undefined);
    }
  }
  throw error;
} finally {
  runtimeRestartGateRelease?.();
  if (cursorMover?.exitCode === null) cursorMover.kill();
  if (electron) await electron.close().catch(() => undefined);
  await unlink(path.join(electronPidRegistry, process.pid + '.pid')).catch(() => undefined);
  if (ownedChild?.exitCode === null) {
    if (ownedWindow) await fetch('http://127.0.0.1:' + ownedWindow.controlPort, { method: 'POST',
      headers: { authorization: 'Bearer ' + ownedWindow.controlToken, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'stop' }), signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    if (ownedChild.exitCode === null) ownedChild.kill();
  }
  await new Promise(resolve => oscarServer.close(resolve));
}

async function launchCursorMover(root, delayMs, durationMs) {
  const compiler = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = path.join(root, 'monarch-computer-use-cursor-mover.exe');
  const existing = await stat(executable).catch(() => null);
  if (!existing?.isFile()) {
    await runCompiler(compiler, ['/nologo', '/target:exe', '/reference:System.dll', `/out:${executable}`,
      path.resolve('tests/fixtures/MonarchComputerUseCursorMover.cs')]);
  }
  return spawn(executable, [String(delayMs), String(durationMs)], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function runCompiler(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve()
      : reject(Error(`astra-product-renderer:cursor-mover-compile:${code}:${output.slice(-4_000)}`)));
  });
}

async function requestTakeoverOnVisualLease(stateRoot) {
  const sessionRoot = path.join(stateRoot, 'computer-use', 'native', 'cursor-session');
  const leasePath = path.join(sessionRoot, 'active-visual-lease.json');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await stat(leasePath).catch(() => null))?.isFile()) {
      await writeFile(path.join(sessionRoot, 'user-takeover.requested'), `${new Date().toISOString()}\n`, { flag: 'wx' });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('astra-product-renderer:cooperative-yield-lease-timeout');
}

async function waitForRuntimeChild(parentPid, excludedPid = 0) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const children = descendantProcesses(parentPid);
    const matches = children.filter(item => item.processId !== excludedPid && item.exactSourceChild);
    if (matches.length === 1) return matches[0];
    check(matches.length <= 1, 'runtime-restart-child-ambiguous');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('astra-product-renderer:runtime-restart-child-timeout');
}

function descendantProcesses(parentPid) {
  check(Number.isSafeInteger(parentPid) && parentPid > 0, 'runtime-restart-parent');
  const command = '$items = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine; '
    + 'ConvertTo-Json -Compress -InputObject @($items)';
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const parsed = JSON.parse(output || '[]');
  const items = (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({ processId: Number(item.ProcessId),
    parentProcessId: Number(item.ParentProcessId), name: String(item.Name || ''), commandLine: String(item.CommandLine || '') }));
  const byId = new Map(items.map(item => [item.processId, item]));
  const descendant = item => {
    let next = item; const visited = new Set();
    while (next && !visited.has(next.processId)) {
      if (next.parentProcessId === parentPid) return true;
      visited.add(next.processId); next = byId.get(next.parentProcessId);
    }
    return false;
  };
  return items.filter(descendant).map(item => {
    const { processId, name, commandLine } = item;
    return { processId, exactSourceChild: Number.isSafeInteger(processId) && processId > 0 && /^node\.exe$/iu.test(name)
      && commandLine.toLowerCase().includes(path.resolve('src/main.ts').toLowerCase())
      && /(?:^|\s)serve(?:\s|$)/iu.test(commandLine) && /(?:^|\s)--port(?:\s|$)/iu.test(commandLine) };
  });
}
