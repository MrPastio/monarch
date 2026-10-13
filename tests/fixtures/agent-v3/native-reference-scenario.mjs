import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';

export async function referenceCase(id = 'project') {
  const cases = JSON.parse(await readFile(new URL('./reference-cases.json', import.meta.url), 'utf8'));
  assert.ok(Object.hasOwn(cases, id), 'unknown-reference-case'); const value = cases[id];
  assert.equal(value.materials.length, 2); assert.ok(value.materials.every(item => typeof item === 'string' && Buffer.byteLength(item) < 4096));
  assert.equal(typeof value.request, 'string'); assert.equal(typeof value.expected, 'string');
  return { id, ...value };
}
/** Test-owned process only. Never discovers product models, configs or credentials. */
export async function startReferenceModel(realRoot, scenario) {
  scenario ??= await referenceCase();
  const parent = await realpath('.test-tmp'); assert.equal(path.parse(parent).root.toUpperCase(), 'D:\\');
  const realModel = Boolean(realRoot);
  const root = realModel ? await realpath(realRoot) : await realpath(await mkdtemp(path.join(parent, 'astra-v3-prepared-model-')));
  assert.equal(path.dirname(root), parent);
  const qa = [['astra-v3-live-smollm2-', 'astra-v3-live-smollm2-owned-cpu-only'], ['astra-v3-live-qwen25-15b-', 'astra-v3-live-qwen25-15b-owned-cpu-only'],
    ['astra-v3-live-gemma4-e4b-', 'astra-v3-live-gemma4-e4b-owned-cpu-only']]
    .find(([prefix]) => path.basename(root).startsWith(prefix));
  assert.ok(realModel ? qa : path.basename(root).startsWith('astra-v3-prepared-model-'));
  const marker = realModel ? qa[1] : 'astra-v3-prepared-model-synthetic-only';
  if (!realModel) await writeFile(path.join(root, '.fixture-marker'), marker, { flag: 'wx' });
  assert.equal((await readFile(path.join(root, '.fixture-marker'), 'utf8')).trim(), marker);
  const child = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', path.resolve('tests/fixtures/agent-v3', realModel ? 'live-model-server.py' : 'model-server.py'), root],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: root, TMP: root, PYTHONDONTWRITEBYTECODE: '1',
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_TOKEN: '', CUDA_VISIBLE_DEVICES: '',
      HF_HOME: path.join(root, 'hf'), HF_TOKEN_PATH: path.join(root, 'hf/token'),
      HF_HUB_CACHE: path.join(root, 'hf/hub'), HF_XET_CACHE: path.join(root, 'hf/xet') } }); child.stdin.end();
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('close', resolve)); child.kill(); await exited;
  } };
  let host;
  try {
    host = await new Promise((resolve, reject) => {
      let stdout = '', stderr = ''; const timer = setTimeout(() => reject(Error('reference-model-startup-timeout')), 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error('reference-model-exit:' + code + ':' + stderr)); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
      child.stdout.on('data', chunk => { stdout += String(chunk);
        if (stdout.length > 32768) { clearTimeout(timer); reject(Error('reference-model-output-budget')); }
        else if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); } catch (error) { reject(error); } }
      });
    });
    assert.equal(host.marker, marker); assert.match(host.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
    const bearerToken = realModel ? 'astra-owned-live-smoke' : 'astra-synthetic-test';
    const headers = { Authorization: 'Bearer ' + bearerToken, 'Content-Type': 'application/json' };
    if (!realModel) {
      const response = await fetch(host.endpoint + '/__fixture/control', { method: 'POST', headers, body: JSON.stringify({ finish: 'stop', block: false,
        output: JSON.stringify({ kind: 'create', requirementId: 'draft_file', capabilityHandle: 'create_file', targetHandle: 'selected_file', content: scenario.expected }) }) });
      assert.equal(response.status, 200);
    }
    return { descriptor: { endpoint: host.endpoint, hostGeneration: host.hostGeneration, modelDigest: host.modelDigest, bearerToken, realModel,
        ...(qa?.[0] === 'astra-v3-live-qwen25-15b-' ? { timeoutMs: 45000 } : qa?.[0] === 'astra-v3-live-gemma4-e4b-' ? { timeoutMs: 90000 } : {}) },
      metrics: async () => { const response = await fetch(host.endpoint + '/__fixture/metrics', { headers }); assert.equal(response.status, 200); return response.json(); },
      close: async () => { await stop(); if (!realModel) {
        assert.equal(await realpath(root), root); assert.equal(path.dirname(root), parent);
        assert.equal(await readFile(path.join(root, '.fixture-marker'), 'utf8'), marker); await rm(root, { recursive: true, force: false });
      } } };
  } catch (error) { await stop(); throw error; } // Failed marked fixture is retained, not guessed successful.
}

