import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(relativePath, 'utf8').replace(/\r\n?/g, '\n');

const oscarSource = readSource('src/ui/public/modules/oscar-pane.js');
const utilsSource = readSource('src/ui/public/modules/utils.js');
const apiSource = readSource('src/ui/public/modules/api.js');
const styles = readSource('src/ui/public/styles-v2.css');
const settingsStyles = readSource('src/ui/public/styles.css');
const settingsSource = readSource('src/ui/public/modules/settings-pane.js');
const appSource = readSource('src/ui/public/app.js');
const indexSource = readSource('src/ui/public/index.html');
const voiceModeSource = readSource('src/ui/public/modules/oscar-voice-mode.js');
const chatSource = readSource('src/ui/public/modules/chat-pane.js');
const coderSource = readSource('src/ui/public/modules/coder-pane.js');
const coderStyles = readSource('src/ui/public/coder.css');
const modeSwitchStyles = readSource('src/ui/public/oscar-mode-switch.css');
const coderViewSource = readSource('src/ui/public/modules/coder-view.js');
const contextMeterSource = readSource('src/ui/public/modules/oscar-context-meter.js');
const historyReconciliationSource = readSource('src/ui/public/modules/oscar-history-reconciliation.js');
const modelManagerSource = readSource('src/ui/public/modules/model-manager.js');
const computerUseControlSource = readSource('src/ui/public/modules/computer-use-control.js');
const oscarFunctionsSource = readSource('src/ui/public/modules/oscar-functions.js');
const securityPaneSource = readSource('src/ui/public/modules/security-pane.js');
const securityStyles = readSource('src/ui/public/security-center.css');
const uiRefreshStyles = readSource('src/ui/public/ui-refresh.css');
const menuStyles = readSource('src/ui/public/composer-menus.css');
const maxSetupSource = readSource('src/ui/public/modules/astra-max-setup.js');
const astraNativeSource = readSource('src/ui/public/modules/oscar-astra-native.js');

