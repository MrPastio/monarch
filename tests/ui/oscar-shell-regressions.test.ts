import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const oscarSource = readFileSync('src/ui/public/modules/oscar-pane.js', 'utf8');
const utilsSource = readFileSync('src/ui/public/modules/utils.js', 'utf8');
const styles = readFileSync('src/ui/public/styles-v2.css', 'utf8');
const appSource = readFileSync('src/ui/public/app.js', 'utf8');
const indexSource = readFileSync('src/ui/public/index.html', 'utf8');
const voiceModeSource = readFileSync('src/ui/public/modules/oscar-voice-mode.js', 'utf8');
const coderSource = readFileSync('src/ui/public/modules/coder-pane.js', 'utf8');
const coderStyles = readFileSync('src/ui/public/coder.css', 'utf8');

describe('Oscar live shell regressions', () => {
  it('keeps the history drawer anchored to the trigger that opened it', () => {
    expect(styles).toMatch(/\.sidebar-history\[data-anchor="topbar"\]\s*\{[^}]*right:\s*18px;[^}]*left:\s*auto;/s);
    expect(styles).toMatch(/\.sidebar-history\[data-anchor="sidebar"\]\s*\{[^}]*right:\s*auto;[^}]*left:\s*calc\(var\(--sidebar\) \+ 18px\);/s);
  });

  it('fits every visible mobile navigation item on one row and keeps feedback above it', () => {
    const mobileResetStart = styles.indexOf(':root { --sidebar: 0px; --topbar-h: 66px; }');
    const mobileReset = styles.slice(mobileResetStart, mobileResetStart + 5000);
    expect(mobileResetStart).toBeGreaterThan(-1);
    expect(styles).toContain('.nav-stack { grid-template-columns: repeat(7, minmax(0, 1fr)); }');
    expect(styles).toContain('.nav-item[data-settings-open="memory"]');
    expect(mobileReset).toContain('bottom: calc(82px + env(safe-area-inset-bottom, 0px));');
  });

  it('routes persistent memory through Control instead of covering the conversation', () => {
    expect(indexSource).toContain('data-scroll-target="settings-section" data-settings-open="memory"');
    expect(indexSource).not.toContain('data-oscar-memory-nav');
  });

  it('resets document feeds and transient overlays when the user changes views', () => {
    expect(appSource).toContain('resetViewScroll(target);');
    expect(appSource).toContain("target.querySelectorAll('.document-feed')");
    expect(appSource).toContain('hideSafeLaunchFeedback();');
    expect(appSource).toContain('closeComposerOptions();');
  });

  it('consolidates composer tools under plus and reveals model choice only through Intelligence', () => {
    expect(indexSource).toContain('id="oscar-composer-menu"');
    expect(indexSource).toContain('data-oscar-attach-photo');
    expect(indexSource).toContain('id="oscar-intelligence-toggle"');
    expect(indexSource.indexOf('id="oscar-model-dropdown-container"'))
      .toBeLessThan(indexSource.indexOf('id="oscar-voice-input"'));
    expect(appSource).toContain("modelContainer.hidden = !intelligenceEnabled");
    expect(styles).toContain('#oscar-composer.intelligence-enabled .composer-input-row');
  });

  it('keeps the Chat and Coder mode switch explicit and animates its active indicator', () => {
    expect(indexSource).toContain('data-active-mode="chat"');
    expect(indexSource).toContain('id="chat-mode-coder" type="button" role="tab" aria-selected="false">Coder</button>');
    expect(coderSource).toContain("setAttribute('data-active-mode', active ? 'coder' : 'chat')");
    expect(coderStyles).toContain('.chat-mode-switch::before');
    expect(coderStyles).toContain('--chat-mode-indicator-x: 100%');
    expect(coderStyles).toContain('transform .42s cubic-bezier(.22, 1, .36, 1)');
    expect(coderStyles).toContain('.chat-mode-switch::before,');
    expect(coderStyles).toMatch(/#oscar-section\.coder-mode-active \.oscar-topbar\s*\{[^}]*display:\s*grid !important;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;[^}]*z-index:\s*40;[^}]*visibility:\s*visible;/s);
    expect(coderStyles).toContain('#oscar-section.coder-mode-active .chat-mode-switch { justify-self: end; }');
  });

  it('does not render the local Oscar status label beside the mode switch', () => {
    const topbar = indexSource.slice(
      indexSource.indexOf('<div class="oscar-topbar"'),
      indexSource.indexOf('<section id="coder-mode-root"'),
    );
    expect(topbar).not.toContain('id="oscar-diagnostics"');
    expect(topbar).not.toContain('Локально ·');
  });

  it('keeps update actions in the lower-left rail instead of overlaying the mode switch', () => {
    const noticeIndex = indexSource.indexOf('id="monarch-update-notice"');
    const sidebarBottomIndex = indexSource.indexOf('class="sidebar-bottom"');
    const mainCanvasIndex = indexSource.indexOf('class="main-canvas"');
    expect(noticeIndex).toBeGreaterThan(indexSource.indexOf('class="nav-stack"'));
    expect(noticeIndex).toBeLessThan(sidebarBottomIndex);
    expect(sidebarBottomIndex).toBeLessThan(mainCanvasIndex);
    expect(styles).toMatch(/\.monarch-update-notice\s*\{[^}]*position:\s*relative;[^}]*grid-template-columns:\s*32px minmax\(0,\s*1fr\);[^}]*margin-top:\s*auto;/s);
  });

  it('keeps the central mascot permanent until the first message and only then enables the movable mini-mascot', () => {
    expect(indexSource).toContain('data-monarch-brand-cycle');
    expect(indexSource).toContain('data-mascot-resize');
    expect(appSource).toContain('toggleMascotVisibility();');
    expect(appSource).toContain('normalizeUiPreferences(JSON.parse(');
    expect(appSource).toContain('serializeUiPreferences(preferences)');
    expect(oscarSource).toContain('!hasSentOscarMessage(state.oscar.messages)');
    expect(oscarSource).toContain("dispatchEvent(new Event('monarch:mascot-surface-changed'))");
    expect(styles).toContain('.app-shell.mascot-empty-home .inspector.mascot-active:not(.snake-game-host-active)');
    expect(styles).toContain('.app-shell.mascot-dialog-active.mascot-visible .inspector.mascot-active:not(.snake-game-host-active)');
    expect(styles).toContain('.app-shell.mascot-empty-home .mascot-resize-handle { display: none; }');
    expect(styles).toContain('left: var(--mascot-x, 200px);');
    expect(styles).toContain('.mascot-resize-handle');
  });

  it('offers explicit research control and renders animated high-level research progress', () => {
    expect(indexSource).toContain('id="oscar-research-dropdown-btn"');
    expect(indexSource).toContain('data-value="deep"');
    expect(appSource).toContain("state.oscar.researchMode = oscarResearchDropdownItem.getAttribute('data-value') || 'auto'");
    expect(oscarSource).toContain("research_mode: ['auto', 'off', 'deep'].includes(state.oscar.researchMode)");
    expect(oscarSource).toContain("event.type === 'research'");
    expect(styles).toContain('.oscar-live-stage[data-phase^="research-"]');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('replaces generic thinking dots with the Monarch-adapted ThinkingOrb states', () => {
    expect(utilsSource).toContain('renderMonarchThinkingOrb(streamPhase)');
    expect(utilsSource).toContain('renderMonarchThinkingOrb(phase)');
    expect(utilsSource).not.toContain('class="oscar-thinking-dots"');
    expect(styles).toContain('MIT-derived motion primitive: @illuma-ai/icons ThinkingOrb 2.7.0');
    expect(styles).toContain('.monarch-thinking-orb[data-orb-phase="research-search"]');
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.monarch-thinking-orb__core/);
  });

  it('renders ordinary thinking as a bare orb without a status card or copy', () => {
    expect(utilsSource).toContain('class="oscar-message assistant pending thinking-only"');
    expect(utilsSource).toContain('class="oscar-orb-only-status"');
    expect(utilsSource).not.toContain('class="oscar-thinking-copy"');
    expect(styles).toContain('.oscar-orb-only-status');
    expect(styles).toMatch(/\.oscar-thinking-only\s*\{[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;/s);
  });

  it('keeps research confirmation in the answer card and morphs it into visible stages', () => {
    expect(oscarSource).toContain('messageId: pendingMessage.id');
    expect(oscarSource).toContain("deepResearch: routePreview?.research_mode === 'deep'");
    expect(oscarSource).toContain("pending.routeConsent = {");
    expect(oscarSource).toContain("? 'Начать исследование'");
    expect(oscarSource).toContain("? 'Искать в интернете'");
    expect(oscarSource).toContain("settleOscarRouteConsent(routeDecisionButton.getAttribute('data-oscar-route-decision')");
    expect(oscarSource).toContain('animateOscarConsentExpansion(messageId, fromRect)');
    expect(oscarSource).not.toContain("overlay.className = 'oscar-route-consent'");
    expect(oscarSource).not.toContain('document.body.appendChild(overlay)');
    expect(styles).toContain('.oscar-message.assistant.route-consent');
    expect(styles).toContain('.oscar-research-timeline');
    expect(styles).toContain('@keyframes oscarConsentFallbackIn');
  });

  it('pins the fullscreen Voice surface after focus and phase changes', () => {
    expect(voiceModeSource).toContain('keepSurfaceAtOrigin();');
    expect(voiceModeSource).toContain('surface.scrollTop = 0;');
    expect(styles).toMatch(/\.oscar-voice-mode\s*\{[^}]*height:\s*100dvh;[^}]*max-height:\s*100dvh;/s);
  });

  it('makes persisted density and inspector preferences affect the active stylesheet', () => {
    expect(styles).toContain('body[data-density="compact"] .nav-item');
    expect(styles).toMatch(/\.app-shell\.inspector-collapsed\.mascot-dialog-active \.inspector\s*\{[^}]*display:\s*none !important;/s);
  });

  it('loads persistent conversations in bounded pages with an explicit older-message control', () => {
    expect(oscarSource).toContain('message_limit: OSCAR_HISTORY_PAGE_SIZE');
    expect(oscarSource).toContain('before,');
    expect(oscarSource).toContain('data-oscar-load-older');
    expect(oscarSource).not.toMatch(/\n\s*isDone = true;\s*\n\s*const generatedContent/);
  });

  it('keeps history rename and delete actions explicitly named', () => {
    expect(oscarSource).toContain('aria-label="${escapeHtml(`Переименовать чат: ${title}`)}" title="Переименовать"');
    expect(oscarSource).toContain('aria-label="${escapeHtml(`Удалить чат: ${title}`)}" title="Удалить"');
  });

  it('moves encrypted chats into Monarch Safe and keeps their model turns incognito to SQLite', () => {
    expect(indexSource).toContain('id="oscar-safe-encrypt"');
    expect(oscarSource).toContain("incognito: state.oscar.incognito === true || state.oscar.encrypted === true");
    expect(oscarSource).toContain("use_memory: state.oscar.incognito !== true && state.oscar.encrypted !== true");
    expect(oscarSource).toContain("await bridge.writeSafeChat(record)");
    expect(oscarSource).toContain("action: 'delete', id: conversationId");
    expect(oscarSource).toContain("if (stored?.verified !== true)");
    expect(oscarSource).toContain('sealActiveEncryptedConversation');
    expect(styles).toContain('.conversation-item.is-encrypted');
  });

  it('moves terminal Coder journals into the same Safe chat boundary', () => {
    expect(indexSource).toContain('id="coder-safe-encrypt"');
    expect(indexSource).toContain('id="coder-safe-chat-select"');
    expect(coderSource).toContain("kind: 'coder'");
    expect(coderSource).toContain('await bridge.writeSafeChat');
    expect(coderSource).toContain('await deleteCoderRun(run.id)');
    expect(coderSource).toContain("await bridge.deleteSafeChat(run.id, 'coder')");
    expect(coderSource).toContain('if (coderState.runEncrypted) coderState.run = null');
    expect(coderStyles).toContain('.coder-workspace-actions .coder-safe-button.is-active');
  });

  it('releases the idle neural voice model before a desktop Coder run starts', () => {
    expect(coderSource).toContain("typeof window.monarchDesktop?.releaseSpeechOutput === 'function'");
    expect(coderSource).toContain('await window.monarchDesktop.releaseSpeechOutput()');
    expect(coderSource.indexOf('await window.monarchDesktop.releaseSpeechOutput()'))
      .toBeLessThan(coderSource.indexOf('await startCoderRun(prompt, projectId, coderState.model)'));
  });

  it('releases the idle neural voice model before a desktop Oscar model route starts', () => {
    expect(oscarSource).toContain('oscarSpeechController?.releaseForInference');
    expect(oscarSource).toContain('await oscarSpeechController.releaseForInference()');
    expect(oscarSource.indexOf('await oscarSpeechController.releaseForInference()'))
      .toBeLessThan(oscarSource.indexOf("executeOscarCapabilityAction('oscar.chat.route'"));
    expect(oscarSource).toContain('void oscarSpeechController?.restoreAfterInference()');
  });

  it('keeps the exact Coder launch folder visible and separates model switching from failures', () => {
    expect(indexSource).toContain('id="coder-run-project-root"');
    expect(coderSource).toContain("run.projectRoot || coderState.snapshot?.project?.root || ''");
    expect(coderSource).toContain('`Папка запуска · ${projectRoot}`');
    expect(coderSource).toContain("renderRunProjectRoot('');");
    expect(coderSource).toContain("tone: 'switching'");
    expect(coderSource).toContain("tone: 'failure'");
    expect(coderSource).toContain("failed: 'Нужна проверка'");
    expect(coderSource).toContain('presentCoderFailureDetail(detail)');
    expect(coderSource).toContain('Локальный backend не ответил. Повтори сессию после его перезапуска.');
    expect(styles).toContain('.coder-event[data-tone="switching"]');
    expect(styles).toContain('.coder-event[data-tone="failure"]');
  });

  it('keeps the Coder session recoverable and every workspace panel reachable on mobile', () => {
    const startIndex = coderSource.indexOf('await startCoderRun(prompt, projectId, coderState.model)');
    const clearDraftIndex = coderSource.indexOf("elements.input.value = '';", startIndex);
    expect(startIndex).toBeGreaterThan(-1);
    expect(clearDraftIndex).toBeGreaterThan(startIndex);
    expect(coderSource).toContain('coderState.pollFailures >= 4');
    expect(coderSource).toContain("elements.runRetry.textContent = 'Обновить состояние'");
    expect(coderSource).toContain("button.setAttribute('role', 'treeitem')");
    expect(coderSource).toContain("button.setAttribute('aria-expanded'");
    expect(indexSource).toContain('id="coder-mobile-project"');
    expect(indexSource).toContain('id="coder-mobile-result"');
    expect(indexSource).toContain('id="coder-run-summary"');
    expect(coderStyles).toContain('.coder-explorer.is-mobile-open');
    expect(coderStyles).toContain('.coder-context-panel.is-mobile-open');
    expect(coderStyles).toContain('.app-shell.coder-workspace-active .inspector');
  });

  it('renders durable Code history as a searchable cross-project workspace instead of a select placeholder', () => {
    expect(indexSource).not.toContain('id="coder-run-select"');
    expect(indexSource).toContain('id="coder-history-drawer"');
    expect(indexSource).toContain('id="coder-history-search"');
    expect(indexSource).toContain('id="coder-history-project"');
    expect(indexSource).toContain('data-coder-history-status="completed"');
    expect(indexSource).toContain('Требуют внимания');
    expect(coderSource).toContain('await Promise.all([fetchCoderOverview(), fetchCoderRuns()])');
    expect(coderSource).toContain('createHistoryRunCard(run)');
    expect(coderSource).toContain('run.summary?.lastAssistantSummary');
    expect(coderSource).toContain('archivedProjects.push');
    expect(coderSource).toContain('await activateHistoryProject(run.projectId)');
    expect(coderSource).toContain('buildHistoryContinuationPrompt(run)');
    expect(coderSource).toContain('await deleteCoderRun(run.id)');
    expect(coderStyles).toContain('.coder-history-drawer');
    expect(coderStyles).toContain('.coder-history-item[data-active="true"]');
  });

  it('keeps the empty Code composer in its own grid row when the run summary is hidden', () => {
    expect(coderStyles).toContain("'summary'");
    expect(coderStyles).toContain("'activity'");
    expect(coderStyles).toContain("'composer'");
    expect(coderStyles).toContain('.coder-run-summary { grid-area: summary;');
    expect(coderStyles).toContain('.coder-activity { grid-area: activity;');
    expect(coderStyles).toContain('.coder-composer { grid-area: composer;');
  });

  it('keeps lifecycle and model progress visible in the primary Code journal', () => {
    expect(coderSource).toContain("event?.kind === 'status'");
    expect(coderSource).toContain("event?.kind === 'model'");
    expect(coderSource).toContain("presentation.tone === 'progress'");
  });

  it('locks repeated stop requests while active Coder inference is being cancelled', () => {
    expect(coderSource).toContain('coderState.cancelBusy || coderState.run.cancelled');
    expect(coderSource).toContain("elements.cancel.textContent = cancellationRequested ? 'Останавливаю…' : 'Остановить'");
    expect(coderSource).toContain("title: 'Останавливаю модель'");
    expect(coderStyles).toContain('.coder-composer button:disabled');
  });

  it('keeps large conversation histories searchable without a second backend request', () => {
    expect(indexSource).toContain('id="oscar-history-search"');
    expect(indexSource).toContain('aria-label="Поиск по истории чатов"');
    expect(oscarSource).toContain("elements.oscarHistorySearch?.addEventListener('input', () => renderConversationList())");
    expect(oscarSource).toContain("visibleConversations.length === 0");
    expect(oscarSource).toContain('Совпадений нет');
  });

  it('never merges proposal narration into the verified action receipt', () => {
    expect(oscarSource).toContain('executionNeedsAuthoritativeReceipt(execution)');
    expect(oscarSource).toContain('const receipt = completedSteps.length === 1');
    expect(oscarSource).not.toContain("options.visibleAnswer || ''");
    expect(oscarSource).not.toContain('visibleAnswer: activation.content');
    expect(oscarSource).not.toContain('visibleAnswer: fallbackParser.getContent(true)');
  });

  it('renders every workspace module as a scannable card', () => {
    const modelManagerSource = readFileSync('src/ui/public/modules/model-manager.js', 'utf8');
    expect(modelManagerSource).toContain('modules.map((record) =>');
    expect(modelManagerSource).not.toContain('modules.slice(0, 14)');
    expect(modelManagerSource).toContain('workspace-module-card');
    expect(styles).toContain('.file-tree-mock:has(.workspace-module-card)');
  });
});
