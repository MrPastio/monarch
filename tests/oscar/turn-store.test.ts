import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setStoreProtectionForTesting } from '../../src/core/store-protection';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InMemoryOscarTurnStore,
  LocalJsonOscarTurnStore,
  OSCAR_TURN_SCHEMA_VERSION,
  type OscarTurnV1,
} from '../../src/oscar-turn';

interface MutableTurnStoreFixture {
  clientRequests: Record<string, {
    fingerprint: unknown;
    turnId: unknown;
    createdAt: unknown;
  }>;
}

function turn(overrides: Partial<OscarTurnV1> = {}): OscarTurnV1 {
  const now = '2026-08-01T00:00:00.000Z';
  return {
    schemaVersion: OSCAR_TURN_SCHEMA_VERSION,
    id: 'turn_test_1',
    clientRequestId: 'client_test_1',
    conversationId: 'conversation_test_1',
    source: 'desktop',
    privacyMode: 'persistent',
    mode: 'answer',
    status: 'accepted',
    request: {
      text: 'Сколько будет 2+2?',
      attachmentIds: [],
      modifiers: {},
    },
    inputMessageId: 'message_user_1',
    revision: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A damaged store is moved aside byte for byte, nothing in it is used, the
 * move is reported, and the store accepts new work from an empty document. */
async function expectQuarantined<R>(filePath: string, corruptBytes: string,
  call: (store: LocalJsonOscarTurnStore) => Promise<R>, expected: R,
  code: 'invalid-json' | 'invalid-document' = 'invalid-document') {
  const reports: Array<Record<string, string | number>> = [];
  const store = new LocalJsonOscarTurnStore(filePath, undefined, (entry) => { reports.push(entry); });
  await expect(call(store)).resolves.toEqual(expected);
  const names = await readdir(path.dirname(filePath));
  const aside = names.filter((name) => name.startsWith('turns.v1.json.corrupt-'));
  expect(aside).toHaveLength(1);
  await expect(readFile(path.join(path.dirname(filePath), aside[0]!), 'utf8')).resolves.toBe(corruptBytes);
  expect(names).not.toContain('turns.v1.json');
  expect(reports).toEqual([{ diagnostic: 'oscar-turn-store-quarantined', code, file: aside[0] }]);
  await expect(store.createTurn(turn())).resolves.toMatchObject({ turn: { id: 'turn_test_1' } });
}

function ordinaryAgentBinding(selectionId = 'selection_agent') {
  return {
    version: 'astra-oscar-isolated-v1' as const,
    actor: { id: 'sha256:' + 'a'.repeat(64), source: 'desktop' as const },
    selectionId,
    goal: { kind: 'agent' as const, modelMode: 'local' as const },
    admission: 'ordinary-agent-v1' as const,
  };
}

describe.each([
  ['memory', () => new InMemoryOscarTurnStore()],
  ['json', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-turn-store-'));
    return new LocalJsonOscarTurnStore(path.join(root, 'turns.v1.json'));
  }],
])('OscarTurnStore (%s)', (_name, createStore) => {
  it('persists bounded append-only Astra recovery IDs and rejects malformed or reset budgets', async () => {
    const store = await createStore(), base = turn();
    const source: OscarTurnV1 = { ...base, request: { ...base.request, astra: { version: 'astra-oscar-isolated-v1',
      actor: { id: 'sha256:' + 'a'.repeat(64), source: 'desktop' }, selectionId: 'selection', goal: { kind: 'observe', targets: ['selected'] } } },
      astraRecoveryRequests: ['original'] };
    const admitted = await store.createTurn(source);
    for (const requests of [[], ['replacement'], ['original', 'original'], ['original', 'bad/id'],
      Array.from({ length: 9 }, (_, index) => index ? 'request_' + index : 'original')]) {
      await expect(store.saveTurn({ ...admitted.turn, astraRecoveryRequests: requests }, { expectedRevision: admitted.turn.revision })).rejects.toThrow();
    }
    const next = await store.saveTurn({ ...admitted.turn, astraRecoveryRequests: ['original', 'next'] }, { expectedRevision: admitted.turn.revision });
    expect(next.turn.astraRecoveryRequests).toEqual(['original', 'next']);
    await expect(store.createTurn(turn({ id: 'plain_turn', clientRequestId: 'plain_request', astraRecoveryRequests: ['forbidden'] }))).rejects.toThrow();
  });
  it('creates one idempotent turn and rejects client request reuse with different content', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn(), {
      events: [{ type: 'turn.accepted', payload: { source: 'desktop' } }],
    });
    const replayed = await store.createTurn(turn(), {
      events: [{ type: 'turn.accepted', payload: { source: 'desktop' } }],
    });

    expect(created.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.turn.id).toBe(created.turn.id);
    await expect(store.getTurnByClientRequestId(created.turn.clientRequestId)).resolves.toMatchObject({
      turn: { id: created.turn.id },
    });
    await expect(store.getTurnByClientRequestId('client_missing')).resolves.toBeNull();
    await expect(store.createTurn(turn({ request: {
      text: 'Другой запрос',
      attachmentIds: [],
      modifiers: {},
    } }))).rejects.toMatchObject({ code: 'client-request-reused' });
  });

  it('ignores server-owned enrichment drift but binds replay to the exact user message', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn({
      request: {
        text: 'Проверь настройки',
        attachmentIds: [],
        modifiers: {},
        personality: personality(4),
      },
    }));
    const replayed = await store.createTurn(turn({
      id: 'turn_test_personality_replay',
      createdAt: '2026-08-01T00:00:01.000Z',
      updatedAt: '2026-08-01T00:00:01.000Z',
      request: {
        text: 'Проверь настройки',
        attachmentIds: [],
        modifiers: {},
        personality: personality(5),
      },
    }));

    expect(replayed.replayed).toBe(true);
    expect(replayed.turn.id).toBe(created.turn.id);
    expect(replayed.turn.request.personality?.profileRevision).toBe(4);
    const replayedMessageIdentity = await store.createTurn(turn({
      id: 'turn_test_message_reuse',
      inputMessageId: 'message_user_different',
      request: {
        text: 'Проверь настройки',
        attachmentIds: [],
        modifiers: {},
      },
    }));
    expect(replayedMessageIdentity.replayed).toBe(true);
    expect(replayedMessageIdentity.turn.inputMessageId).toBe(created.turn.inputMessageId);
  });

  it('keeps client cancellation reservations exact-scoped and expiring', async () => {
    const store = await createStore();
    const reservation = {
      clientRequestId: 'client_cancel_reservation',
      source: 'desktop' as const,
      privacyMode: 'persistent' as const,
    };
    await store.reserveClientCancellation({
      ...reservation,
      expiresAt: '2027-08-01T00:05:00.000Z',
    });

    await expect(store.hasClientCancellation(
      reservation,
      new Date('2027-08-01T00:01:00.000Z'),
    )).resolves.toBe(true);
    await expect(store.hasClientCancellation(
      { ...reservation, source: 'api' },
      new Date('2027-08-01T00:01:00.000Z'),
    )).resolves.toBe(false);
    await expect(store.reserveClientCancellation({
      ...reservation,
      source: 'api',
      expiresAt: '2027-08-01T00:06:00.000Z',
    })).rejects.toMatchObject({ code: 'client-request-reused' });
    await expect(store.hasClientCancellation(
      reservation,
      new Date('2027-08-01T00:05:00.000Z'),
    )).resolves.toBe(false);

    await store.clearClientCancellation({ ...reservation, source: 'api' });
    await expect(store.hasClientCancellation(
      reservation,
      new Date('2027-08-01T00:01:00.000Z'),
    )).resolves.toBe(true);
    await store.clearClientCancellation(reservation);
    await expect(store.hasClientCancellation(
      reservation,
      new Date('2027-08-01T00:01:00.000Z'),
    )).resolves.toBe(false);
  });

  it('uses monotonic CAS revisions and durable replayable events', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn(), {
      events: [{ type: 'turn.accepted', payload: {} }],
    });
    const routed = await store.saveTurn({
      ...created.turn,
      mode: 'agent',
      status: 'running',
    }, {
      expectedRevision: created.turn.revision,
      events: [{ type: 'turn.routed', payload: { disposition: 'agent' } }],
    });

    expect(routed.turn.revision).toBe(created.turn.revision + 1);
    expect(routed.events.map((event) => event.type)).toEqual([
      'turn.accepted',
      'turn.routed',
    ]);
    await expect(store.saveTurn(routed.turn, {
      expectedRevision: created.turn.revision,
    })).rejects.toMatchObject({ code: 'turn-revision-conflict' });
  });

  it('atomically binds one semantic V3 agent during routing without making request identity mutable', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn());
    const routing = await store.saveTurn({ ...created.turn, status: 'routing' }, {
      expectedRevision: created.turn.revision,
    });
    const binding = ordinaryAgentBinding();
    const bound = await store.bindOrdinaryAgent(routing.turn.id, binding, {
      expectedRevision: routing.turn.revision,
    });

    expect(bound.turn.request.astra).toEqual(binding);
    expect(bound.turn.revision).toBe(routing.turn.revision + 1);
    const replay = await store.bindOrdinaryAgent(bound.turn.id, binding, {
      expectedRevision: bound.turn.revision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.turn.revision).toBe(bound.turn.revision);

    await expect(store.bindOrdinaryAgent(bound.turn.id, ordinaryAgentBinding('selection_replacement'), {
      expectedRevision: bound.turn.revision,
    })).rejects.toMatchObject({ code: 'immutable-turn-field' });
    await expect(store.saveTurn({ ...bound.turn, request: { ...bound.turn.request, astra: undefined } }, {
      expectedRevision: bound.turn.revision,
    })).rejects.toMatchObject({ code: 'immutable-turn-field' });
  });

  it('rejects agent binding outside an eligible authenticated ordinary routing seam', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn());
    await expect(store.bindOrdinaryAgent(created.turn.id, ordinaryAgentBinding(), {
      expectedRevision: created.turn.revision,
    })).rejects.toMatchObject({ code: 'invalid-agent-binding' });

    const routing = await store.saveTurn({ ...created.turn, status: 'routing' }, {
      expectedRevision: created.turn.revision,
    });
    await expect(store.bindOrdinaryAgent(routing.turn.id, {
      ...ordinaryAgentBinding(),
      admission: 'ordinary-exact-read-v1',
    }, { expectedRevision: routing.turn.revision })).rejects.toMatchObject({ code: 'invalid-agent-binding' });
    await expect(store.bindOrdinaryAgent(routing.turn.id, {
      ...ordinaryAgentBinding(),
      actor: { ...ordinaryAgentBinding().actor, source: 'api' },
    }, { expectedRevision: routing.turn.revision })).rejects.toThrow();
  });

  it.each(['voice', 'system'] as const)('binds a trusted local %s semantic Turn to V3', async source => {
    const store = await createStore();
    const created = await store.createTurn(turn({ id: `turn_${source}_v3`, clientRequestId: `client_${source}_v3`, source }));
    const routing = await store.saveTurn({ ...created.turn, status: 'routing' }, { expectedRevision: created.turn.revision });
    const binding = { ...ordinaryAgentBinding(`selection_${source}_v3`),
      actor: { id: 'sha256:' + 'c'.repeat(64), source } };
    expect((await store.bindOrdinaryAgent(routing.turn.id, binding, {
      expectedRevision: routing.turn.revision,
    })).turn.request.astra).toEqual(binding);
  });

  it('requires the exact durable API principal before binding an API semantic Turn', async () => {
    const store = await createStore();
    const actor = { id: 'sha256:' + 'd'.repeat(64), source: 'api' as const };
    const created = await store.createTurn(turn({ id: 'turn_api_v3', clientRequestId: 'client_api_v3', source: 'api',
      request: { text: 'Выполни API-задачу.', attachmentIds: [], modifiers: {}, authenticatedAgentActor: actor } }));
    const routing = await store.saveTurn({ ...created.turn, status: 'routing' }, { expectedRevision: created.turn.revision });
    const binding = { ...ordinaryAgentBinding('selection_api_v3'), actor };
    const bound = await store.bindOrdinaryAgent(routing.turn.id, binding, {
      expectedRevision: routing.turn.revision,
    });
    expect(bound.turn.request.astra).toEqual(binding);

    await expect(store.saveTurn({ ...bound.turn,
      request: { ...bound.turn.request, authenticatedAgentActor: { ...actor, id: 'sha256:' + 'e'.repeat(64) } } },
    { expectedRevision: bound.turn.revision })).rejects.toMatchObject({ code: 'immutable-turn-field' });
  });

  it('binds Telegram only when its authenticated pairing envelope is durable', async () => {
    const store = await createStore();
    const telegramActor = { ownerUserId: 7, controlChatId: 7, botId: 123456, threadId: 11, pairingEpoch: 'test-epoch' };
    const created = await store.createTurn(turn({ id: 'turn_telegram_v3', clientRequestId: 'client_telegram_v3', source: 'telegram',
      request: { text: 'Выполни Telegram-задачу.', attachmentIds: [], modifiers: {}, telegramActor } }));
    const routing = await store.saveTurn({ ...created.turn, status: 'routing' }, { expectedRevision: created.turn.revision });
    const binding = { ...ordinaryAgentBinding('selection_telegram_v3'),
      actor: { id: 'sha256:' + 'f'.repeat(64), source: 'telegram' as const } };
    expect((await store.bindOrdinaryAgent(routing.turn.id, binding, {
      expectedRevision: routing.turn.revision,
    })).turn.request.astra).toEqual(binding);
  });

  it('binds a semantic V3 Coder Turn only with its durable project execution profile', async () => {
    const store = await createStore();
    const executionProfile = {
      schemaVersion: 'monarch.agent-execution-profile.v1' as const,
      kind: 'coder-project' as const,
      projectId: 'coder_project_selected',
      projectRoot: 'D:\\MonarchCoderTests\\selected',
      permissionProfile: {
        sandboxMode: 'workspace-write' as const,
        approvalPolicy: 'on-request' as const,
        autonomyMode: 'workspace-autonomous' as const,
      },
    };
    const created = await store.createTurn(turn({
      id: 'turn_coder_v3',
      clientRequestId: 'client_coder_v3',
      source: 'coder',
      request: {
        text: 'Измени выбранный проект и проверь результат.',
        attachmentIds: [],
        modifiers: { requestedModel: 'qwen3-coder-30b-a3b-instruct' },
        executionProfile,
      },
    }));
    const routing = await store.saveTurn({ ...created.turn, status: 'routing' }, {
      expectedRevision: created.turn.revision,
    });
    const binding = {
      ...ordinaryAgentBinding('selection_coder_v3'),
      actor: { id: 'sha256:' + 'b'.repeat(64), source: 'coder' as const },
    };
    const bound = await store.bindOrdinaryAgent(routing.turn.id, binding, {
      expectedRevision: routing.turn.revision,
    });
    expect(bound.turn.request).toMatchObject({ executionProfile, astra: binding });

    const missing = await store.createTurn(turn({
      id: 'turn_coder_without_profile',
      clientRequestId: 'client_coder_without_profile',
      source: 'coder',
      request: { text: 'Не имеет права привязаться.', attachmentIds: [], modifiers: {} },
    }));
    const missingRouting = await store.saveTurn({ ...missing.turn, status: 'routing' }, {
      expectedRevision: missing.turn.revision,
    });
    await expect(store.bindOrdinaryAgent(missingRouting.turn.id, binding, {
      expectedRevision: missingRouting.turn.revision,
    })).rejects.toMatchObject({ code: 'invalid-agent-binding' });
  });

  it('never revises a terminal Turn or appends terminal events twice', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn());
    const terminal = await store.saveTurn({
      ...created.turn,
      status: 'succeeded',
      outcome: {
        kind: 'answered',
        summary: 'Четыре.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, {
      expectedRevision: created.turn.revision,
      events: [{ type: 'turn.outcome', payload: { outcome: 'answered' } }],
    });

    const replayed = await store.saveTurn(terminal.turn, {
      expectedRevision: terminal.turn.revision,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.turn.revision).toBe(terminal.turn.revision);
    expect(replayed.events).toHaveLength(1);
    await expect(store.saveTurn(terminal.turn, {
      expectedRevision: terminal.turn.revision,
      events: [{ type: 'turn.outcome', payload: { duplicate: true } }],
    })).rejects.toMatchObject({ code: 'turn-terminal' });
  });

  it('accepts a bounded failure diagnostic and rejects malformed diagnostic state', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn());
    const terminal = await store.saveTurn({
      ...created.turn,
      status: 'failed',
      outcome: {
        kind: 'failed',
        summary: 'Не удалось завершить задачу.',
        evidenceRefs: [],
        diagnostic: {
          code: 'synthetic-failure',
          detail: 'bounded local detail',
          fingerprint: `sha256:${'a'.repeat(64)}`,
        },
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, { expectedRevision: created.turn.revision });
    expect(terminal.turn.outcome?.diagnostic).toMatchObject({ code: 'synthetic-failure' });

    const malformedStore = await createStore();
    const malformedCreated = await malformedStore.createTurn(turn());
    await expect(malformedStore.saveTurn({
      ...malformedCreated.turn,
      status: 'failed',
      outcome: {
        kind: 'failed',
        summary: 'Не удалось завершить задачу.',
        evidenceRefs: [],
        diagnostic: {
          code: 'synthetic-failure',
          detail: 'x'.repeat(2_001),
          fingerprint: 'sha256:not-a-digest',
        },
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, { expectedRevision: malformedCreated.turn.revision }))
      .rejects.toMatchObject({ code: 'invalid-turn' });
  });

  it('atomically repairs only the missing terminal message projection and replays idempotently', async () => {
    const store = await createStore();
    const created = await store.createTurn(turn());
    const terminal = await store.saveTurn({
      ...created.turn,
      status: 'cancelled',
      outcome: {
        kind: 'cancelled',
        summary: 'Turn отменён пользователем.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, {
      expectedRevision: created.turn.revision,
      events: [{ type: 'turn.outcome', payload: { outcome: 'cancelled' } }],
    });
    const repair = terminalMessageRepair(terminal.turn, 'message_terminal_recovery');

    const recovered = await store.ensureTerminalMessage(terminal.turn.id, repair);
    const replayed = await store.ensureTerminalMessage(terminal.turn.id, repair);

    expect(recovered.turn).toMatchObject({
      status: 'cancelled',
      outputMessageId: repair.messageId,
      outcome: terminal.turn.outcome,
    });
    expect(recovered.turn.revision).toBe(terminal.turn.revision + 1);
    expect(recovered.events).toEqual(terminal.events);
    expect(recovered.appendedEvents).toEqual([]);
    expect(replayed.replayed).toBe(true);
    expect(await store.listPendingOutbox()).toEqual([
      expect.objectContaining({ id: repair.outbox.id, status: 'pending' }),
    ]);
  });

  it('rejects terminal message repair for an active Turn or a mismatched outcome', async () => {
    const store = await createStore();
    const active = await store.createTurn(turn());
    const activeRepair = terminalMessageRepair({
      ...active.turn,
      status: 'failed',
      outcome: {
        kind: 'failed',
        summary: 'Synthetic failure.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, 'message_active_recovery');
    await expect(store.ensureTerminalMessage(active.turn.id, activeRepair))
      .rejects.toMatchObject({ code: 'turn-not-terminal' });

    const terminal = await store.saveTurn({
      ...active.turn,
      status: 'failed',
      outcome: {
        kind: 'failed',
        summary: 'Synthetic failure.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, { expectedRevision: active.turn.revision });
    const mismatched = terminalMessageRepair(terminal.turn, 'message_mismatch_recovery');
    mismatched.outbox.payload.content = 'Fabricated success.';
    await expect(store.ensureTerminalMessage(terminal.turn.id, mismatched))
      .rejects.toMatchObject({ code: 'invalid-terminal-message-repair' });
  });

  it('supersedes an oversized historical terminal outbox without retrying it again', async () => {
    const store = await createStore();
    const longTurn = turn({
      id: 'oscar_turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      clientRequestId: 'client_oversized_terminal',
      inputMessageId: 'message_user_oversized_terminal',
    });
    const created = await store.createTurn(longTurn);
    const historicalMessageId = `oscar_message_terminal_${longTurn.id}`;
    expect(historicalMessageId.length).toBeGreaterThan(64);
    const terminal = await store.saveTurn({
      ...created.turn,
      status: 'blocked',
      outputMessageId: historicalMessageId,
      outcome: {
        kind: 'blocked',
        summary: 'Нужно явное разрешение пользователя.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, {
      expectedRevision: created.turn.revision,
      outbox: [{
        id: `outbox_message_${historicalMessageId}`,
        turnId: longTurn.id,
        kind: 'persist-message',
        payload: {
          conversationId: longTurn.conversationId,
          messageId: historicalMessageId,
          role: 'assistant',
          content: 'Нужно явное разрешение пользователя.',
          turnId: longTurn.id,
          provenance: {
            origin: 'system',
            verification: 'system-state',
            turnId: longTurn.id,
          },
          outcome: 'blocked',
        },
      }],
    });
    const historicalOutboxId = `outbox_message_${historicalMessageId}`;
    await store.markOutboxFailed(historicalOutboxId, 'HTTP 422', new Date(0).toISOString());
    const repair = terminalMessageRepair(terminal.turn, 'message_terminal_digest_recovery');

    const recovered = await store.ensureTerminalMessage(terminal.turn.id, repair);

    expect(recovered.turn.outputMessageId).toBe(repair.messageId);
    expect(recovered.turn.revision).toBe(terminal.turn.revision + 1);
    expect(await store.listPendingOutbox()).toEqual([
      expect.objectContaining({ id: repair.outbox.id, status: 'pending' }),
    ]);
    await store.markOutboxFailed(historicalOutboxId, 'must-not-retry', new Date(0).toISOString());
    expect(await store.listPendingOutbox()).toHaveLength(1);
  });
});

function personality(revision: number): NonNullable<OscarTurnV1['request']['personality']> {
  return {
    schemaVersion: 2,
    profileId: 'personality-direct',
    profileRevision: revision,
    profileHash: `${revision}`.padStart(64, 'a').slice(-64),
    variant: 'direct',
    name: 'Прямой',
    dimensions: {
      brevity: 80,
      warmth: 40,
      directness: 90,
      initiative: 55,
      humor: 20,
      skepticism: 75,
      technicalDepth: 90,
      structure: 80,
    },
    addressForm: 'ты',
    language: 'ru',
    customRules: ['Сначала результат.'],
  };
}

describe('LocalJsonOscarTurnStore document', () => {
  it('persists a durable outbox item without hiding the payload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-turn-outbox-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    await store.createTurn(turn(), {
      outbox: [{
        id: 'outbox_message_1',
        turnId: 'turn_test_1',
        kind: 'persist-message',
        payload: { messageId: 'message_user_1' },
      }],
    });

    const pending = await store.listPendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(JSON.parse(await readFile(filePath, 'utf8')).outbox.outbox_message_1).toBeTruthy();
  });

  it('clears active retry diagnostics after a recovered outbox succeeds and stays settled after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-outbox-recovered-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    await store.createTurn(turn(), {
      outbox: [{
        id: 'outbox_message_recovered',
        turnId: 'turn_test_1',
        kind: 'persist-message',
        payload: { messageId: 'message_user_1' },
      }],
    });
    await store.markOutboxFailed(
      'outbox_message_recovered',
      'backend unavailable',
      '2027-08-01T00:00:00.000Z',
    );
    await store.markOutboxSucceeded('outbox_message_recovered');

    const settled = JSON.parse(await readFile(filePath, 'utf8')).outbox.outbox_message_recovered;
    expect(settled).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(settled).not.toHaveProperty('lastError');
    expect(settled).not.toHaveProperty('nextAttemptAt');
    await expect(new LocalJsonOscarTurnStore(filePath).listPendingOutbox(new Date('2030-01-01T00:00:00.000Z')))
      .resolves.toEqual([]);
  });

  it('retires a stale message outbox as superseded and never retries it after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-outbox-superseded-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    await store.createTurn(turn(), {
      outbox: [{
        id: 'outbox_message_superseded',
        turnId: 'turn_test_1',
        kind: 'persist-message',
        payload: { messageId: 'message_terminal_stale' },
      }],
    });
    await store.markOutboxFailed(
      'outbox_message_superseded',
      'required previous message was temporarily unavailable',
      '2027-08-01T00:00:00.000Z',
    );
    await store.markOutboxSuperseded('outbox_message_superseded');

    const settled = JSON.parse(await readFile(filePath, 'utf8')).outbox.outbox_message_superseded;
    expect(settled).toMatchObject({ status: 'superseded', attempts: 1 });
    expect(settled).not.toHaveProperty('lastError');
    expect(settled).not.toHaveProperty('nextAttemptAt');
    await expect(new LocalJsonOscarTurnStore(filePath).listPendingOutbox(new Date('2030-01-01T00:00:00.000Z')))
      .resolves.toEqual([]);
  });

  it('refuses to silently supersede an operational outbox side effect', async () => {
    const store = new InMemoryOscarTurnStore();
    await store.createTurn(turn(), {
      outbox: [{
        id: 'outbox_create_task_must_run',
        turnId: 'turn_test_1',
        kind: 'create-agent-task',
        payload: {},
      }],
    });

    await expect(store.markOutboxSuperseded('outbox_create_task_must_run')).rejects.toMatchObject({
      code: 'invalid-outbox-transition',
    });
    await expect(store.listPendingOutbox()).resolves.toEqual([
      expect.objectContaining({ id: 'outbox_create_task_must_run', status: 'pending' }),
    ]);
  });

  it.each([
    ['unknown status', (item: Record<string, unknown>) => { item.status = 'lost'; }],
    ['unknown kind', (item: Record<string, unknown>) => { item.kind = 'run-arbitrary-code'; }],
    ['negative attempts', (item: Record<string, unknown>) => { item.attempts = -1; }],
    ['fractional attempts', (item: Record<string, unknown>) => { item.attempts = 1.5; }],
    ['array payload', (item: Record<string, unknown>) => { item.payload = []; }],
    ['invalid creation time', (item: Record<string, unknown>) => { item.createdAt = 'tomorrow-ish'; }],
    ['invalid retry time', (item: Record<string, unknown>) => { item.nextAttemptAt = 'later'; }],
    ['non-string error', (item: Record<string, unknown>) => { item.lastError = 42; }],
    ['oversized error', (item: Record<string, unknown>) => { item.lastError = 'x'.repeat(2_001); }],
    ['missing supersession target', (item: Record<string, unknown>) => { item.supersededBy = 'outbox_missing'; }],
  ])('sets a persisted outbox with %s aside unchanged and never runs it', async (_case, corrupt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-outbox-invalid-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    await store.createTurn(turn(), {
      outbox: [{
        id: 'outbox_message_invalid',
        turnId: 'turn_test_1',
        kind: 'persist-message',
        payload: { messageId: 'message_user_1' },
      }],
    });
    const document = JSON.parse(await readFile(filePath, 'utf8'));
    corrupt(document.outbox.outbox_message_invalid);
    const corruptBytes = JSON.stringify(document, null, 2);
    await writeFile(filePath, corruptBytes, 'utf8');

    await expectQuarantined(filePath, corruptBytes, (reopened) => reopened.listPendingOutbox(), []);
  });

  it.each([
    ['missing receipt', (document: MutableTurnStoreFixture) => { delete document.clientRequests.client_test_1; }],
    ['invalid fingerprint', (document: MutableTurnStoreFixture) => { document.clientRequests.client_test_1.fingerprint = 'not-a-digest'; }],
    ['missing Turn target', (document: MutableTurnStoreFixture) => { document.clientRequests.client_test_1.turnId = 'turn_missing'; }],
    ['invalid receipt time', (document: MutableTurnStoreFixture) => { document.clientRequests.client_test_1.createdAt = 'eventually'; }],
  ])('sets a persisted idempotency map with %s aside unchanged and trusts none of it', async (_case, corrupt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-receipt-invalid-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    await store.createTurn(turn());
    const document = JSON.parse(await readFile(filePath, 'utf8'));
    corrupt(document);
    const corruptBytes = JSON.stringify(document, null, 2);
    await writeFile(filePath, corruptBytes, 'utf8');

    await expectQuarantined(filePath, corruptBytes, (reopened) => reopened.getTurnByClientRequestId('client_test_1'), null);
  });

  it('sets an unreadable store aside, reports it, and accepts new Turns', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-store-torn-'));
    const filePath = path.join(root, 'turns.v1.json');
    await new LocalJsonOscarTurnStore(filePath).createTurn(turn());
    const corruptBytes = (await readFile(filePath, 'utf8')).slice(0, 40);
    await writeFile(filePath, corruptBytes, 'utf8');
    await expectQuarantined(filePath, corruptBytes, (reopened) => reopened.listTurns(), [], 'invalid-json');
  });

  it('sets a cross-linked outbox supersession cycle aside instead of running either operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-outbox-cycle-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    await store.createTurn(turn(), {
      outbox: [
        { id: 'outbox_cycle_a', turnId: 'turn_test_1', kind: 'reconcile-turn', payload: {} },
        { id: 'outbox_cycle_b', turnId: 'turn_test_1', kind: 'reconcile-turn', payload: {} },
      ],
    });
    const document = JSON.parse(await readFile(filePath, 'utf8'));
    document.outbox.outbox_cycle_a.supersededBy = 'outbox_cycle_b';
    document.outbox.outbox_cycle_b.supersededBy = 'outbox_cycle_a';
    const corruptBytes = JSON.stringify(document, null, 2);
    await writeFile(filePath, corruptBytes, 'utf8');

    await expectQuarantined(filePath, corruptBytes, (reopened) => reopened.listPendingOutbox(), []);
  });

  it('validates a long acyclic supersession chain iteratively and schedules only its live tail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-outbox-chain-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    const length = 512;
    await store.createTurn(turn(), {
      outbox: Array.from({ length }, (_, index) => ({
        id: `outbox_chain_${index}`,
        turnId: 'turn_test_1',
        kind: 'reconcile-turn' as const,
        payload: {},
      })),
    });
    const document = JSON.parse(await readFile(filePath, 'utf8'));
    for (let index = 0; index < length - 1; index += 1) {
      document.outbox[`outbox_chain_${index}`].supersededBy = `outbox_chain_${index + 1}`;
    }
    await writeFile(filePath, JSON.stringify(document, null, 2), 'utf8');

    await expect(new LocalJsonOscarTurnStore(filePath).listPendingOutbox())
      .resolves.toEqual([expect.objectContaining({ id: `outbox_chain_${length - 1}` })]);
  });

  it('treats supersededBy as terminal even if an old writer restores retrying status', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-outbox-race-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    const longTurn = turn({
      id: 'oscar_turn_cccccccccccccccccccccccccccccccc',
      clientRequestId: 'client_outbox_race',
      inputMessageId: 'message_user_outbox_race',
    });
    const created = await store.createTurn(longTurn);
    const historicalMessageId = `oscar_message_terminal_${longTurn.id}`;
    const terminal = await store.saveTurn({
      ...created.turn,
      status: 'failed',
      outputMessageId: historicalMessageId,
      outcome: {
        kind: 'failed',
        summary: 'Историческая ошибка.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, {
      expectedRevision: created.turn.revision,
      outbox: [{
        id: `outbox_message_${historicalMessageId}`,
        turnId: longTurn.id,
        kind: 'persist-message',
        payload: {
          conversationId: longTurn.conversationId,
          messageId: historicalMessageId,
          role: 'assistant',
          content: 'Историческая ошибка.',
          turnId: longTurn.id,
          provenance: { origin: 'system', verification: 'system-state', turnId: longTurn.id },
          outcome: 'failed',
        },
      }],
    });
    const repair = terminalMessageRepair(terminal.turn, 'message_terminal_race_recovery');
    await store.ensureTerminalMessage(terminal.turn.id, repair);

    const document = JSON.parse(await readFile(filePath, 'utf8'));
    const historicalOutboxId = `outbox_message_${historicalMessageId}`;
    document.outbox[historicalOutboxId].status = 'retrying';
    document.outbox[historicalOutboxId].nextAttemptAt = new Date(0).toISOString();
    await writeFile(filePath, JSON.stringify(document, null, 2), 'utf8');

    const restarted = new LocalJsonOscarTurnStore(filePath);
    expect(await restarted.listPendingOutbox()).toEqual([
      expect.objectContaining({ id: repair.outbox.id, status: 'pending' }),
    ]);
    await restarted.ensureTerminalMessage(terminal.turn.id, repair);
    const normalized = JSON.parse(await readFile(filePath, 'utf8'));
    expect(normalized.outbox[historicalOutboxId]).toMatchObject({
      status: 'superseded',
      supersededBy: repair.outbox.id,
    });
    expect(normalized.outbox[historicalOutboxId].nextAttemptAt).toBeUndefined();
  });
});