/** Actual existing composer/picker/HTTP flow, not DOM-only or canned UI state. */
export async function runReferenceComposer({ current, launch, close, proof, artifact, model, errors, consoleMessages, scenario, recoverFault = false }) {
  const referenceOutput = scenario.expected;
  let { page } = current(); const frames = [], states = [];
  const screenshot = async name => { const target = path.join(artifact, name); await page.screenshot({ path: target }); frames.push(target); };
  await screenshot('reference-first-viewport-desktop.png');
  await page.getByRole('button', { name: 'Выбрать новый файл', exact: true }).click();
  await page.getByLabel('Выбранная цель').locator('option:checked').filter({ hasText: 'Выбранный итог.txt' }).waitFor({ state: 'attached' });
  const target = await page.getByLabel('Выбранная цель').inputValue();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Добавить материал к черновику', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('[data-astra-reference]').length === count, i + 1);
    assert.equal(await page.getByLabel('Выбранная цель').inputValue(), target);
  }
  const material = page.locator('[data-astra-reference]').last();
  const key = await material.getAttribute('data-astra-reference'); await material.getByRole('button').click();
  assert.equal(await page.locator('[data-astra-reference]').count(), 1);
  await page.getByLabel('Доступный материал').selectOption(key);
  await page.getByRole('button', { name: 'Добавить материал из списка', exact: true }).click();
  assert.equal(await page.locator('[data-astra-reference]').count(), 2);
  const text = scenario.request;
  await page.getByLabel('Сообщение Oscar', { exact: true }).fill(text);
  await screenshot('reference-selected-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('group', { name: 'Материалы для черновика' }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await screenshot('reference-selected-mobile.png');
  await page.getByRole('button', { name: 'Новый разговор', exact: true }).click();
  await page.getByLabel('Разговор Astra').locator('option:checked').filter({ hasText: 'Разговор 2' }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-astra-reference]').count(), 0);
  assert.equal(await page.getByLabel('Сообщение Oscar', { exact: true }).inputValue(), '');
  await page.getByLabel('Разговор Astra', { exact: true }).selectOption('conversation');
  await page.locator('section[data-conversation-id="conversation"]').waitFor();
  assert.equal(await page.locator('[data-astra-reference]').count(), 2);
  assert.equal(await page.getByLabel('Выбранная цель').inputValue(), target);
  assert.equal(await page.getByLabel('Сообщение Oscar', { exact: true }).inputValue(), text);
  await page.getByLabel('Сообщение Oscar', { exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelector('.astra-card') || Array.from(document.querySelectorAll('.astra-status'))
    .some(node => /Обработка завершена|Заблокировано|Ошибка/.test(node.textContent)), null, { timeout: (model.descriptor.timeoutMs ?? 20000) + 10000 });
  const state = await proof(), heading = await page.locator('.astra-card h3').textContent().catch(() => null);
  const proposed = heading === 'Разрешить создание файла?' ? await page.locator('.astra-content').textContent() : null;
  const semanticPassed = proposed === referenceOutput;
  const report = { caseId: scenario.id, realModel: model.descriptor.realModel, semanticPassed,
    // Diagnostic only: never weakens the exact approval/write oracle below.
    differsOnlyByFinalNewline: proposed !== null && referenceOutput.endsWith('\n') && proposed === referenceOutput.slice(0, -1),
    expected: referenceOutput, proposed, heading,
    modelMetrics: await model.metrics(), runtime: state, screenshots: frames, artifacts: artifact };
  await writeFile(path.join(artifact, 'reference-model-result.json'), JSON.stringify(report, null, 2));
  // Prove delivery/no effect on FAILED quality runs too, not only the success
  // branch. Extra dispatch or a missing reference is a runtime failure, not a
  // model-quality excuse. This fixture admits exactly two mandatory reads.
  assert.equal(state.content, null); assert.equal(state.modelGenerations, 1);
  assert.equal(report.modelMetrics.generationCalls, 1);
  assert.equal(state.kernelCalls, heading === 'Разрешить создание файла?' ? 3 : 2);
  assert.ok(state.preparedSurfaces.some(surface => {
    const items = JSON.parse(surface).mandatory.filter(item => item.kind === 'evidence');
    return items.length === scenario.materials.length && items.every((item, index) => JSON.parse(item.text).content === scenario.materials[index]);
  }), 'exact-selected-materials-must-reach-prepared-context');
  assert.equal(state.legacyCalls, 0); assert.equal(state.answerCalls, 0); assert.deepEqual(state.unexpectedApiRequests, []);
  if (!semanticPassed) {
    if (heading) await page.locator('.astra-card').scrollIntoViewIfNeeded();
    await screenshot('reference-model-holdout-failed.png');
    if (heading === 'Разрешить создание файла?') {
      await page.getByRole('button', { name: 'Отклонить', exact: true }).click();
      let rejected;
      for (let i = 0; i < 100; i++) { rejected = await proof(); if (rejected.turns.at(-1)?.status === 'blocked') break; await new Promise(resolve => setTimeout(resolve, 50)); }
      report.afterRejection = rejected;
      await writeFile(path.join(artifact, 'reference-model-result.json'), JSON.stringify(report, null, 2));
      assert.equal(rejected.turns.at(-1).status, 'blocked'); assert.equal(rejected.content, null);
      assert.equal(rejected.kernelCalls, state.kernelCalls); assert.equal(rejected.modelGenerations, 1);
      assert.equal((await model.metrics()).generationCalls, 1);
    }
    throw Error('reference-model-quality-not-proven:' + JSON.stringify({ heading, proposed, outcome: state.turns.at(-1)?.outcome }));
  }
  if (recoverFault) {
    await current().electron.evaluate(() => globalThis.astraNativeProof.progressFault(true));
    await page.getByText('Runtime требует внимания: progression-failed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).isDisabled(), true);
    await screenshot('reference-progression-fault.png');
    await current().electron.evaluate(() => globalThis.astraNativeProof.progressFault(false));
    await page.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Повторить проверку runtime', exact: true }).click();
    await page.getByText('Runtime требует внимания: progression-failed', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).isEnabled(), true);
    const recovered = await proof(); assert.equal(recovered.kernelCalls, 3); assert.equal(recovered.modelGenerations, 1);
    assert.equal(recovered.content, null); assert.equal(await page.locator('.astra-content').textContent(), proposed);
    assert.ok(recovered.progressionFailures.some(item => item.message === 'owned-synthetic-progression-fault'));
    await screenshot('reference-progression-recovered.png');
  }
  await screenshot('reference-approval-mobile.png'); states.push(state);
  await close(); await launch(); ({ page } = current());
  await page.getByRole('heading', { name: 'Разрешить создание файла?', exact: true }).waitFor();
  assert.equal((await proof()).kernelCalls, 0); assert.equal((await proof()).modelGenerations, 0);
  assert.equal(await page.locator('.astra-content').textContent(), proposed);
  await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 20000 });
  let final;
  for (let i = 0; i < 80; i++) { final = await proof(); if (final.history?.messages.length === 3) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(final.content, referenceOutput); assert.equal(final.history.messages.length, 3); assert.equal(final.kernelCalls, 1);
  assert.equal(final.modelGenerations, 0); assert.equal(final.turns.at(-1).outcome, 'partial'); states.push(final);
  assert.equal((await model.metrics()).generationCalls, 1);
  for (const item of states) { assert.equal(item.legacyCalls, 0); assert.equal(item.answerCalls, 0); assert.deepEqual(item.unexpectedApiRequests, []);
    assert.equal(item.conversationMemory.productMainImported, false); }
  assert.deepEqual(errors, []); assert.ok(consoleMessages.every(message => /\b404\b/.test(message)), JSON.stringify(consoleMessages));
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('reference-complete-mobile.png');
  await writeFile(path.join(artifact, 'reference-native-proof.json'), JSON.stringify({ result: 'PASS', caseId: scenario.id, semanticPassed,
    realModel: model.descriptor.realModel, recoveredInjectedFault: recoverFault, controlledDialogs: true, installedAcceptance: false, fullRestarts: 1,
    kernelCalls: 4, generationCalls: 1, bytes: Buffer.byteLength(referenceOutput), states, errors, consoleMessages, screenshots: frames }, null, 2));
  console.log('REFERENCE_NATIVE_PASS', JSON.stringify({ artifact, caseId: scenario.id, realModel: model.descriptor.realModel, kernelCalls: 4, generationCalls: 1, fullRestarts: 1, semanticPassed }));
}
