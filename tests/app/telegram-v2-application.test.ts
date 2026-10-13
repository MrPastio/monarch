import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MonarchApplication } from '../../src/app/application';
import { TelegramModule } from '../../src/modules/telegram';
import { InMemoryOscarTurnStore, OscarTurnCoordinator, type OscarPersistedMessage } from '../../src/oscar-turn';

it('admits two V2 topics through the real application and Turn coordinator with shared history and exact model identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'telegram-v2-application-'));
  const persisted: OscarPersistedMessage[] = [];
  const turns = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(), volatileStore: new InMemoryOscarTurnStore(),
    answerExecutor: async () => (async function* () { yield { type: 'token' as const, token: 'Synthetic answer' }; yield { type: 'done' as const }; })(),
    persistMessage: async message => { persisted.push(message); },
  });
  const app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['security', 'telegram'],
    oscarTurnCoordinator: turns });
  const reads: string[] = [];
  (app as any).contextClient.getConversation = async (id: string) => {
    reads.push(id); return { id, messages: [{ role: 'user', content: `History of ${id}` }] };
  };
  try {
    await app.start();
    const tg = app.runtime.kernel.getModule('telegram') as TelegramModule;
    tg.v2.configure({ ownerUserId: 7, controlChatId: 7, botId: 123456, pairingEpoch: 'fixture', historyEnabled: true });
    tg.v2.bind(11, 'desktop-a', 'A'); tg.v2.bind(12, 'desktop-b', 'B');
    tg.v2.configureModel('max-gpt-oss-120b', true); tg.v2.selectModel(11, true);
    const contextA = tg.v2.context(7, 7, 11, 1, {}, 'Привет');
    const contextB = tg.v2.context(7, 7, 12, 2, {}, 'Добрый день');
    const a = await (app as any).admitAgentSurfaceIntent({ source: 'telegram', text: 'Привет', context: contextA });
    const b = await (app as any).admitAgentSurfaceIntent({ source: 'telegram', text: 'Добрый день', context: contextB });
    const again = await (app as any).admitAgentSurfaceIntent({ source: 'telegram', text: 'Привет', context: contextA });
    expect(again.checkpoint.turn.id).toBe(a.checkpoint.turn.id);
    expect(a.checkpoint.turn.request.modifiers.requestedModel).toBe('max-gpt-oss-120b');
    expect(b.checkpoint.turn.request.modifiers.requestedModel).toBeUndefined();
    expect(a.checkpoint.turn.request.history).toEqual([{ role: 'user', content: 'History of desktop-a' }]);
    expect(b.checkpoint.turn.request.history).toEqual([{ role: 'user', content: 'History of desktop-b' }]);
    expect(a.checkpoint.turn.request.telegramActor.threadId).toBe(11);
    expect(b.checkpoint.turn.request.telegramActor.threadId).toBe(12);
    expect(reads).toEqual(['desktop-a', 'desktop-b', 'desktop-a']);
    await tg.v2Interface.bridge!.cancel(a.checkpoint.turn.id, 'desktop-a');
    // Completed effects/answers retain their actual outcome when Stop arrives late.
    expect((await turns.getTurn(a.checkpoint.turn.id))?.turn.status).toBe('succeeded');
    expect((await turns.getTurn(b.checkpoint.turn.id))?.turn.status).not.toBe('cancelled');
    expect(persisted.filter(m => m.role === 'user' && m.conversationId === 'desktop-a')).toHaveLength(1);
  } finally { await app.stop(); await turns.stop(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it('delivers an ordinary Telegram answer: the artifact step has nothing to offer instead of rejecting it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'telegram-v2-answer-'));
  const turns = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(), volatileStore: new InMemoryOscarTurnStore(),
    answerExecutor: async () => (async function* () { yield { type: 'token' as const, token: 'Привет из Оскара' }; yield { type: 'done' as const }; })(),
    persistMessage: async () => undefined,
  });
  const app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['security', 'telegram'], oscarTurnCoordinator: turns });
  (app as any).contextClient.getConversation = async (id: string) => ({ id, messages: [] });
  try {
    await app.start();
    const tg = app.runtime.kernel.getModule('telegram') as TelegramModule;
    tg.v2.configure({ ownerUserId: 7, controlChatId: 7, botId: 123456, pairingEpoch: 'fixture', historyEnabled: true });
    tg.v2.bind(0, 'desktop-main', 'Main');
    const context = tg.v2.context(7, 7, 0, 73, {}, 'Привет это тест тг чата');
    const dispatcher = (tg as any).dispatcher;
    const admission = await dispatcher.admit({ text: 'Привет это тест тг чата', context });
    const result = await dispatcher.resume(admission, context);
    expect(result.execution).toMatchObject({ ok: true, summary: 'Привет из Оскара' });
    await expect(dispatcher.listArtifacts(admission, context)).resolves.toEqual([]);
  } finally { await app.stop(); await turns.stop(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it('resolves a Telegram Astra V3 approval without requiring the disabled V2 runtime', async () => {
  const now = new Date().toISOString();
  const approval = {
    id: 'approval_astra_telegram',
    digest: 'sha256:' + 'a'.repeat(64),
    workId: 'work_astra_telegram',
    inputDigest: 'sha256:' + 'b'.repeat(64),
    proposalHash: 'c'.repeat(64),
    policyDecisionHash: 'd'.repeat(64),
    authorityTier: 'owner',
    purpose: 'policy',
    expiresAt: Date.now() + 60_000,
    policySnapshotJson: '{}',
    capability: { id: 'workspace.files.write', moduleId: 'workspace', title: 'Write file', description: '', risk: 'write' },
    args: { path: 'E:\\MonarchRuntimeTests\\telegram-v3.txt', content: 'synthetic' },
    source: {},
    grantScope: 'once',
    nativeCompletionCertified: false,
  } as const;
  const waiting = {
    turn: {
      id: 'turn_astra_telegram', clientRequestId: 'client_astra_telegram', conversationId: 'telegram:7:7',
      source: 'telegram', privacyMode: 'persistent', mode: 'agent', status: 'waiting-for-approval',
      request: { text: 'создай тестовый файл', attachmentIds: [], modifiers: {}, astra: { goal: { kind: 'agent' } } },
      inputMessageId: 'message_astra_telegram', taskId: 'task_astra_telegram', activeApprovalId: approval.id,
      revision: 1, createdAt: now, updatedAt: now,
    },
    events: [],
  } as any;
  const terminal = {
    turn: {
      ...waiting.turn,
      status: 'succeeded',
      outcome: { kind: 'verified', summary: 'Файл создан и проверен.' },
      activeApprovalId: undefined,
      revision: 2,
    },
    events: [],
  } as any;
  const submitAstraInput = vi.fn(async () => waiting);
  const coordinator = {
    findLatestTurn: vi.fn(async () => waiting),
    submitAstraInput,
    flushOutbox: vi.fn(async () => undefined),
    getTurn: vi.fn(async () => terminal),
    subscribe: vi.fn(() => () => undefined),
  };
  const app = Object.create(MonarchApplication.prototype) as any;
  app.ensureStarted = async () => undefined;
  app.getOwnerDevSettings = () => ({ zeroRetentionEnabled: false });
  app.oscarTurnCoordinator = coordinator;
  app.astraProductPilot = { bridge: { find: vi.fn((turn: any) => turn.status === 'waiting-for-approval'
    ? { id: 'task_astra_telegram', status: 'awaiting-approval', approval }
    : { id: 'task_astra_telegram', status: 'completed' }) } };
  const context = { telegramChatId: 7, telegramUserId: 7 };

  const armed = await app.resolveAgentSurfaceApproval({
    text: '', context, approval: { action: 'arm', approvalId: approval.id },
  });
  expect(armed.execution).toMatchObject({
    ok: false,
    error: 'confirmation-required',
    metadata: {
      approvalPresentation: {
        taskId: 'task_astra_telegram',
        approvalId: approval.id,
        capabilityId: 'workspace.files.write',
        canonicalProposalHash: approval.proposalHash,
        target: approval.args.path,
      },
      armExpiresAt: new Date(approval.expiresAt).toISOString(),
    },
  });
  expect(submitAstraInput).not.toHaveBeenCalled();

  const approved = await app.resolveAgentSurfaceApproval({
    text: '', context, approval: { action: 'approve', approvalId: approval.id },
  });
  expect(submitAstraInput).toHaveBeenCalledWith('turn_astra_telegram', 'telegram', {
    kind: 'decide',
    decision: expect.objectContaining({
      approvalId: approval.id,
      approvalDigest: approval.digest,
      decision: 'approve',
    }),
  });
  expect(coordinator.flushOutbox).toHaveBeenCalledTimes(1);
  expect(approved.execution).toMatchObject({ ok: true, summary: 'Файл создан и проверен.' });
});