describe('LocalJsonOscarTurnStore settled-Turn archive', () => {
  async function storeWithTurns(count: number, options: {
    status?: OscarTurnV1['status']; retention?: { highWaterTurns: number; lowWaterTurns: number };
  } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monarch-turn-archive-'));
    const filePath = path.join(directory, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath,
      options.retention ?? { highWaterTurns: 4, lowWaterTurns: 2 });
    const created: OscarTurnV1[] = [];
    for (let index = 0; index < count; index++) {
      const value = turn({
        id: `turn_archive_${index}`,
        clientRequestId: `client_archive_${index}`,
        status: options.status ?? 'succeeded',
        createdAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        updatedAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      });
      await store.createTurn(value);
      created.push(value);
    }
    return { store, filePath, created,
      document: async () => JSON.parse(await readFile(filePath, 'utf8')) as {
        turns: Record<string, unknown>; clientRequests: Record<string, unknown>; outbox: Record<string, unknown> } };
  }

  it('keeps settled Turns out of the document that every change rewrites', async () => {
    // One JSON document rewritten per event means the cost of recording an
    // event is the size of the whole history, which is what made submitting a
    // greeting block for seconds on a real store.
    const { store, document } = await storeWithTurns(6);

    const live = await document();
    // Compaction runs on the high-water mark and drains to the low-water one,
    // so the document holds what was created after the last drain, never the
    // whole history.
    expect(Object.keys(live.turns)).toHaveLength(3);
    // Nothing is lost: reads still answer for every Turn ever created.
    expect((await store.listTurns()).map((entry) => entry.id)).toEqual([
      'turn_archive_0', 'turn_archive_1', 'turn_archive_2',
      'turn_archive_3', 'turn_archive_4', 'turn_archive_5',
    ]);
    expect(await store.getTurn('turn_archive_0')).toMatchObject({ turn: { id: 'turn_archive_0' } });
    // An archived receipt still answers a replayed request, or the same
    // clientRequestId would be admitted a second time as new work.
    expect(await store.getTurnByClientRequestId('client_archive_0'))
      .toMatchObject({ turn: { id: 'turn_archive_0' } });
    expect(Object.keys(live.clientRequests)).toHaveLength(3);
  });

  it('never archives a Turn that is not settled', async () => {
    const { store, document } = await storeWithTurns(6, { status: 'answering' });

    expect(Object.keys((await document()).turns)).toHaveLength(6);
    expect(await store.listTurns()).toHaveLength(6);
  });

  it('keeps a settled Turn whose message has not been delivered', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monarch-turn-archive-pending-'));
    const filePath = path.join(directory, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath, { highWaterTurns: 4, lowWaterTurns: 2 });
    for (let index = 0; index < 6; index++) {
      const value = turn({ id: `turn_pending_${index}`, clientRequestId: `client_pending_${index}`,
        status: 'succeeded', createdAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        updatedAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z` });
      await store.createTurn(value, index === 0 ? { outbox: [{ id: 'outbox_pending_0',
        turnId: value.id, kind: 'persist-message', payload: { conversationId: value.conversationId } }] } : {});
    }

    const document = JSON.parse(await readFile(filePath, 'utf8')) as { turns: Record<string, unknown> };
    // Undelivered work is live work, whatever the Turn's own status says.
    expect(Object.keys(document.turns)).toContain('turn_pending_0');
    expect(await store.readOutboxItem('outbox_pending_0')).toMatchObject({ status: 'pending' });
  });

  it('sets a large archive aside under a dated name before appending', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'monarch-turn-archive-rotate-'));
    const filePath = path.join(directory, 'turns.v1.json');
    await writeFile(`${filePath}.archive.jsonl`, 'x'.repeat(2048), 'utf8');
    const store = new LocalJsonOscarTurnStore(filePath, { highWaterTurns: 4, lowWaterTurns: 2, archiveRotateBytes: 1024 });
    for (let index = 0; index < 6; index++) {
      const value = turn({ id: `turn_rotate_${index}`, clientRequestId: `client_rotate_${index}`, status: 'succeeded',
        createdAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`, updatedAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z` });
      await store.createTurn(value);
    }
    const names = await readdir(directory);
    const rotated = names.filter(name => /^turns\.v1\.json\.archive\..+\.jsonl$/u.test(name));
    expect(rotated).toHaveLength(1);
    expect(await readFile(path.join(directory, rotated[0]!), 'utf8')).toBe('x'.repeat(2048));
    expect(await store.listTurns()).toHaveLength(6);
  });

  it('refuses to report a deletion it cannot perform on the append-only archive', async () => {
    const { store } = await storeWithTurns(6);

    await expect(store.deleteTurn('turn_archive_0')).rejects.toMatchObject({ code: 'turn-archived' });
    expect(await store.deleteTurn('turn_archive_absent')).toBe(false);
  });

  it('keeps the readable archive when one record is damaged, and a torn tail never swallows the next record', async () => {
    // One bad line used to make every lookup of an old Turn fail with archive-corrupt.
    const { filePath } = await storeWithTurns(6);
    const archivePath = `${filePath}.archive.jsonl`;
    const lines = (await readFile(archivePath, 'utf8')).trim().split('\n');
    const archivedIds = lines.map((line) => (JSON.parse(line) as { turn: { id: string } }).turn.id);
    expect(archivedIds.length).toBeGreaterThan(1);
    // A damaged record in the middle and a record torn by a crash at the end.
    await writeFile(archivePath, [lines[0], '{"turn":', ...lines.slice(1)].join('\n') + '\n{"turn":{"id"', 'utf8');

    const reports: Array<Record<string, string | number>> = [];
    const store = new LocalJsonOscarTurnStore(filePath, { highWaterTurns: 4, lowWaterTurns: 2 }, (entry) => { reports.push(entry); });
    for (const id of archivedIds) expect(await store.getTurn(id)).toMatchObject({ turn: { id } });
    expect(reports).toEqual([{ diagnostic: 'oscar-turn-archive-records-skipped', count: 1 }]);

    // More Turns archive more records; the first new one starts on its own line.
    for (let index = 6; index < 9; index++) {
      await store.createTurn(turn({ id: `turn_archive_${index}`, clientRequestId: `client_archive_${index}`,
        status: 'succeeded', createdAt: `2026-08-01T00:00:0${index}.000Z`, updatedAt: `2026-08-01T00:00:0${index}.000Z` }));
    }
    const after = (await readFile(archivePath, 'utf8')).trim().split('\n');
    const readable = after.flatMap((line) => { try { return [(JSON.parse(line) as { turn: { id: string } }).turn.id]; } catch { return []; } });
    expect(readable.length).toBe(after.length - 2);
    for (const id of readable) expect(await store.getTurn(id)).toMatchObject({ turn: { id } });
  });

  it('seals the document and every archive line under storage protection, replacing plain lines', async () => {
    const { filePath } = await storeWithTurns(6);
    const archivePath = `${filePath}.archive.jsonl`;
    const archivedId = JSON.parse((await readFile(archivePath, 'utf8')).trim().split('\n')[0]!).turn.id as string;
    setStoreProtectionForTesting({ mode: 'sealed', key: randomBytes(32) });
    try {
      const store = new LocalJsonOscarTurnStore(filePath, { highWaterTurns: 4, lowWaterTurns: 2 });
      expect(await store.getTurn(archivedId)).toMatchObject({ turn: { id: archivedId } });
      for (let index = 6; index < 9; index++) {
        await store.createTurn(turn({ id: `turn_archive_${index}`, clientRequestId: `client_archive_${index}`,
          status: 'succeeded', createdAt: `2026-08-01T00:00:0${index}.000Z`, updatedAt: `2026-08-01T00:00:0${index}.000Z` }));
      }
      const plainLeft = async () => {
        const files = await readdir(path.dirname(filePath));
        const texts = await Promise.all(files.map(name => readFile(path.join(path.dirname(filePath), name), 'utf8')));
        return texts.some(text => text.includes('turn_archive_'));
      };
      for (let attempt = 0; attempt < 100 && await plainLeft(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(await plainLeft()).toBe(false);
      for (const line of (await readFile(archivePath, 'utf8')).trim().split('\n')) expect(line.startsWith('MSF1:')).toBe(true);
      expect(await store.getTurn(archivedId)).toMatchObject({ turn: { id: archivedId } });
      expect(await store.getTurn('turn_archive_8')).toMatchObject({ turn: { id: 'turn_archive_8' } });
    } finally {
      setStoreProtectionForTesting(undefined);
    }
  });
});

function terminalMessageRepair(turnValue: OscarTurnV1, messageId: string) {
  return {
    messageId,
    outbox: {
      id: `outbox_message_${messageId}`,
      turnId: turnValue.id,
      kind: 'persist-message' as const,
      payload: {
        conversationId: turnValue.conversationId,
        messageId,
        role: 'assistant',
        content: turnValue.outcome?.summary,
        turnId: turnValue.id,
        provenance: {
          origin: 'system',
          verification: 'system-state',
          turnId: turnValue.id,
          surface: turnValue.source,
          privacyMode: turnValue.privacyMode,
        },
        outcome: turnValue.outcome?.kind,
        createConversationIfMissing: false,
        requiredPreviousMessageId: turnValue.inputMessageId,
        source: turnValue.source,
        privacyMode: turnValue.privacyMode,
      },
    },
  };
}
