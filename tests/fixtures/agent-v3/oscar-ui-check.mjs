// Repeatable real browser/HTTP/Kernel check; all artifacts stay in this host's
// exact marked D: synthetic child, outside committed source and user profiles.
import { chromium } from 'playwright-core';
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const [base, root] = process.argv.slice(2);
const parent = await realpath('.test-tmp');
assert.equal(await realpath(root), root); assert.equal(path.dirname(root), parent);
assert.equal(path.parse(parent).root.toUpperCase(), 'D:\\'); assert.ok(path.basename(root).startsWith('astra-v3-oscar-ui-'));
assert.equal(await readFile(path.join(root, '.fixture-marker'), 'utf8'), 'astra-v3-oscar-bridge-synthetic-only');
const url = new URL(base); assert.equal(url.hostname, '127.0.0.1');
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 960 } });
await context.route('**/*', route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
const page = await context.newPage(), errors = [], requests = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (request.method() === 'POST') requests.push({ url: request.url(), body: request.postData() }); });
const evidence = async () => { const response = await fetch(base + '/__fixture/evidence', { headers: { Authorization: 'Bearer astra-owned-ui-fixture-token' } }); assert.ok(response.ok); return response.json(); };
try {
  await page.goto(base); assert.equal(await page.title(), 'Astra V3 · изолированная проверка');
  assert.ok((await page.locator('body').innerText()).includes('Только цели, выбранные хостом'));
  console.log('INITIAL_DOM', await page.locator('main').ariaSnapshot());
  await page.getByLabel('Задача', { exact: true }).fill('  Прочитай выбранный файл. 🟠  ');
  // Drop the actual server's admission response once: recovery must find that
  // same task, not issue a replacement request or duplicate physical read.
  let lost = false, accepted;
  const acceptedAdmission = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('real-admission-response-timeout')), 15000);
    accepted = () => { clearTimeout(timeout); resolve(); };
  });
  let release; const releaseAdmission = new Promise(resolve => { release = resolve; });
  await page.route('**/api/oscar/turns', async route => {
    if (!lost && route.request().method() === 'POST') { lost = true; const response = await route.fetch();
      assert.ok(response.ok()); accepted(); await releaseAdmission; await route.abort('failed').catch(() => {}); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Выполнить выбранное действие' }).click();
  await acceptedAdmission;
  assert.ok(new URL(page.url()).searchParams.get('pendingRequestId'));
  assert.equal(new URL(page.url()).searchParams.has('turnId'), false);
  await page.reload(); release();
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 20000 });
  let proof = await evidence(); assert.equal(proof.kernelCalls, 1); assert.equal(proof.turns.length, 1);
  assert.equal(new URL(page.url()).searchParams.has('pendingRequestId'), false);
  await page.unroute('**/api/oscar/turns');
  await page.getByLabel('Выбранная цель').selectOption({ label: 'Создать Новый отчёт.txt' });
  await page.getByLabel('Источник содержимого').selectOption('reply');
  await page.getByLabel('Задача', { exact: true }).fill('Обработай выбранную цель согласно явно заданному действию.');
  await page.getByRole('button', { name: 'Выполнить выбранное действие' }).click();
  await page.getByRole('heading', { name: 'Нужно содержимое файла' }).waitFor({ timeout: 20000 });
  console.log('QUESTION_DOM', await page.locator('main').ariaSnapshot());
  const exact = '  Точное содержимое 🟠\n<script>window.untrustedExecuted=true</script>\n  ';
  await page.getByLabel('Введи точное содержимое нового файла. Пустой ответ создаст пустой файл.').fill(exact);
  await page.getByRole('button', { name: 'Отправить точный ответ' }).click();
  await page.getByRole('heading', { name: 'Разрешить создание файла?' }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator('.astra-content').textContent(), exact);
  assert.equal(await page.locator('.astra-content script').count(), 0);
  proof = await evidence(); assert.equal(proof.content, null); assert.equal(proof.kernelCalls, 2);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'На паузе' }).waitFor({ timeout: 15000 });
  const turnId = proof.turns.find(turn => turn.status === 'waiting-for-approval').id;
  assert.equal(new URL(page.url()).searchParams.get('turnId'), turnId);
  await page.reload();
  await page.getByRole('heading', { name: 'Разрешить создание файла?' }).waitFor();
  await page.getByRole('status').filter({ hasText: 'На паузе' }).waitFor();
  await page.screenshot({ path: path.join(root, 'approval-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(root, 'approval-mobile.png'), fullPage: true });
  console.log('APPROVAL_DOM', await page.locator('main').ariaSnapshot());
  // Lose an accepted input response. Exact retry must replay the same IDs and
  // decision; this is not a fake backend success.
  let inputLost = false;
  await page.route('**/astra-input', async route => {
    if (!inputLost) { inputLost = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Разрешить один раз' }).click();
  await page.getByRole('button', { name: 'Повторить тот же запрос' }).waitFor();
  proof = await evidence(); assert.equal(proof.content, null);
  await page.getByRole('button', { name: 'Повторить тот же запрос' }).click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).waitFor();
  const decisions = requests.filter(request => request.url.endsWith('/astra-input') && request.body.includes('"decide"'));
  assert.equal(decisions.length, 2); assert.equal(decisions[0].body, decisions[1].body);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 20000 });
  proof = await evidence(); assert.equal(proof.content, exact); assert.equal(proof.kernelCalls, 3);
  assert.equal(proof.modelCalls, 0); assert.equal(proof.legacyCalls, 0); assert.equal(proof.answerCalls, 0);
  assert.ok(proof.turns.every(turn => turn.outcome === 'partial'));
  await page.reload(); await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor();
  assert.equal((await evidence()).kernelCalls, 3);
  await page.screenshot({ path: path.join(root, 'complete-mobile.png'), fullPage: true });
  console.log('FINAL_DOM', await page.locator('main').ariaSnapshot());
  // A submission that never reached the server can be cancelled by the exact
  // authenticated actor before admission. Do not strand the user behind Retry.
  await page.getByLabel('Задача', { exact: true }).fill('Прочитай выбранный файл.');
  await page.route('**/api/oscar/turns', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.getByRole('button', { name: 'Выполнить выбранное действие' }).click();
  await page.getByRole('button', { name: 'Отменить отправку' }).waitFor();
  const pendingRequestId = new URL(page.url()).searchParams.get('pendingRequestId'); assert.ok(pendingRequestId);
  await page.reload();
  await page.getByRole('button', { name: 'Проверить отправку' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Повторить тот же запрос' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Выполнить выбранное действие' }).isEnabled(), false);
  await page.screenshot({ path: path.join(root, 'pending-reload-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Отменить отправку' }).click();
  await page.getByRole('status').filter({ hasText: 'Отмена отправки принята' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('pendingRequestId'), false);
  assert.equal((await evidence()).kernelCalls, 3);
  const cancellation = requests.find(request => request.url.endsWith('/turn-cancellations'));
  assert.equal(JSON.parse(cancellation.body).astra, true);
  assert.equal(JSON.parse(cancellation.body).clientRequestId, pendingRequestId);
  // Only the two intentionally aborted network requests may log Chromium's
  // net::ERR_FAILED. Any JavaScript/framework/other resource error is a failure.
  const expectedLookupMiss = errors.filter(message => message.includes('status of 404 (Not Found)'));
  assert.equal(expectedLookupMiss.length, 2);
  const unexpected = errors.filter(message => !message.includes('net::ERR_FAILED') && !message.includes('net::ERR_ABORTED') && !message.includes('status of 404 (Not Found)'));
  assert.deepEqual(unexpected, []); console.log('BROWSER_PASS', JSON.stringify({ ...proof, errors, screenshots: root }));
} catch (error) {
  console.log('FAILED_DOM', await page.locator('main').ariaSnapshot()); console.log('FAILED_CONSOLE', JSON.stringify(errors));
  await page.screenshot({ path: path.join(root, 'failed.png'), fullPage: true }); throw error;
} finally { await context.close(); await browser.close(); }