describe('Oscar live shell regressions', () => {
  it('branches explicitly to isolated Astra before installing legacy submit, Safe or voice effects', () => {
    const init = oscarSource.slice(oscarSource.indexOf('export function initOscarPane('));
    const branch = init.indexOf("return import('./oscar-astra-composer.js')");
    expect(branch).toBeGreaterThan(0);
    for (const legacy of ['createOscarSpeechController(', 'refreshSafeChatStatus()', "addEventListener('submit'"])
      expect(branch).toBeLessThan(init.indexOf(legacy));
    expect(init).toContain("oscarPaneOwner = 'astra'");
    expect(init).toContain("if (oscarPaneOwner === 'astra') throw Error(");
    expect(appSource).toContain('await initOscarPane(render, { nativeAstra: astraBridge, maxMode: astraMaxMode });');
    expect(appSource).toContain("astraBridge.surface === 'composer'");
  });
  it('exposes Computer Use as an explicit + and @ function with three permission presets', () => {
    const plusMenuStart = indexSource.indexOf('id="oscar-composer-menu-popover"');
    const plusMenu = indexSource.slice(plusMenuStart, indexSource.indexOf('</details>', plusMenuStart));
    expect(plusMenu).toContain('id="oscar-computer-use-toggle"');
    // Direct Access is the base mode, not a menu option.
    expect(plusMenu).not.toContain('oscar-direct-access');
    expect(appSource).toContain('initOscarPlusMenu()');
    expect(styles).toContain('oscarPlusMenuIn');
    expect(styles).toContain('oscarPlusMenuOut');
    expect(plusMenu).toContain('<div class="omenu-segment">');
    expect(plusMenu).toContain('data-computer-use-permission="ask"');
    expect(plusMenu).toContain('data-computer-use-permission="guard"');
    expect(plusMenu).toContain('data-computer-use-permission="full"');
    expect(indexSource).toContain('id="oscar-function-picker"');
    expect(indexSource).toContain('Быстрый вызов: набери <kbd>@</kbd>');
    expect(oscarFunctionsSource).toContain("invocation: '@Computer Use'");
    expect(oscarSource).toContain("ensureComputerUseReady('ui:oscar-explicit-function')");
    expect(computerUseControlSource).toContain("ask: 'guided'");
    expect(computerUseControlSource).toContain("guard: 'workspace-autonomous'");
    expect(computerUseControlSource).toContain("full: 'full-local'");
  });

  it('has no Direct Access toggle and keeps the explicit no-stop-brakes Security warning', () => {
    // Direct Access is the base execution mode of Desktop/Coder. A control that
    // looked like it switched it off would promise something Kernel ignores.
    expect(indexSource).not.toContain('oscar-direct-access');
    expect(indexSource).not.toContain('security-owner-override');
    expect(styles).not.toContain('oscar-direct-access');
    expect(appSource).not.toContain('initOscarDirectAccess');
    expect(securityPaneSource).not.toContain('owner-override');
    expect(indexSource).toContain('id="security-agent-off-warning"');
    expect(indexSource).toContain('Без стоп-кранов');
    expect(securityPaneSource).toContain("securityModelConfirmation?.value !== 'off'");
    expect(securityStyles).toContain('.security-agent-off-warning');
  });

  it('renders generic Astra V3 Security approvals as exact critical action cards', () => {
    expect(oscarSource).toContain("data.approvalKind === 'capability-action'");
    expect(oscarSource).toContain('Monarch Security приостановил потенциально опасное действие.');
    expect(oscarSource).toContain('describeOscarAstraCapabilityApproval(data)');
    expect(oscarSource).toContain("label: 'Подтвердить действие'");
    expect(utilsSource).toContain("message.action?.critical ? ' is-critical' : ''");
    expect(utilsSource).toContain('MONARCH SECURITY · КРИТИЧЕСКОЕ ДЕЙСТВИЕ');
    expect(utilsSource).toContain('message.action.warning');
    expect(utilsSource).toContain('data-oscar-astra-decision="reject">Отклонить</button>');
    expect(utilsSource).toContain('Срок подтверждения истёк. Действие не выполнялось; его всё ещё можно отклонить.');
    expect(settingsStyles).toContain('.oscar-action-card.is-critical');
    expect(settingsStyles).toContain('.oscar-action-preview');
    expect(securityStyles).toContain('backdrop-filter: blur(18px) saturate(118%);');
  });

  it('shows the persistent Stop surface only while Computer Use is enabled', () => {
    expect(indexSource).toContain('id="computer-use-control" data-state="unknown"');
    expect(indexSource).toContain('id="computer-use-stop"');
    expect(indexSource).not.toContain('id="computer-use-start"');
    expect(computerUseControlSource).toContain("control.setAttribute('aria-hidden', String(!['ready', 'active'].includes(status)))");
    expect(uiRefreshStyles).toMatch(/\.computer-use-control\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s);
    expect(uiRefreshStyles).toMatch(/\.computer-use-control\[data-state="active"\]\s*\{[^}]*visibility:\s*visible;[^}]*pointer-events:\s*auto;/s);
  });

  it('preserves an approval card and refreshes its exact binding after a stale approval response', () => {
    expect(apiSource).toContain('if (!response.ok) throw createMonarchHttpError(response.status, payload);');
    expect(oscarSource).toContain("message.action = { ...action, settling: true }");
    expect(oscarSource).toContain("error?.code === 'approval-binding-mismatch'");
    expect(oscarSource).toContain('await fetchAgentTask(taskId)');
    expect(oscarSource).toContain('Действие изменилось — проверь точную цель ещё раз.');
    expect(utilsSource).toContain('message.action?.settling');
  });

  it('lets the user choose a skill in chat without exposing its internal marker', () => {
    const plusMenuStart = indexSource.indexOf('id="oscar-composer-menu-popover"');
    const plusMenu = indexSource.slice(plusMenuStart, indexSource.indexOf('</details>', plusMenuStart));
    expect(indexSource).toContain('id="oscar-skill-picker-toggle"');
    expect(plusMenu).toContain('id="oscar-skill-picker-toggle"');
    expect(indexSource).not.toContain('class="claude-skill-btn"');
    expect(indexSource).toContain('id="oscar-skill-picker-search"');
    expect(indexSource).toContain('id="oscar-selected-skill"');
    expect(indexSource).toContain('Быстрый способ: набери <kbd>$</kbd>');
    expect(oscarSource).toContain('selectComposerSkill(skill)');
    expect(oscarSource).toContain('`$${selectedSkillName} ${visibleText}`');
    expect(utilsSource).toContain('parseSkillInvocation(message.content)');
    expect(utilsSource).toContain('message-skill-invocation');
    expect(settingsSource).toContain("new CustomEvent('monarch:select-skill'");
    expect(styles).toContain('.oscar-skill-picker');
    expect(styles).not.toContain('.claude-skill-btn');
  });

  it('anchors the skill picker to its left-side trigger and keeps the skill icon legible', () => {
    expect(styles).toMatch(/\.oscar-skill-picker\{[^}]*right:auto;left:12px;/);
    expect(menuStyles).toContain('.omenu .omenu-row-icon img');
    expect(styles).toContain('.oscar-selected-skill > img');
    expect(styles).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.oscar-skill-picker\{right:auto;left:-1px;/);
  });

  it('sends every composer request through the durable Turn coordinator without a client execution route', () => {
    expect(apiSource).toContain('export async function createOscarTurn');
    expect(apiSource).toContain('export async function streamOscarTurn');
    expect(apiSource).toContain('export function sendOscarTurnMessage');
    expect(apiSource).toContain('export function cancelOscarTurn');
    expect(apiSource).toContain('export function cancelOscarTurnSubmission');
    expect(apiSource).toContain('export function fetchOscarTurnByClientRequestId');
    expect(apiSource).toContain('export function createOscarDataEgressConsent');
    expect(apiSource).toContain('export async function fetchOscarRequestDisposition');
    expect(oscarSource).toContain(': await createOscarTurn({');
    expect(oscarSource).toContain('await createOscarAstraTurn(oscarNativeAstra.request(');
    expect(oscarSource).toContain('const disposition = await fetchOscarRequestDisposition(text, history, { signal: submissionSignal, webAllowed,');
    expect(oscarSource).toContain('externalResearchRequired = disposition?.requiresExternalResearch === true;');
    // Internet on is permission: search only when the request needs fresh data.
    expect(oscarSource).toContain('webSearch = webAllowed && (externalResearchRequired || disposition?.wantsWeb === true);');
    expect(oscarSource).toContain('await consumeOscarTurn({');
    expect(oscarSource).not.toContain('await shouldUseOscarAgentRuntime(text, attachments)');
    expect(oscarSource).not.toContain('Older/degraded runtimes must fall back to chat');
    expect(oscarSource).not.toContain('await handleOscarAgentTask(');
    expect(oscarSource).not.toContain('async function consumeOscarAgentTask(');
    expect(oscarSource).not.toContain('shouldPreDispatchAgentAction(dispatchedText)');
    expect(oscarSource).not.toContain('await handleDispatchedAction(dispatchedText');
    expect(oscarSource).toContain("case 'approval.required'");
    expect(oscarSource).toContain("case 'agent.progress'");
    expect(oscarSource).toContain("payload.label || 'Agent выполняет задачу'");
    expect(oscarSource).toContain("'Работает'");
    expect(oscarSource).toContain("case 'answer.replace'");
    expect(oscarSource).toContain('if (delta) content += delta;');
    expect(oscarSource).not.toContain("String(payload.content || '').trim()");
    expect(oscarSource).toContain("case 'turn.outcome'");
    expect(oscarSource).toContain('appendUnhydratedLocalAssistant(existingMessages, hydratedMessages)');
    expect(oscarSource).toContain('resolveHydratedOscarMessageLabel(message)');
    expect(oscarSource).not.toContain("formatOscarModelLabel(message.model_tier) || 'история'");
    expect(oscarSource).toContain('error: isHydratedOscarFailure(message.outcome)');
    expect(oscarSource).toContain("case 'user.input.required'");
    expect(oscarSource).toContain("case 'runtime.waiting'");
    expect(oscarSource).toContain('settleOscarRuntimeWait(messageId, action, appRenderCallback)');
    expect(oscarSource).toContain("['waiting-for-user', 'waiting-for-approval', 'waiting-for-runtime']");
    expect(oscarSource).toContain("|| task.status === 'waiting-for-runtime'");
    expect(oscarSource).toContain("case 'non-authoritative-confirmation'");
    expect(oscarSource).not.toContain('activeOscarAgentTaskStreamController');
    expect(oscarSource).toContain('streamController?.abort()');
    expect(oscarSource).toContain('const OSCAR_CANCEL_ACK_TIMEOUT_MS = 15_000;');
    expect(oscarSource).toContain("state.oscar.error = '';\n  state.oscar.stopRequested = true;");
    expect(oscarSource).toContain('await cancelOscarTurn(turnId, { signal: cancelController.signal });');
    expect(oscarSource).toContain('Turn продолжает отслеживаться — можно повторить Stop.');
    expect(oscarSource).toContain("pending.streamPhase = 'cancel-timeout';");
    expect(oscarSource).toContain("label: 'Остановка не подтверждена'");
    expect(oscarSource).toContain("setGenerationPhase('Остановка не подтверждена', state.oscar.error);");
    expect(oscarSource).toContain('let activeOscarSubmissionController = null;');
    expect(oscarSource).toContain('let activeOscarSubmission = null;');
    expect(oscarSource).toContain('let activeOscarApprovalSettlement = null;');
    expect(oscarSource).toContain('if (!approvalTurnId) {');
    expect(oscarSource).toContain('conversationId = await ensureActiveConversation({ signal: submissionSignal });');
    expect(oscarSource).toContain('await cancelOscarSubmissionWithDeadline(');
    expect(oscarSource).toContain('submission.controller.abort(');
    expect(oscarSource).toContain('void denyUnusedOscarDataEgressConsent(submission);');
    expect(oscarSource).toContain('const OSCAR_DATA_EGRESS_CLEANUP_TIMEOUT_MS = 3_000;');
    expect(oscarSource).toContain("cleanupController.abort(new DOMException('Oscar data-egress cleanup timed out.', 'TimeoutError'));");
    expect(oscarSource).toContain('clientRequestId,\n      inputMessageId: userMessage.id,\n      signal: submissionSignal,');
    expect(oscarSource).toContain('if (isOscarTurnCancellationConfirmed(cancelled)) {');
    expect(oscarSource).toContain('} else if (isOscarTurnTerminal(cancelled)) {');
    expect(oscarSource).toContain('} else if (activeOscarApprovalSettlement?.turnId) {');
    expect(oscarSource).toContain("settlement.controller.abort(new DOMException('Oscar approval settlement cancelled by user.', 'AbortError'));");
    expect(historyReconciliationSource).toContain('Задача остановлена. Новые действия и повторные шаги не будут запущены.');
    expect(oscarSource).toContain('return OSCAR_CANCELLED_SUMMARY;');
    expect(oscarSource).toContain("outcome: 'cancelled'");
    expect(oscarSource).toContain('}), pendingMessageId);');
    expect(oscarSource).toContain('if (state.oscar.busy || oscarSubmitInFlight || oscarNewConversationInFlight) return;');
    expect(oscarSource).toContain("Сначала останови текущий Turn");
    expect(chatSource).toContain('const payload = await createOscarTurn({');
    expect(chatSource).toContain('const stream = await streamOscarTurn(jobId);');
    expect(chatSource).not.toContain('submitIntentJob(');
    expect(chatSource).not.toContain('streamIntentJob(');
    expect(oscarSource).not.toContain('Cancellation settled after the active stage.');
    expect(utilsSource).toContain('agent-decision-model-unavailable');
    expect(oscarSource).toContain('replyToTurnId: continuation.turnId');
    expect(oscarSource).toContain("? 'encrypted'");
    expect(oscarSource).toContain("state.oscar.incognito ? 'incognito' : 'persistent'");
    expect(utilsSource).toContain('data-agent-approval-id');
    expect(utilsSource).toContain('&& message.action?.oscarTurnId;');
    expect(utilsSource).toContain('data-oscar-arm-action');
    expect(utilsSource).toContain('data-oscar-runtime-action="resume"');
    expect(utilsSource).toContain('data-oscar-runtime-action="cancel"');
    expect(styles).toContain('.claude-secondary-btn');
  });

  it('keeps a validated restored Turn visible when its SSE reconnect fails', () => {
    const recoveryStart = oscarSource.indexOf('async function restoreActiveOscarSession()');
    const recoveryEnd = oscarSource.indexOf('async function openOscarConversation', recoveryStart);
    const recovery = oscarSource.slice(recoveryStart, recoveryEnd);

    expect(recoveryStart).toBeGreaterThan(-1);
    expect(recovery).toContain('let recoverableTurn = null;');
    expect(recovery).toContain('if (recoverableTurn) {');
    expect(recovery).toContain("label: 'Oscar · восстановление'");
    expect(recovery).toContain('await refreshActiveConversationMessages();');
    expect(recovery.indexOf('if (recoverableTurn) {'))
      .toBeLessThan(recovery.indexOf('await openOscarConversation(saved.conversationId)'));
  });

  it('lets only the latest asynchronous conversation transition mutate the active chat', () => {
    const openStart = oscarSource.indexOf('async function openOscarConversation(conversationId)');
    const openEnd = oscarSource.indexOf('async function loadOlderOscarMessages', openStart);
    const openConversation = oscarSource.slice(openStart, openEnd);
    const newStart = oscarSource.indexOf('export async function startNewOscarConversation()');
    const newEnd = oscarSource.indexOf('async function toggleOscarIncognitoConversation', newStart);
    const newConversation = oscarSource.slice(newStart, newEnd);

    expect(oscarSource).toContain('let oscarConversationTransitionId = 0;');
    expect(oscarSource).toContain('let oscarNewConversationInFlight = false;');
    expect(oscarSource).toContain('const oscarConversationListOwner = createLatestRequestOwner();');
    expect(oscarSource).toContain('if (!oscarConversationListOwner.isCurrent(requestId)) return;');
    expect(oscarSource).toContain('state.oscar.historyBusy && options.supersede !== true');
    expect(openConversation).toContain('const transitionId = ++oscarConversationTransitionId;');
    expect(openConversation).toContain('if (transitionId !== oscarConversationTransitionId) return;');
    expect(openConversation).toContain('if (transitionId === oscarConversationTransitionId) {');
    expect(newConversation).toContain('state.oscar.historyBusy = false;');
    expect(newConversation).toContain('oscarConversationListOwner.invalidate();');
    expect(newConversation).toContain('oscarNewConversationInFlight = true;');
    expect(newConversation).toContain('oscarNewConversationInFlight = false;');
  });

  it('does not misreport an unavailable conversation backend as empty history', () => {
    const loadStart = oscarSource.indexOf('export async function loadOscarConversations');
    const loadEnd = oscarSource.indexOf('async function refreshSafeChatStatus', loadStart);
    const loadHistory = oscarSource.slice(loadStart, loadEnd);
    const renderStart = oscarSource.indexOf('function renderConversationList()');
    const renderEnd = oscarSource.indexOf('function formatConversationCount', renderStart);
    const renderHistory = oscarSource.slice(renderStart, renderEnd);

    expect(loadHistory).toContain('state.oscar.historyError = formatOscarStatusError(error);');
    expect(loadHistory).not.toContain('state.oscar.conversations = [];');
    expect(loadHistory).not.toContain('state.oscar.error =');
    expect(renderHistory).toContain("listState.kind === 'unavailable'");
    expect(renderHistory).toContain('История временно недоступна.');
    expect(renderHistory).toContain('data-oscar-history-retry');
  });

  it('does not present cancellation or waiting states as successful completion', () => {
    const busyStart = oscarSource.indexOf('function setOscarBusy(isBusy)');
    const busyEnd = oscarSource.indexOf('function setOscarMissionsOpen', busyStart);
    const busyState = oscarSource.slice(busyStart, busyEnd);

    expect(busyStart).toBeGreaterThan(-1);
    expect(busyState).toContain("outcome === 'waiting-for-approval'");
    expect(busyState).toContain("outcome === 'waiting-for-user'");
    expect(busyState).toContain("outcome === 'cancelled' || outcome === 'blocked'");
    expect(busyState).toContain("setMascotState('idle')");
  });

  it('keeps persisted image refs visible and opens them through the bound attachment reader', () => {
    expect(apiSource).toContain('export async function fetchOscarAttachment');
    expect(indexSource).toContain('id="oscar-attachment-viewer"');
    expect(utilsSource).toContain('data-message-attachment=');
    expect(oscarSource).toContain('inheritAttachmentPreviews(existingMessages, message)');
    expect(oscarSource).toContain('const payload = await fetchOscarAttachment(attachment.id');
    expect(oscarSource).toContain('resolved.digest !== attachment.digest');
    expect(oscarSource).not.toContain('base64,${attachment.data_base64}`');
    expect(styles).toContain('.attachment-viewer::backdrop');
  });

  it('renders durable Agent Tasks in the glass missions panel with lifecycle controls', () => {
    expect(indexSource).toContain('id="oscar-missions-panel"');
    expect(apiSource).toContain('export function listAgentTasks');
    expect(apiSource).toContain('export function pauseAgentTask');
    expect(apiSource).toContain('export function resumeAgentTask');
    expect(apiSource).toContain('export function repeatAgentTask');
    expect(oscarSource).toContain("missionActionButton(task.id, 'repeat', 'Повторить')");
    expect(oscarSource).toContain('canonicalProposalHash: approval.canonicalProposalHash');
    expect(oscarSource).toContain('Подтвердить точное действие');
    expect(styles).toContain('.oscar-missions-panel');
    expect(styles).toContain('backdrop-filter: blur(26px)');
  });

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

  it('persists cross-chat memory through durable settings and labels retrieved provenance quietly', () => {
    expect(indexSource).toContain('id="memory-cross-chat-enabled"');
    expect(settingsSource).toContain("writeLocalSettings('memory.cross-chat.set'");
    expect(settingsSource).toContain("readLocalSettings('memory')");
    expect(oscarSource).toContain("writeLocalSettings('memory.create'");
    expect(oscarSource).not.toContain("capability: 'oscar.memory.manage'");
    expect(utilsSource).toContain('data-source-open-memory');
    expect(settingsStyles).toContain('.source-chip.is-memory');
    expect(settingsStyles).toContain('.memory-cross-chat-card');
  });

  it('lets an owner review and forget what Oscar captured automatically from past turns', () => {
    // The explicit "Долговременная память" list already had full CRUD; the
    // automatic side (episodes/capsules Memory V4 captures on its own) had
    // none -- no way to see or delete what a chat left behind after it was
    // deleted, only to be told a reply used it.
    expect(indexSource).toContain('id="memory-derived-list"');
    expect(indexSource).toContain('id="memory-derived-forget-all"');
    expect(settingsSource).toContain("runCapability('oscar', 'oscar.memory.derived.manage', { action: 'list' }");
    expect(settingsSource).toContain("action: 'forget_episode'");
    expect(settingsSource).toContain("action: 'forget_capsule'");
    expect(settingsSource).toContain("action: 'forget_all'");
    expect(settingsSource).toContain('async function loadDerivedMemory');
  });

  it('makes the "Учтена память"/"Из памяти" chip a real control instead of a dead label', () => {
    // Regression: this chip used to be a plain <span> with only a tooltip --
    // clickable nowhere, so an owner could never see or manage what got recalled.
    expect(utilsSource).toContain('<button type="button" class="source-chip is-memory" data-source-open-memory');
    expect(utilsSource).not.toMatch(/<span class="source-chip is-memory">Учтена память<\/span>/);
    expect(oscarSource).toContain("event.target.closest('[data-source-open-memory]')");
    expect(oscarSource).toContain('function openMemorySettingsFromSource');
    expect(oscarSource).toContain('data-scroll-target="settings-section"][data-settings-open="memory"]');
  });

  it('renders the answer style as one form of three-position choices with a real preview', () => {
    expect(indexSource).toContain('data-settings-panel="style"');
    expect(indexSource).toContain('id="personality-enabled"');
    expect(indexSource).toContain('data-style-dimension="brevity" data-style-value="85"');
    expect(indexSource).toContain('id="style-rules"');
    expect(indexSource).toContain('id="personality-preview-button"');
    // The old three-variant generator is gone from the page.
    expect(indexSource).not.toContain('id="personality-profile-list"');
    expect(indexSource).not.toContain('id="personality-generate"');
    expect(settingsSource).toContain("writeLocalSettings('personality.style.set'");
    expect(apiSource).toContain('export async function previewPersonality');
  });

  it('resets document feeds and transient overlays when the user changes views', () => {
    expect(appSource).toContain('resetViewScroll(target);');
    expect(appSource).toContain("target.querySelectorAll('.document-feed')");
    expect(appSource).toContain('hideSafeLaunchFeedback();');
    expect(appSource).toContain('closeComposerOptions();');
  });

  it('keeps attachments under plus and model, depth, MAX and Internet in the composer itself', () => {
    const plusMenuStart = indexSource.indexOf('id="oscar-composer-menu-popover"');
    const plusMenu = indexSource.slice(plusMenuStart, indexSource.indexOf('</details>', plusMenuStart));
    const intelligenceStart = indexSource.indexOf('id="oscar-model-popover"');
    const intelligencePanel = indexSource.slice(intelligenceStart, indexSource.indexOf('id="oscar-voice-input"', intelligenceStart));
    expect(indexSource).toContain('id="oscar-composer-menu"');
    expect(indexSource).toContain('data-oscar-attach-photo');
    // Owner UX rule: no switch in the + menu hides the model chip or Internet.
    expect(indexSource).not.toContain('id="oscar-intelligence-toggle"');
    expect(plusMenu).not.toContain('id="oscar-web-toggle"');
    expect(plusMenu).not.toContain('id="oscar-context-meter-toggle"');
    expect(indexSource).toContain('class="composer-web-chip" type="button" id="oscar-web-toggle"');
    expect(indexSource).toContain('<div class="custom-dropdown oscar-inline-model" id="oscar-model-dropdown-container">');
    // Attachments are tiles; tools are rows; autonomy is one segmented choice.
    expect(plusMenu).toContain('class="omenu-tiles" id="oscar-composer-attachments"');
    expect(plusMenu).toContain('class="omenu-list" id="oscar-composer-tools"');
    expect(astraNativeSource).toContain("'#oscar-composer-attachments' : '#oscar-composer-tools'");
    // Model menu: where Oscar works (this computer or MAX), then that side's list.
    expect(intelligencePanel).toContain('data-oscar-source="local"');
    expect(intelligencePanel).toContain('data-oscar-source="max" data-astra-max-open');
    expect(intelligencePanel).toContain('data-panel="local"');
    expect(intelligencePanel).toContain('data-panel="max"');
    expect(intelligencePanel).toContain('data-max-choices');
    expect(intelligencePanel).toContain('data-effort="high"');
    expect(intelligencePanel).toContain('data-value="none"');
    expect(intelligencePanel).toContain('data-value="gemma4-fast"');
    expect(intelligencePanel).toContain('data-value="gemma4-balanced"');
    expect(intelligencePanel).toContain('data-value="qwen3.8-27b-pro"');
    expect(intelligencePanel).not.toContain('data-value="gemma4-deepthinking"');
    expect(intelligencePanel).not.toContain('data-value="gemma4-31b"');
    expect(intelligencePanel).not.toContain('id="oscar-reasoning-dropdown-container"');
    expect(intelligencePanel).not.toContain('type="range"');
    expect(indexSource).not.toContain('id="reasoning-dropdown-container"');
    expect(appSource).not.toContain('deepThinking');
    expect(oscarSource).toContain('resolveModelReasoningEffort(requestedModel, state.oscar.reasoningEffort)');
    expect(oscarSource).toContain("outcome === 'waiting-for-runtime'");
    expect(oscarSource).toContain("setMascotState('idle', { detail: 'Задача ждёт восстановления модели или инструмента' })");
    expect(chatSource).toContain('resolveModelReasoningEffort(modelOverride)');
    expect(intelligencePanel).toContain('id="oscar-research-control"');
    expect(intelligencePanel).toContain('id="oscar-effort-control"');
    expect(plusMenu).not.toContain('id="oscar-research-control"');
    expect(indexSource.indexOf('id="oscar-model-dropdown-container"'))
      .toBeLessThan(indexSource.indexOf('id="oscar-voice-input"'));
    expect(appSource).toContain('!popover.contains(activePopover)');
    expect(appSource).toContain("item.closest('.dropdown-popover') !== popover");
    // Choosing a model is a choice, not a toggle: Auto stays Auto, the menu closes.
    expect(appSource).not.toContain('lastManualModelSelection');
    expect(appSource).toContain('closeDropdown(oscarModelPopover);');
    expect(styles).toContain('.oscar-inline-model > .mode-chip[data-model-power="max"]');
    expect(appSource).toContain("modelButton.dataset.modelPower = modelValue === 'qwen3.8-27b-pro' ? 'max' : 'standard'");
    // One owner for the height when the side changes; reduced motion respected.
    expect(maxSetupSource).toContain("stage.animate([{ height: from + 'px' }, { height: to + 'px' }]");
    expect(maxSetupSource).toContain('reducedUiMotion.matches !== true');
    expect(menuStyles).toContain('#oscar-model-popover[data-source="max"] .omenu-source-thumb { transform: translateX(100%); }');
    expect(menuStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('#oscar-composer.context-meter-enabled .composer-input-row');
  });

  it('renders an actionable RAM warning through the stylesheet used by the live shell', () => {
    expect(indexSource).toContain('data-ram-warning-title');
    expect(indexSource).toContain('data-oscar-ram-action="use-balanced"');
    expect(indexSource).toContain('data-oscar-ram-action="refresh"');
    expect(oscarSource).toContain("buildOscarRamNotice({");
    expect(appSource).toContain("state.oscar.modelSelection = 'gemma4-balanced'");
    expect(appSource).toContain('loadOscarStatus(render).finally');
    expect(styles).toContain('.ram-pressure-warning { display:grid; grid-template-columns:max-content minmax(0,1fr) auto;');
    expect(styles).toContain('.ram-pressure-actions button {');
    expect(styles).toContain('@media (max-width:760px) { .ram-pressure-warning { grid-template-columns:1fr; }');
  });

  it('shows a truthful context-window meter in the composer', () => {
    expect(indexSource).not.toContain('id="oscar-context-meter-toggle"');
    expect(indexSource).toContain('id="oscar-context-meter" role="progressbar"');
    expect(indexSource).toContain('data-context-meter-percent');
    expect(oscarSource).toContain("readOscarModelStatus(state.oscar)?.last_context_window");
    expect(oscarSource).toContain('captureContextForConversation: conversationId');
    expect(appSource).toContain('state.oscar?.contextWindows?.[conversationId]');
    expect(contextMeterSource).toContain('contextWindow?.input_tokens');
    expect(contextMeterSource).toContain('contextWindow?.context_tokens');
    expect(appSource).toContain("meter.setAttribute('aria-valuenow', String(percent))");
    expect(styles).toContain('.oscar-context-tooltip');
  });

  it('keeps the Chat and Coder mode switch explicit and animates its active indicator', () => {
    expect(indexSource).toContain('data-active-mode="chat"');
    expect(indexSource).toContain('id="chat-mode-coder" type="button" role="tab" aria-selected="false">Coder</button>');
    expect(indexSource).toContain('href="/oscar-mode-switch.css"');
    expect(coderSource).toContain("setAttribute('data-active-mode', active ? 'coder' : 'chat')");
    expect(coderSource).toContain("dispatchEvent(new Event('monarch:mascot-surface-changed'))");
    expect(modeSwitchStyles).toMatch(/\.chat-mode-switch::before\s*\{[^}]*box-sizing:\s*border-box;/s);
    expect(modeSwitchStyles).toContain('.chat-mode-switch[data-active-mode="coder"] { --chat-mode-indicator-x: 100%; }');
    expect(modeSwitchStyles).toContain('transform .42s cubic-bezier(.22, 1, .36, 1)');
    expect(modeSwitchStyles).toContain('#oscar-section.coder-mode-active .chat-mode-switch { justify-self: end; }');
    expect(coderStyles).toMatch(/#oscar-section\.coder-mode-active \.oscar-topbar\s*\{[^}]*display:\s*grid !important;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;[^}]*z-index:\s*40;[^}]*visibility:\s*visible;/s);
    expect(coderStyles).toContain('.app-shell.coder-workspace-active #inspector');
    expect(appSource).toContain("const coderActive = shell?.classList.contains('coder-workspace-active') === true;");
    expect(appSource).toContain("const surfaceVisible = !coderActive && (emptyHome || (dialogActive && !isCollapsed));");
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
    expect(indexSource).toContain('id="oscar-research-control"');
    expect(indexSource).toContain('data-research="deep"');
    expect(appSource).toContain("state.oscar.researchMode = oscarResearchChoice.getAttribute('data-research') || 'auto'");
    expect(oscarSource).toContain("let researchMode = ['auto', 'off', 'deep'].includes(state.oscar.researchMode)");
    expect(oscarSource).toContain('const proposal = await createOscarDataEgressConsent(consentRequest, {');
    expect(oscarSource).toContain('clientRequestId: submissionState.dataEgressConsentClientRequestId,');
    expect(oscarSource).toContain('signal: submissionSignal,');
    expect(oscarSource).toContain('await decideOscarDataEgressConsent(');
    expect(styles).toContain('.oscar-live-stage[data-phase^="research-"]');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('replaces generic thinking dots with the Monarch-adapted ThinkingOrb states', () => {
    expect(utilsSource).toContain('renderMonarchThinkingOrb(status.visualPhase, status.motion)');
    expect(utilsSource).not.toContain('class="oscar-thinking-dots"');
    expect(styles).toContain('MIT-derived motion primitive: @illuma-ai/icons ThinkingOrb 2.7.0');
    expect(styles).toContain('.monarch-thinking-orb[data-orb-phase="research-search"]');
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.monarch-thinking-orb__core/);
  });

  it('renders ordinary thinking as a compact truthful status beside the orb', () => {
    expect(utilsSource).toContain('class="oscar-message assistant pending thinking-only"');
    expect(utilsSource).toContain('class="oscar-live-stage"');
    expect(utilsSource).toContain('class="oscar-live-copy"');
    expect(utilsSource).toContain('data-motion="${escapeHtml(status.motion)}"');
    expect(styles).toContain('.oscar-live-copy strong');
    expect(styles).toMatch(/\.oscar-thinking-only\s*\{[^}]*display:\s*inline-grid;[^}]*align-items:\s*center;/s);
  });

  it('treats the Internet switch as the consent and asks no second question', () => {
    // Owner decision 2026-09-23: the globe is the consent. The per-turn egress
    // record is still created and granted, bound to this exact request.
    expect(oscarSource).toContain("if (!continuation && webAllowed && (webSearch || researchMode === 'deep')) {");
    expect(oscarSource).toContain("await decideOscarDataEgressConsent(consent.id, 'grant', consent.canonicalBindingHash, { signal: submissionSignal });");
    expect(oscarSource).not.toContain('requestOscarRouteConsent');
    expect(utilsSource).not.toContain('data-oscar-route-decision');
    expect(styles).not.toContain('.oscar-inline-consent');
    expect(readSource('src/ui/public/oscar-research.css')).toContain('.oscar-research-trace');
  });

  it('pins the fullscreen Voice surface after focus and phase changes', () => {
    expect(voiceModeSource).toContain('keepSurfaceAtOrigin();');
    expect(voiceModeSource).toContain('surface.scrollTop = 0;');
    expect(styles).toMatch(/\.oscar-voice-mode\s*\{[^}]*height:\s*calc\(100dvh - var\(--desktop-titlebar-height, 0px\)\);[^}]*max-height:\s*calc\(100dvh - var\(--desktop-titlebar-height, 0px\)\);/s);
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

  it('restores the exact durable Desktop Turn after renderer reload without creating a successor', () => {
    expect(oscarSource).toContain("const OSCAR_ACTIVE_SESSION_KEY = 'monarch.oscar.active-session.v1'");
    expect(oscarSource).toContain('rememberActiveOscarSession({ conversationId, turnId, clientRequestId, text })');
    expect(oscarSource).toContain('window.localStorage.setItem(OSCAR_ACTIVE_SESSION_KEY');
    expect(oscarSource).toContain('readStoredOscarSession(window.sessionStorage)');
    expect(oscarSource).toContain('|| readStoredOscarSession(window.localStorage)');
    expect(oscarSource).toContain('window.localStorage.removeItem(OSCAR_ACTIVE_SESSION_KEY)');
    expect(oscarSource).toContain('// raw user text stays session-only and is recovered from the Turn Store.');
    expect(oscarSource).toContain('fetchOscarTurnByClientRequestId(saved.clientRequestId');
    expect(oscarSource).toContain('? await fetchOscarTurn(saved.turnId)');
    expect(oscarSource).toContain('await consumeOscarTurn({');
    expect(oscarSource).toContain('turnId: turn.id');
    const restoreStart = oscarSource.indexOf('async function restoreActiveOscarSession()');
    const restoreEnd = oscarSource.indexOf('async function openOscarConversation', restoreStart);
    expect(restoreStart).toBeGreaterThan(-1);
    expect(oscarSource.slice(restoreStart, restoreEnd)).not.toContain('createOscarTurn(');
  });

  it('never clears busy state while the current assistant message is still pending', () => {
    expect(oscarSource).toContain('async function settlePendingOscarTurnFromDurableState');
    const submitStart = oscarSource.indexOf('async function submitOscarMessage');
    const submitEnd = oscarSource.indexOf('async function executeOscarCapabilityAction', submitStart);
    const submitSource = oscarSource.slice(submitStart, submitEnd);
    expect(submitSource).toContain('if (oscarPendingMessageExists(pendingMessage.id))');
    expect(submitSource.indexOf('await settlePendingOscarTurnFromDurableState'))
      .toBeLessThan(submitSource.lastIndexOf('setOscarBusy(false)'));
    expect(submitSource).toContain('Oscar завершил обработку без отображаемого результата');
  });

  it('keeps history rename and delete actions explicitly named', () => {
    expect(oscarSource).toContain('aria-label="${escapeHtml(`Переименовать чат: ${title}`)}" title="Переименовать"');
    expect(oscarSource).toContain('aria-label="${escapeHtml(`Удалить чат: ${title}`)}" title="Удалить"');
    expect(oscarSource).toContain('data-conversation-encrypt="${escapeHtml(conversation.id)}"');
    expect(oscarSource).toContain('async function clearOscarHistory()');
    expect(oscarSource).toContain("{ action: 'clear' }");
    expect(indexSource).toContain('id="oscar-history-clear"');
    expect(styles).toContain('.sidebar-icon-btn-danger');
  });

  it('uses the lightweight hooded line icon for incognito and keeps logo corners rounded', () => {
    expect(indexSource).toContain('src="/assets/brand/monarch-incognito-hooded.png"');
    expect(styles).toContain('.oscar-incognito-icon');
  });

  it('moves encrypted chats into Monarch Safe and keeps their model turns incognito to SQLite', () => {
    expect(indexSource).toContain('id="oscar-safe-encrypt"');
    expect(oscarSource).toContain("? 'encrypted'");
    expect(oscarSource).toContain("state.oscar.incognito ? 'incognito' : 'persistent'");
    expect(oscarSource).toContain("await bridge.writeSafeChat(record)");
    expect(oscarSource).toContain("action: 'delete', id: conversationId");
    expect(oscarSource).toContain("if (stored?.verified !== true)");
    expect(oscarSource).toContain('sealActiveEncryptedConversation');
    expect(styles).toContain('.conversation-item.is-encrypted');
  });

  it('moves finished Coder conversations into the same Safe chat boundary', () => {
    expect(coderSource).toContain("kind: 'coder'");
    expect(coderSource).toContain('await bridge.writeSafeChat');
    expect(coderSource).toContain('await deleteCoderRun(run.id)');
    expect(coderSource).toContain("await bridge.deleteSafeChat(run.id, 'coder')");
    expect(coderSource).toContain("if (stored?.verified !== true) throw new Error('Safe не подтвердил запись разговора.')");
    expect(coderViewSource).toContain('data-cdr="safe-move"');
  });

  it('releases the idle neural voice model before a local Coder task starts', () => {
    const release = coderSource.indexOf('await window.monarchDesktop.releaseSpeechOutput()');
    expect(coderSource).toContain("typeof window.monarchDesktop?.releaseSpeechOutput === 'function'");
    expect(release).toBeGreaterThan(-1);
    expect(release).toBeLessThan(coderSource.indexOf('payload = await startCoderRun('));
  });

  it('releases the idle neural voice model before a desktop Oscar model route starts', () => {
    expect(oscarSource).toContain('oscarSpeechController?.releaseForInference');
    expect(oscarSource).toContain('await oscarSpeechController.releaseForInference()');
    expect(oscarSource.indexOf('await oscarSpeechController.releaseForInference()'))
      .toBeLessThan(oscarSource.indexOf('const created = astraContinuation'));
    expect(oscarSource).not.toContain('oscarSpeechController.prewarm()');
    expect(oscarSource).not.toContain('oscarSpeechController?.restoreAfterInference()');
  });

  it('continues conversations on their own model and follows runs live instead of polling', () => {
    expect(coderSource).toContain('request.sessionId || undefined');
    expect(coderSource).toContain('function adoptSessionModel()');
    expect(coderSource).toContain('streamCoderRun(runId, { signal: controller.signal })');
    expect(coderSource).not.toContain('setTimeout(poll');
    expect(apiSource).toContain('/stream`');
    expect(coderSource).toContain("if (!(error instanceof TypeError)) throw error;");
  });

  it('keeps exact approvals, questions and Stop inside the active conversation', () => {
    expect(coderSource).toContain('await armAgentTaskApproval(run.agentTaskId, approval.id, binding)');
    expect(coderSource).toContain('canonicalProposalHash: String(approval.canonicalProposalHash');
    expect(coderSource).toContain('await submitCoderReply(runId, question.id, question.digest, reply)');
    expect(coderSource).toContain('new TextEncoder().encode(reply).byteLength > 4096');
    expect(coderSource).toContain("ui.stop.disabled = Boolean(active?.cancelled) || state.stopping === active?.id;");
  });

  it('lays out conversations, thread and review with reduced motion and a narrow fallback', () => {
    expect(coderStyles).toContain('container-type: inline-size');
    expect(coderStyles).toContain('@container (max-width: 640px)');
    expect(coderStyles).toContain('prefers-reduced-motion: reduce');
    expect(coderStyles).toContain('html:root[data-design="pp"]');
    expect(coderSource).toContain('const overlayReview = width < 980;');
  });

  it('keeps large conversation histories searchable without a second backend request', () => {
    expect(indexSource).toContain('id="oscar-history-search"');
    expect(indexSource).toContain('aria-label="Поиск по истории чатов"');
    expect(oscarSource).toContain("elements.oscarHistorySearch?.addEventListener('input', () => renderConversationList())");
    expect(oscarSource).toContain("listState.kind === 'no-results'");
    expect(oscarSource).toContain('Совпадений нет');
  });

  it('renders effectful success only from a kernel-verified Turn outcome', () => {
    expect(oscarSource).toContain("case 'turn.outcome':");
    expect(oscarSource).toContain("outcome === 'verified'");
    expect(oscarSource).toContain("? 'kernel-verified'");
    expect(oscarSource).toContain("outcome === 'partial' ? 'kernel-partial'");
    expect(oscarSource).not.toContain('queueDispatchedConversationPersistence(text, content, true)');
    expect(oscarSource).not.toContain('function handleTypedActionPlan(');
    expect(oscarSource).not.toContain('function confirmDispatchedAction(');
    expect(oscarSource).not.toContain("options.visibleAnswer || ''");
    expect(oscarSource).not.toContain('visibleAnswer: activation.content');
    expect(oscarSource).not.toContain('visibleAnswer: fallbackParser.getContent(true)');
  });

  it('shows automatic model installation and keeps chat blocked until verification succeeds', () => {
    expect(apiSource).toContain('export async function ensureRequiredComponents');
    expect(appSource).toContain('scheduleComponentStateRefresh(state.data?.components);');
    expect(modelManagerSource).toContain('data-component-ensure');
    expect(oscarSource).toContain('requiredModelBlocksChat()');
    expect(oscarSource).toContain('Monarch устанавливает и проверяет обязательную модель');
    expect(styles).toContain('.model-component-state progress::-webkit-progress-value');
  });

  it('renders every runtime module without the removed Projects workspace UI', () => {
    expect(modelManagerSource).toContain('modules.map((record) =>');
    expect(modelManagerSource).not.toContain('modules.slice(0, 14)');
    expect(modelManagerSource).toContain('module-row');
    expect(modelManagerSource).not.toContain('workspace-module-card');
    expect(styles).not.toContain('.workspace-module-card');
  });
});
