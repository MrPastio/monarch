import { createHmac, randomUUID } from 'node:crypto';
import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AstraJournal } from '../agent-v3/journal';
import type { AstraComputerAction } from '../agent-v3/computer-action-work-adapter';
import type { OscarTurnCoordinator } from '../oscar-turn/coordinator';
import type { AstraAuthenticatedHttpActor, MonarchAstraTaskFacade } from './astra-task-facade';
import type { MonarchKernel } from '../core/kernel';
import type { ComputerModule } from '../modules/computer';
import type { AstraComputerSelectionStore } from './astra-computer-selection-store';
import type { AstraComputerActionPlanStore } from './astra-computer-action-plan-store';
import { AstraComputerPicker } from './astra-computer-picker';
import type { AstraTargetSelectionStore } from './astra-target-selection-store';
import { AstraTargetPicker } from './astra-target-picker';
import { AstraDesktopStateStore } from './astra-desktop-state';
import { AstraDesktopConversations } from './astra-desktop-conversations';
// @ts-expect-error Electron adapters remain standalone ESM, no production eager import.
import { createAstraTargetDialog, registerAstraTargetPickerIpc, acquireAstraRendererGuard } from '../../desktop/electron/astra-target-dialog.mjs';
// @ts-expect-error Native Electron dialog is a standalone ESM adapter.
import { createAstraComputerDialog } from '../../desktop/electron/astra-computer-dialog.mjs';

/** Attach ONLY to an explicitly assembled isolated host. Does not create/start
 * Application, Kernel, scheduler, SQLite file, HTTP server or Electron window.
 * Closing the renderer does NOT cancel a durable task owned by the existing host. */
