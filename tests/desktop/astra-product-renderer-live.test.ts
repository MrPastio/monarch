import { execFileSync } from 'node:child_process';
import { readdir, readFile, realpath, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  // A fixture killed at its timeout leaves its Electron tree behind; it lists
  // the Electron pid while running and removes it only after a clean close.
  const registry = path.resolve('.test-tmp', 'renderer-fixture-pids');
  for (const name of await readdir(registry).catch(() => [] as string[])) {
    const pid = Number(await readFile(path.join(registry, name), 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
    }
    await rm(path.join(registry, name), { force: true });
  }
  const parent = await realpath('.test-tmp');
  for (const root of roots.splice(0)) {
    expect(path.dirname(await realpath(root))).toBe(parent);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-product-renderer-v1');
    await rm(root, { recursive: true, force: true });
  }
});

/** The Astra journal is encrypted at rest; its key lives only inside the
 * product processes. These tests used to count invocation.observed events in
 * plaintext rows; now they assert the rows exist and disclose no event text.
 * Exactly-once provider work is still asserted through providerCalls. */
function expectEncryptedJournal(root: string): void {
  const journal = new DatabaseSync(path.join(root, 'state', 'astra-v3', 'same-owner-pilot', 'journal.sqlite'), { readOnly: true });
  try {
    const rows = journal.prepare('SELECT events FROM astra_commits').all() as Array<{ events: Uint8Array }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Buffer.from(row.events).toString('utf8')).not.toContain('invocation.observed');
  } finally { journal.close(); }
}

