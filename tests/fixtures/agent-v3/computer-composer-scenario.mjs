import assert from 'node:assert/strict';
import path from 'node:path';
/** Existing Oscar UI +actual Electron IPC/HTTP/Kernel; native responses and OS
 * modal choice are controlled. Never presented as native capture/modal proof. */
export async function runComputerComposer({ current, launch, close, proof, artifact, errors, consoleMessages, realComputer = false }) {
  let { page } = current();
  await page.getByRole('button', { name: 'Выбрать окно для наблюдения', exact: true }).click();
  const target = page.getByLabel('Выбранная цель');
  await target.locator('option:checked').filter({ hasText: 'Наблюдать окно' }).waitFor({ state: 'attached' });
  assert.equal((await proof()).computer.listings, 1); assert.equal((await proof()).computer.captures, 0);
  assert.equal(await page.getByLabel('Источник содержимого', { exact: true }).isVisible(), false);
  await page.getByLabel('Сообщение Oscar', { exact: true }).fill('  Наблюдай выбранное окно 🟠\n');
  await page.locator('#oscar-composer').evaluate(form => form.requestSubmit());
  const details = page.getByRole('button', { name: 'Показать сохранённое наблюдение', exact: true });
  await details.waitFor({ timeout: 15000 }); await details.click();
  const observedText = realComputer ? 'ASTRA_OWNED_WINDOW_VALUE_42' : 'ASTRA_OSCAR_WINDOW_42';
  await page.locator('pre').filter({ hasText: observedText }).waitFor();
  assert.equal(await page.locator('script').filter({ hasText: 'not executable' }).count(), 0);
  assert.equal((await proof()).computer.captures, 1);
  assert.ok((await page.locator('main').innerText()).includes('Клики и ввод не разрешены'));
  await page.screenshot({ path: path.join(artifact, 'computer-observed-desktop.png') });
  const before = await proof(); assert.equal(before.turns.length, 1); assert.equal(before.turns[0].outcome, 'partial');
  // Same exact durable Turn and message; no replacement task after renderer reload.
  await page.reload(); await details.waitFor({ timeout: 15000 }); await details.click();
  await page.locator('pre').filter({ hasText: observedText }).waitFor();
  assert.equal((await proof()).computer.captures, 1);
  await page.getByRole('button', { name: 'Подготовить действие из снимка', exact: true }).click();
  await page.getByRole('region', { name: 'Подготовка точного действия', exact: true }).waitFor();
  await page.getByLabel('Тип действия', { exact: true }).selectOption('type');
  if (realComputer) {
    const edit = page.getByLabel('Элемент окна', { exact: true });
    const editId = await edit.locator('option').filter({ hasText: 'Edit · Owned replacement test value' }).getAttribute('value');
    assert.ok(editId); await edit.selectOption(editId);
  }
  await page.getByLabel('Точный текст действия', { exact: true }).fill('  ASTRA_OSCAR_ACTION_🟠  ');
  await page.getByLabel('Режим текста', { exact: true }).selectOption('replace');
  await page.getByRole('button', { name: 'Сохранить план без разрешения на ввод', exact: true }).click();
  await target.locator('option:checked').filter({ hasText: 'Действие с подтверждением' }).waitFor({ state: 'attached' });
  assert.equal((await proof()).computer.inputs, 0);
  await page.getByLabel('Сообщение Oscar', { exact: true }).fill('Выполни ровно подготовленное действие после отдельного подтверждения.');
  await page.locator('#oscar-composer').evaluate(form => form.requestSubmit());
  await page.getByRole('heading', { name: 'Разрешить точное действие с окном?', exact: true }).waitFor({ timeout: 15000 });
  assert.equal((await proof()).computer.inputs, 0);
  await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 15000 });
  const expectedProviderCaptures = realComputer ? 1 : 2;
  let actionEvidence = await proof(); assert.equal(actionEvidence.computer.inputs, 1);
  assert.equal(actionEvidence.computer.captures, expectedProviderCaptures);
  if (realComputer) assert.equal(actionEvidence.computer.actualValue, '  ASTRA_OSCAR_ACTION_🟠  ');
  assert.equal(actionEvidence.turns.length, 2);
  const actionTurn = actionEvidence.surface.turnId; assert.equal(actionEvidence.turns.find(turn => turn.id === actionTurn).outcome, 'partial');
  await page.screenshot({ path: path.join(artifact, 'computer-action-approved-desktop.png') });
  await page.reload(); await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 15000 });
  assert.equal((await proof()).computer.inputs, 1);
  await close(); await launch(); ({ page } = current());
  await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor({ timeout: 15000 });
  const after = await proof(); assert.equal(after.computer.captures, 0); assert.equal(after.computer.inputs, 0);
  assert.equal(after.turns[0].id, before.turns[0].id); assert.equal(after.surface.turnId, actionTurn);
  const windows = page.getByLabel('Выбранная цель');
  const key = await windows.locator('option').filter({ hasText: 'Наблюдать окно' }).getAttribute('value');
  await windows.selectOption(key); await page.getByRole('button', { name: 'Отозвать выбор окна', exact: true }).click();
  await page.getByText('Выбор окна отозван.', { exact: false }).waitFor();
  assert.equal(await windows.locator('option').filter({ hasText: 'Наблюдать окно' }).count(), 0);
  await page.setViewportSize({ width: 520, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(artifact, 'computer-revoked-narrow.png') });
  assert.deepEqual(errors, []); assert.ok(consoleMessages.every(message => /\b404\b/.test(message)), JSON.stringify(consoleMessages));
  for (const item of [before, actionEvidence, after, await proof()]) {
    assert.equal(item.modelCalls, 0); assert.equal(item.legacyCalls, 0); assert.equal(item.answerCalls, 0);
    assert.deepEqual(item.unexpectedApiRequests, []);
  }
  assert.equal(actionEvidence.computer.inputs, 1); assert.equal(after.computer.inputs, 0);
  console.log(JSON.stringify({ result: 'PASS', scenario: 'Computer-existing-Oscar-composer', originalTurn: before.turns[0].id,
    actionTurn, providerCapturesAcrossHosts: expectedProviderCaptures, inputsAcrossHosts: 1, nativeModal: false,
    realNativeCapture: realComputer, realNativeInput: realComputer,
    realElectronIpcHttpKernel: true,
    reload: true, hostRestart: true, revoked: true, errors, consoleMessages, artifact }));
}