export function attachAstraDesktopHost(options: { deployment: 'isolated-validation'; scopeId: string; canonicalRoot: string;
  journal: AstraJournal; selections: AstraTargetSelectionStore; coordinator: OscarTurnCoordinator;
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>; window: BrowserWindow; dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  origin: string; actor: AstraAuthenticatedHttpActor; conversationId: string; desktopAttestationToken: string;
  /** Capability advertised by the attached facade, not a renderer-issued grant. */
  referenceInputs?: boolean;
  computer?: { selections: AstraComputerSelectionStore; actionPlans?: AstraComputerActionPlanStore;
    facade: MonarchAstraTaskFacade; kernel: MonarchKernel; module: ComputerModule; dialog: Pick<Dialog, 'showMessageBox'> };
  conversations?: { maxConversations?: number;
    readHistory(conversationId: string, options: { messageLimit: number; before?: number }): Promise<unknown> } }) {
  if (options.deployment !== 'isolated-validation' || new URL(options.origin).origin !== options.origin
    || new URL(options.origin).protocol !== 'http:' || new URL(options.origin).hostname !== '127.0.0.1'
    || options.actor.source !== 'desktop' || options.actor.id !== 'sha256:' + createHmac('sha256', options.desktopAttestationToken)
      .update('monarch.astra-v3.http-actor.v1/desktop').digest('hex')) throw Error('astra-desktop:isolated-principal-required');
  options.selections.assertCanonicalRoot(options.canonicalRoot);
  if (options.computer && (!options.computer.selections.usesJournal(options.journal)
    || !options.computer.facade.matchesComputerHost(options.computer.selections, options.journal, options.computer.kernel)
    || options.computer.kernel.getModule('computer') !== options.computer.module))
    throw Error('astra-desktop:computer-host-mismatch');
  if (options.computer?.actionPlans && (!options.computer.actionPlans.usesJournal(options.journal)
    || !options.computer.facade.matchesComputerActionHost(options.computer.actionPlans, options.journal, options.computer.kernel)))
    throw Error('astra-desktop:computer-action-host-mismatch');
  const actor = structuredClone(options.actor);
  const directory = options.conversations ? new AstraDesktopConversations({ deployment: options.deployment, scopeId: options.scopeId,
    canonicalRoot: options.canonicalRoot, journal: options.journal, actor, initialConversationId: options.conversationId,
    getTurn: id => options.coordinator.getTurn(id),
    ...(options.conversations.maxConversations === undefined ? {} : { maxConversations: options.conversations.maxConversations }) }) : null;
  const fixedState = directory ? null : new AstraDesktopStateStore({ deployment: options.deployment, scopeId: options.scopeId,
    journal: options.journal, actor, conversationId: options.conversationId, getTurn: id => options.coordinator.getTurn(id) });
  const state = () => directory ? directory.pointer() : fixedState!;
  const session = randomUUID().replace(/-/g, '');
  let disposed = false, epoch = 1;
  let computerPicker: AstraComputerPicker | undefined;
  const assertActive = () => { if (disposed || options.window.isDestroyed()) throw Error('astra-desktop:closed'); };
  const source = () => { assertActive(); const current = directory?.read();
    return { conversationId: current?.activeConversationId ?? options.conversationId, epoch: `source_${session}_${epoch}_${current?.revision ?? 0}` }; };
  const assertSource = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['conversationId', 'epoch'].includes(key))
      || (value as { conversationId: string }).conversationId !== source().conversationId
      || (value as { epoch: string }).epoch !== source().epoch) throw Error('astra-desktop:source-changed');
  };
  const bootstrap = () => ({ deployment: options.deployment, conversationId: source().conversationId, surface: state().read(),
    ...(computerPicker ? { computerObservation: true, computerSource: source(),
      ...(options.computer?.actionPlans ? { computerActions: true } : {}) } : {}),
    ...(options.referenceInputs === true ? { referenceInputs: true } : {}),
    ...(directory ? { source: source(), conversations: directory.read().conversations.map((entry, index) => ({ id: entry.conversationId, label: `Разговор ${index + 1}` })) } : {}) });
  const onNavigation = (details: { isMainFrame?: boolean }) => { if (details.isMainFrame !== false) { epoch++; computerPicker?.cancel(); } };
  const disposers: Array<() => void> = [];
  const picker = new AstraTargetPicker({ deployment: options.deployment, canonicalRoot: options.canonicalRoot, store: options.selections,
    currentSource: () => ({ actor, ...source() }),
    choose: createAstraTargetDialog({ deployment: options.deployment, dialog: options.dialog, window: options.window, assertWindow: assertActive }),
    ttlMs: 3600000, maxReadBytes: 65536, maxCreateBytes: 16384, timeoutMs: 5000 });
  function dispose() { if (disposed) return; disposed = true; for (const close of disposers.reverse()) close(); }
  function register(channel: string, run: (value: unknown, assertRenderer: () => void) => unknown) {
    options.ipcMain.handle(channel, async (event: IpcMainInvokeEvent, value: unknown) => {
      const guard = acquireAstraRendererGuard({ window: options.window, origin: options.origin, event, assertTrustedRenderer: assertActive,
        isActive: () => !disposed });
      try { const result = await run(value, guard.assert); guard.assert(); return result; } finally { guard.dispose(); }
    });
    disposers.push(() => options.ipcMain.removeHandler(channel));
  }
  try {
    if (options.computer) {
      const selected = options.computer.selections;
      computerPicker = new AstraComputerPicker({ deployment: options.deployment, store: selected, kernel: options.computer.kernel,
        currentSource: () => ({ actor, ...source() }),
        choose: createAstraComputerDialog({ deployment: options.deployment, dialog: options.computer.dialog, window: options.window, assertWindow: assertActive }) });
      disposers.push(() => computerPicker!.dispose());
      register('monarch:astra-pick-window', (value, assertRenderer) => {
        const request = sourceRequest(value, ['version', 'requestId', 'source']);
        const assertCurrent = () => { assertRenderer(); assertSource(request.source); }; assertCurrent();
        return computerPicker!.pick({ version: request.version, requestId: request.requestId }, assertCurrent);
      });
      register('monarch:astra-window-selections', (value, assertRenderer) => {
        const request = sourceRequest(value, ['version', 'kind', 'selectionId', 'source']);
        assertRenderer(); assertSource(request.source); const principal = { actor, conversationId: source().conversationId };
        if (request.kind === 'list' && Object.keys(request).length === 3) return selected.list(principal);
        if (request.kind === 'revoke' && Object.keys(request).length === 4 && typeof request.selectionId === 'string') {
          selected.revoke(request.selectionId, principal); options.computer!.facade.notifySourceChange(); return { revoked: true };
        }
        throw Error('astra-desktop:window-selection-request');
      });
      if (options.computer.actionPlans) {
        const plans = options.computer.actionPlans;
        register('monarch:astra-issue-computer-action', async (value, assertRenderer) => {
          const request = sourceRequest(value, ['version', 'requestId', 'taskId', 'action', 'source']);
          const assertCurrent = () => { assertRenderer(); assertSource(request.source); }; assertCurrent();
          if (typeof request.requestId !== 'string' || typeof request.taskId !== 'string') throw Error('astra-desktop:computer-action-request');
          await options.coordinator.flushOutbox(); assertCurrent();
          const seed = options.computer!.facade.computerActionSeed(actor, source().conversationId, request.taskId);
          if (!options.computer!.module.hasFreshObservation(seed.observation)) throw Error('astra-desktop:computer-observation-not-fresh');
          return plans.issue({ actor, conversationId: source().conversationId, requestId: request.requestId,
            source: seed.source, observation: seed.observation, action: request.action as AstraComputerAction, ttlMs: 90_000, timeoutMs: 5000 },
          () => { assertCurrent(); return true; });
        });
        register('monarch:astra-computer-action-plans', (value, assertRenderer) => {
          const request = sourceRequest(value, ['version', 'kind', 'selectionId', 'source']);
          assertRenderer(); assertSource(request.source); const principal = { actor, conversationId: source().conversationId };
          if (request.kind === 'list' && Object.keys(request).length === 3) return plans.list(principal);
          if (request.kind === 'revoke' && Object.keys(request).length === 4 && typeof request.selectionId === 'string') {
            plans.revoke(request.selectionId, principal); options.computer!.facade.notifySourceChange(); return { revoked: true };
          }
          throw Error('astra-desktop:computer-action-plan-request');
        });
      }
    }
    options.window.webContents.on('did-start-navigation', onNavigation);
    disposers.push(() => options.window.webContents.removeListener('did-start-navigation', onNavigation));
    if (directory) register('monarch:astra-pick-target', (value, assertRenderer) => {
      const request = sourceRequest(value, ['version', 'requestId', 'access', 'source']);
      const { source: expectedSource, ...choice } = request;
      const assertCurrent = () => { assertRenderer(); assertSource(expectedSource); };
      assertCurrent(); return picker.pick(choice, assertCurrent);
    });
    else disposers.push(registerAstraTargetPickerIpc({ deployment: options.deployment, ipcMain: options.ipcMain, picker,
      window: options.window, origin: options.origin, assertTrustedRenderer: assertActive }));
    register('monarch:astra-desktop-attestation', () => options.desktopAttestationToken);
    register('monarch:astra-desktop-bootstrap', bootstrap);
    register('monarch:astra-desktop-state', (value, assertRenderer) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'kind', 'id', ...(directory ? ['source'] : [])].includes(key)))
        throw Error('astra-desktop:state-request');
      const command = value as { version: number; kind: string; id: string; source?: unknown };
      if (command.version !== 1 || typeof command.id !== 'string') throw Error('astra-desktop:state-request');
      const assertCurrent = () => { assertRenderer(); if (directory) assertSource(command.source); }; assertCurrent();
      if (command.kind === 'pending') return state().pending(command.id, assertCurrent);
      if (command.kind === 'linked') return state().linked(command.id, assertCurrent);
      if (command.kind === 'clear') return state().clear(command.id);
      throw Error('astra-desktop:state-request');
    });
    if (directory) register('monarch:astra-conversations', async (value, assertRenderer) => {
      const request = sourceRequest(value, ['version', 'kind', 'source', 'requestId', 'conversationId', 'before']);
      const assertCurrent = () => { assertRenderer(); assertSource(request.source); }; assertCurrent();
      if (request.kind === 'create' && typeof request.requestId === 'string'
        && request.conversationId === undefined && request.before === undefined) {
        directory.create(request.requestId, directory.read().revision); computerPicker?.cancel(); return bootstrap();
      }
      if (request.kind === 'select' && typeof request.conversationId === 'string'
        && request.requestId === undefined && request.before === undefined) {
        directory.select(request.conversationId, directory.read().revision); computerPicker?.cancel(); return bootstrap();
      }
      if (request.kind === 'history' && request.requestId === undefined && request.conversationId === undefined) {
        if (request.before !== undefined && (!Number.isSafeInteger(request.before) || Number(request.before) < 1)) throw Error('astra-desktop:history-cursor');
        const conversationId = source().conversationId;
        const raw = await options.conversations!.readHistory(conversationId, { messageLimit: 4,
          ...(request.before === undefined ? {} : { before: Number(request.before) }) });
        assertCurrent(); const page = await historyPage(raw, conversationId); assertCurrent(); return page;
      }
      throw Error('astra-desktop:conversation-request');
    });
  } catch (error) { dispose(); throw error; }
  function sourceRequest(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
      || (value as { version: unknown }).version !== 1) throw Error('astra-desktop:source-request');
    return value as Record<string, unknown>;
  }
  async function historyPage(raw: unknown, conversationId: string) {
    // Explicit absence is not proof of an empty/delivered history. Keep the task
    // pointer intact and let the UI show unavailable storage separately.
    if (raw === null) return { conversationId, availability: 'not-found', messages: [], hasMore: false, before: null };
    const data = raw as { id: string; messages: Array<Record<string, unknown>>; message_page: { has_more: boolean; next_before: number | null } };
    if (!data || data.id !== conversationId || !Array.isArray(data.messages) || data.messages.length > 4
      || !data.message_page || typeof data.message_page.has_more !== 'boolean'
      || (data.message_page.has_more ? !Number.isSafeInteger(data.message_page.next_before) || Number(data.message_page.next_before) < 1 : data.message_page.next_before !== null))
      throw Error('astra-desktop:history-page');
    const messages = await Promise.all(data.messages.map(async row => {
      if (!row || typeof row.client_message_id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(row.client_message_id)
        || typeof row.turn_id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(row.turn_id)
        || !['user', 'assistant'].includes(String(row.role)) || typeof row.content !== 'string' || [...row.content].length > 20000
        || (row.causal_parent_id !== null && (typeof row.causal_parent_id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(row.causal_parent_id))))
        throw Error('astra-desktop:history-row');
      const turn = (await options.coordinator.getTurn(row.turn_id))?.turn;
      if (!turn || turn.conversationId !== conversationId || turn.source !== 'desktop' || turn.request.astra?.actor.id !== actor.id
        || turn.request.astra.actor.source !== actor.source) throw Error('astra-desktop:history-owner');
      return { messageId: row.client_message_id, turnId: row.turn_id, role: row.role as string, content: row.content as string,
        causalParentId: row.causal_parent_id as string | null };
    }));
    if (new Set(messages.map(row => row.messageId)).size !== messages.length) throw Error('astra-desktop:history-duplicate');
    return { conversationId, availability: 'available', messages, hasMore: data.message_page.has_more, before: data.message_page.next_before };
  }
  return { get state() { return state(); }, directory, picker, computerPicker, dispose };
}