describe('Astra source product renderer pilot', () => {
  it('uses the ordinary Oscar composer and conversation for native file tasks without another panel', () => {
    const output = execFileSync(process.execPath, ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--workspace'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
    });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', pilot: true, composerMounted: false,
      legacyComposerMounted: true, pageErrors: [], workspaceIntegration: {
        certifiedRead: true, legacyComposerPreserved: true, draftPreserved: true,
        nativeChat: true, noSeparatePanel: true, localAnalysisChoice: true,
      } });
    roots.push(proof.root);
  }, 100_000);
  it('mounts through the real Electron main/preload only under the exact dev switch', () => {
    const output = execFileSync(process.execPath, ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
    });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', route: 'source-Electron-main-preload-product-renderer',
      exactDevSwitch: true, defaultPackagedActivation: false, isolatedRoots: true, pilot: true,
      deploymentSurface: true, composerMounted: true, conversationId: 'astra_product_pilot', attestationAvailable: true,
      hiddenLegacy: true, plainLanguagePanel: true, modelTasksSubmitted: 0, externalNetworkRequests: 0,
      safeUiInvoked: false, pageErrors: [] });
    expect(proof.uiRead.result).toContain('ASTRA_RENDERER_OWNED');
    expect(proof.uiRead.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    expect(proof.startupTiming.launchToShellMs).toBeGreaterThanOrEqual(proof.startupTiming.launchToComposerMs);
    expect(proof.startupTiming.desktop.map((value: any) => value.phase)).toEqual(expect.arrayContaining([
      'app-ready', 'maintenance-ready', 'runtime-ready', 'window-create', 'window-ready-to-show', 'page-loaded',
    ]));
    roots.push(proof.root);
  }, 100_000);

  it('keeps the ordinary Electron renderer available with the explicit Astra diagnostic disable', () => {
    const output = execFileSync(process.execPath, ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--default-off'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
    });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', exactDevSwitch: false, defaultOffVerified: true,
      pilot: false, deploymentSurface: false, composerMounted: false, legacyComposerMounted: true,
      isolatedRoots: true, pageErrors: [] });
    roots.push(proof.root);
  }, 100_000);

  it('composes the real source Electron pilot with the isolated MAX host and exposes setup only', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-preview'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed',
      route: 'source-Electron-main-preload-product-renderer', exactDevSwitch: true,
      defaultPackagedActivation: false, isolatedRoots: true, pilot: true, maxPreview: true,
      deploymentSurface: true, composerMounted: true, conversationId: 'astra_product_pilot',
      modelTasksSubmitted: 0, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      maxSetup: { stateBefore: 'not-configured', entryOpensConnect: true, keyValue: '' } });
    expect(proof.uiRead.result).toContain('ASTRA_RENDERER_OWNED');
    roots.push(proof.root);
  }, 100_000);

  it('drives a deterministic MAX model draft through the real Electron UI and exact Kernel approval', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-model-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      maxSetup: { stateBefore: 'not-configured', stateAfter: 'ready', selectedForNewDrafts: 'true',
        modelChoiceAfterSave: 'gpt-oss-120b',
        connectionVerifiedAfterSave: 'false', selectionReadyAfterRefresh: true,
        selectedAfterRefresh: 'true', connectionVerifiedAfterRefresh: 'false',
        connectionVerifiedAfterTask: 'true', keyValue: '', keyValueAfter: '' },
      uiMaxModelCreate: { exactApprovalRequired: false, directWrite: true, exactReadback: true,
        userFacingElapsed: true, modelId: 'openai/gpt-oss-120b', content: 'ASTRA_MAX_UI_MODEL_DRAFT', providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b', toolChoice: 'none', schema: 'monarch_astra_max_safety' },
          { model: 'openai/gpt-oss-120b', toolChoice: 'none', schema: 'monarch_astra_max_proposal' },
          { model: 'openai/gpt-oss-safeguard-20b', toolChoice: 'none', schema: 'monarch_astra_max_safety' },
        ] } });
    expect(proof.uiMaxModelCreate.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 100_000);

  it('answers from one selected file through real Electron with one primary-model generation', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-analysis-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      maxSetup: { selectedForNewDrafts: 'true', modelChoiceAfterSave: 'gpt-oss-120b',
        connectionVerifiedAfterTask: 'true' },
      uiMaxAnalysis: { response: 'MAX прочитал: ASTRA_RENDERER_OWNED.', approvalCreated: false,
        userFacingElapsed: true, providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b' },
          { model: 'openai/gpt-oss-120b' },
          { model: 'openai/gpt-oss-safeguard-20b' },
        ] } });
    expect(proof.uiMaxAnalysis.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 100_000);

  it('answers from one native multi-file selection through one grounded MAX turn', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-multi-analysis-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      uiMaxAnalysis: { response: 'MAX прочитал: ASTRA_RENDERER_OWNED.', approvalCreated: false,
        groundedBoth: true, providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b' },
          { model: 'openai/gpt-oss-120b', groundedBoth: true },
          { model: 'openai/gpt-oss-safeguard-20b' },
        ] } });
    expectEncryptedJournal(proof.root);
    roots.push(proof.root);
  }, 100_000);

  it('retains the first read and makes no MAX call when a later selected file disappears', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-multi-analysis-missing-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      uiMaxAnalysis: {
        response: 'Оскар не смог прочитать все выбранные файлы. Проверь, что они существуют и доступны, затем выбери их заново и отправь задачу снова.',
        missingRead: true, terminal: 'Завершено не полностью', approvalCreated: false, providerCalls: [],
      } });
    expectEncryptedJournal(proof.root);
    roots.push(proof.root);
  }, 100_000);

  it('fails the real Electron file analysis cleanly when MAX is unavailable', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-analysis-provider-failed-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      maxSetup: { connectionVerifiedAfterTask: 'false' },
      uiMaxAnalysis: { providerFailed: true, approvalCreated: false,
        response: 'Модель не ответила. Проверь подключение MAX и отправь задачу снова.',
        providerCalls: [{ model: 'openai/gpt-oss-safeguard-20b' }] } });
    expect(proof.uiMaxAnalysis.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 100_000);

  it('fails the real Electron file analysis closed when Safety refuses its input', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-analysis-safety-blocked-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      maxSetup: { connectionVerifiedAfterTask: 'false' },
      uiMaxAnalysis: { providerFailed: false, safetyBlocked: true, approvalCreated: false,
        response: 'Проверка безопасности остановила задачу. Измени запрос или выбранные файлы и попробуй снова.',
        providerCalls: [{ model: 'openai/gpt-oss-safeguard-20b' }] } });
    expect(proof.uiMaxAnalysis.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 100_000);

  it('recovers the same selected-file analysis after the source runtime exits during its only primary-model turn', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-analysis-runtime-restart-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 150_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      runtimeRestart: { exactSourceChild: true, providerPendingAtExit: true },
      uiMaxAnalysis: { response: 'MAX прочитал: ASTRA_RENDERER_OWNED.', approvalCreated: false,
        providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b' },
          { model: 'openai/gpt-oss-120b' },
          { model: 'openai/gpt-oss-safeguard-20b' },
        ] } });
    expect(proof.runtimeRestart.exitedRuntimePid).not.toBe(proof.runtimeRestart.recoveredRuntimePid);
    expect(proof.uiMaxAnalysis.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    expectEncryptedJournal(proof.root);
    roots.push(proof.root);
  }, 160_000);

  it('recovers the same MAX task after the source runtime child exits without repeating provider work', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-runtime-restart-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 150_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      runtimeRestart: { exactSourceChild: true, providerPendingAtExit: true },
      uiMaxModelCreate: { exactApprovalRequired: false, directWrite: true, exactReadback: true, content: 'ASTRA_MAX_UI_MODEL_DRAFT',
        providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b' },
          { model: 'openai/gpt-oss-120b' },
          { model: 'openai/gpt-oss-safeguard-20b' },
        ] } });
    expect(proof.runtimeRestart.exitedRuntimePid).not.toBe(proof.runtimeRestart.recoveredRuntimePid);
    expect(proof.uiMaxModelCreate.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 160_000);

  it('keeps a configured MAX host local until the user explicitly selects MAX for a new draft', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-unselected-model-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTaskAttempts: 1, modelTasksSubmitted: 0, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      maxSetup: { stateAfter: 'ready', selectedForNewDrafts: 'false', selectionReadyAfterRefresh: true,
        modelChoiceAfterSave: 'gpt-oss-120b',
        selectedAfterRefresh: 'false', connectionVerifiedAfterSave: 'false',
        connectionVerifiedAfterRefresh: 'false', connectionVerifiedAfterTask: 'false',
        keyValue: '', keyValueAfter: '' },
      uiMaxModelCreate: { selectionRequired: true, taskCreated: false, providerCalls: [], approvalCreated: false,
        fileCreated: false, message: 'Выбери MAX в меню моделей и отправь задачу снова.', turnId: null } });
    roots.push(proof.root);
  }, 100_000);

  it('fails closed through the real Electron route when Safety blocks the MAX input', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-safety-blocked-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      uiMaxModelCreate: { safetyBlocked: true, safetyStage: 'input', approvalCreated: false, fileCreated: false,
        modelId: null, content: null, terminal: 'Заблокировано', providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b', toolChoice: 'none', schema: 'monarch_astra_max_safety' },
        ] } });
    expect(proof.uiMaxModelCreate.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 100_000);

  it('fails closed through the real Electron route when Safety blocks the MAX output', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-output-safety-blocked-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      uiMaxModelCreate: { safetyBlocked: true, safetyStage: 'output', approvalCreated: false, fileCreated: false,
        modelId: null, content: null, terminal: 'Заблокировано', providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b' },
          { model: 'openai/gpt-oss-120b' },
          { model: 'openai/gpt-oss-safeguard-20b' },
        ] } });
    expect(proof.uiMaxModelCreate.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 100_000);

  it('shows actionable guidance and performs no write when the MAX provider is unavailable', () => {
    execFileSync(process.execPath, ['scripts/build-astra-max-preview.mjs'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const output = execFileSync(process.execPath,
      ['tests/fixtures/agent-v3/product-pilot-renderer-check.mjs', '--max-provider-failed-task'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000, windowsHide: true,
      });
    const proof = JSON.parse(output.split(/\r?\n/u).find(line => line.startsWith('{"result":"PASS"')) || '{}');
    expect(proof).toMatchObject({ result: 'PASS', status: 'passed', pilot: true, maxPreview: true,
      modelTasksSubmitted: 1, externalNetworkRequests: 0, safeUiInvoked: false, pageErrors: [],
      maxSetup: { connectionVerifiedAfterTask: 'false' },
      uiMaxModelCreate: { providerFailed: true, safetyBlocked: false, safetyStage: null,
        summary: 'Модель не ответила. Проверь подключение и отправь задачу снова. Создание файла не произошло.',
        approvalCreated: false, fileCreated: false, modelId: null, content: null, terminal: 'Заблокировано',
        providerCalls: [
          { model: 'openai/gpt-oss-safeguard-20b', toolChoice: 'none', schema: 'monarch_astra_max_safety' },
        ] } });
    expect(proof.uiMaxModelCreate.turnId).toMatch(/^oscar_turn_[a-f0-9]{32}$/u);
    roots.push(proof.root);
  }, 100_000);
});
