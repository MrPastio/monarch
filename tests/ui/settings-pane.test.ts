import { describe, expect, it } from 'vitest';
import {
  PERSONALITY_DIMENSIONS,
  filterMemoryRecords,
  filterVisibleSkills,
  formatPairingTime,
  normalizeSkillDraftValues,
  normalizeSettingsTab,
  renderEpisodeSummary,
  resolveSettingsHeaderCompactState,
  splitSettingsLines,
  unwrapCapabilityPayload,
} from '../../src/ui/public/modules/settings-pane.js';
import { readFileSync } from 'node:fs';

const settingsSource = readFileSync('src/ui/public/modules/settings-pane.js', 'utf8');
const settingsHtml = readFileSync('src/ui/public/index.html', 'utf8');

describe('Monarch Settings UI helpers', () => {
  it('shows an automatic memory episode as the request line plus an escaped outcome excerpt', () => {
    const html = renderEpisodeSummary('Запрос: погода <b>Варна</b>\nИтог: Уточни город.');
    expect(html).toContain('<span>Ты спросил</span><b>погода &lt;b&gt;Варна&lt;/b&gt;</b>');
    expect(html).toContain('<details class="memory-derived-outcome">');
    expect(html).toContain('Уточни город.');
    expect(renderEpisodeSummary('старый формат')).toBe('<p class="memory-derived-text">старый формат</p>');
  });


  it('normalizes editable style rules', () => {
    expect(splitSettingsLines('  На ты.\n\n Сначала результат.  ')).toEqual([
      'На ты.',
      'Сначала результат.',
    ]);
    expect(Object.keys(PERSONALITY_DIMENSIONS)).toEqual([
      'brevity',
      'warmth',
      'directness',
      'initiative',
      'humor',
      'skepticism',
      'technicalDepth',
      'structure',
    ]);
  });

  it('reads direct API execution results and formats pairing expiry', () => {
    const result = { ok: true, output: { pairingCode: '123456' } };
    expect(unwrapCapabilityPayload({ ok: true, result })).toBe(result);
    expect(formatPairingTime('2030-01-01T00:10:00.000Z', Date.parse('2030-01-01T00:00:00.000Z')))
      .toBe('Действует ещё 10 мин');
    expect(formatPairingTime('2030-01-01T00:00:00.000Z', Date.parse('2030-01-01T00:01:00.000Z')))
      .toBe('Код истёк');
  });

  it('shows durable Telegram delivery backlog instead of a fake confirmation count', () => {
    expect(settingsHtml).toContain('id="telegram-pending-summary">Доставок: 0');
    expect(settingsHtml).toContain('id="telegram-photo-summary">Вложения: проверка');
    expect(settingsHtml).toContain('Оскар принимает сообщения, изображения и текстовые документы. Для действий, требующих разрешения, он спросит тебя.');
    expect(settingsSource).toContain("`Вложения: ${Math.round(attachmentMaxBytes / 1024 / 1024)} МиБ · текст ${Math.round(textDocumentMaxBytes / 1024)} КиБ`");
    expect(settingsSource).toContain('Number(status.pendingTaskDeliveries || 0)');
    expect(settingsSource).toContain('`Доставок: ${Math.max(0, Number(status.pendingTaskDeliveries || 0))} · файлов: ${artifactOffers}`');
    expect(settingsSource).not.toContain('`Подтверждений: ${Number(status.pendingConfirmations || 0)}`');
    expect(settingsHtml).toContain('id="telegram-toggle-connection">Подключить бота');
    expect(settingsHtml).toContain('нажми «Подключить бота»');
    expect(settingsSource).toContain("controlTelegram(paused ? 'resume' : 'pause')");
    expect(settingsSource).toContain("controlTelegram('revoke-all')");
    expect(settingsSource).toContain("await confirmAction('Отозвать все Telegram-привязки");
    expect(settingsSource).toContain("controlTelegram('rotate-pairing')");
  });

  it('filters skills and keeps workspace workflows first', () => {
    const skills = [
      { name: 'system-docs', displayName: 'System Docs', scope: 'system', provider: 'codex' },
      { name: 'file-guardian', displayName: 'File Guardian', scope: 'project', provider: 'monarch' },
      { name: 'user-file', displayName: 'User File', scope: 'user', provider: 'gemini' },
    ];
    expect(filterVisibleSkills(skills, '').map((skill) => skill.name)).toEqual([
      'file-guardian',
      'user-file',
      'system-docs',
    ]);
    expect(filterVisibleSkills(skills, 'gemini')).toEqual([skills[2]]);
  });

  it('normalizes the reviewed skill editor payload without granting authority', () => {
    expect(normalizeSkillDraftValues({
      source: 'auto',
      scope: 'user',
      name: '  Release-Guard  ',
      displayName: ' Release Guard ',
      description: ' Проверяет релиз ',
      instructions: ' Сначала проверь.\r\nПотом подтверди. ',
      examples: 'проверь релиз\n\nпроверь релиз повторно',
      requiredCapabilities: 'Workspace.Files.Read\nworkspace.files.write',
      allowImplicitInvocation: true,
    })).toEqual({
      schemaVersion: 1,
      source: 'auto',
      scope: 'user',
      name: 'release-guard',
      displayName: 'Release Guard',
      description: 'Проверяет релиз',
      instructions: 'Сначала проверь.\nПотом подтверди.',
      examples: ['проверь релиз', 'проверь релиз повторно'],
      requiredCapabilities: ['workspace.files.read', 'workspace.files.write'],
      allowImplicitInvocation: true,
    });
  });

  it('filters memory by text and category and keeps pinned records first', () => {
    const records = [
      { id: 'recent', text: 'Любит тёплые ответы', category: 'preference', updatedAt: '2030-01-03T00:00:00Z' },
      { id: 'pinned', text: 'Не трогать рабочую ветку', category: 'project', pinned: true, updatedAt: '2030-01-01T00:00:00Z' },
      { id: 'fact', text: 'Работает над Monarch', category: 'fact', updatedAt: '2030-01-02T00:00:00Z' },
    ];

    expect(filterMemoryRecords(records, '', 'all').map((record) => record.id)).toEqual([
      'pinned',
      'recent',
      'fact',
    ]);
    expect(filterMemoryRecords(records, 'ТЕПЛЫЕ', 'preference')).toEqual([records[0]]);
    expect(filterMemoryRecords(records, 'monarch', 'project')).toEqual([]);
  });

  it('normalizes settings tabs', () => {
    expect(normalizeSettingsTab('telegram')).toBe('telegram');
    expect(normalizeSettingsTab('images')).toBe('images');
    expect(normalizeSettingsTab('models')).toBe('models');
    expect(normalizeSettingsTab('integrations')).toBe('integrations');
    expect(normalizeSettingsTab('dev')).toBe('dev');
    expect(normalizeSettingsTab('voice')).toBe('voice');
    expect(normalizeSettingsTab('style')).toBe('style');
    // Links to the old combined tab land on the answer style.
    expect(normalizeSettingsTab('general')).toBe('style');
    expect(normalizeSettingsTab('unknown')).toBe('models');
  });

  it('keeps the compact header stable until the feed returns to the top', () => {
    expect(resolveSettingsHeaderCompactState(0, false)).toBe(false);
    expect(resolveSettingsHeaderCompactState(31, false)).toBe(false);
    expect(resolveSettingsHeaderCompactState(32, false)).toBe(true);
    expect(resolveSettingsHeaderCompactState(22, true)).toBe(true);
    expect(resolveSettingsHeaderCompactState(2, true)).toBe(false);
  });

  it('keeps the DEV laboratory owner-only and exposes real prompt reset controls', () => {
    expect(settingsHtml).toContain('data-settings-tab="dev" data-owner-dev');
    expect(settingsHtml).toContain('data-dev-setting="zeroRetentionEnabled"');
    expect(settingsHtml).toContain('id="owner-prompts-reset-all"');
    expect(settingsSource).toContain("authority?.source === 'signed-device-entitlement'");
    expect(settingsSource).toContain("writeLocalSettings('prompts.update'");
    expect(settingsSource).toContain("writeLocalSettings('prompts.reset-all'");
    expect(settingsSource).toContain("writeLocalSettings('dev.update'");
    expect(settingsHtml).toContain('id="owner-mode-disable"');
    expect(settingsSource).toContain('window.monarchDesktop.disableOwnerMode()');
    expect(settingsHtml).not.toContain('<strong>Local-first</strong>');
  });

  it('opens the shared agreement flow instead of enabling the provider with a bare toggle', () => {
    expect(settingsSource).toContain("import('./image-generation-pane.js')");
    expect(settingsSource).toContain('acceptImageProviderAgreement()');
    expect(settingsSource).toContain('providerConsentCurrent === true');
    expect(settingsSource).not.toContain("enabled: !imageGenerationPolicy?.providerConsentGrantedAt");
  });

  it('links the official documentation from System settings without attaching local data', () => {
    expect(settingsHtml).toContain('id="monarch-open-documentation"');
    expect(settingsHtml).toContain('https://monarch-local-ai.mrpastio.chatgpt.site/ru/documentation');
    expect(settingsHtml).toContain('чаты, историю, проекты или содержимое Safe');
    expect(settingsHtml).toContain('target="_blank" rel="noreferrer"');
  });
});
