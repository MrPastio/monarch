import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

describe.each([
  ['memory', () => new InMemoryOscarTurnStore()],
  ['json', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-turn-store-'));
    return new LocalJsonOscarTurnStore(path.join(root, 'turns.v1.json'));
  }],
])('OscarTurnStore (%s)', (_name, createStore) => {
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
  ])('fails closed on a persisted outbox with %s without rewriting the evidence', async (_case, corrupt) => {
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

    await expect(new LocalJsonOscarTurnStore(filePath).listPendingOutbox())
      .rejects.toMatchObject({ code: 'invalid-document' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(corruptBytes);
  });

  it.each([
    ['missing receipt', (document: MutableTurnStoreFixture) => { delete document.clientRequests.client_test_1; }],
    ['invalid fingerprint', (document: MutableTurnStoreFixture) => { document.clientRequests.client_test_1.fingerprint = 'not-a-digest'; }],
    ['missing Turn target', (document: MutableTurnStoreFixture) => { document.clientRequests.client_test_1.turnId = 'turn_missing'; }],
    ['invalid receipt time', (document: MutableTurnStoreFixture) => { document.clientRequests.client_test_1.createdAt = 'eventually'; }],
  ])('fails closed on a persisted idempotency map with %s and preserves its bytes', async (_case, corrupt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-receipt-invalid-'));
    const filePath = path.join(root, 'turns.v1.json');
    const store = new LocalJsonOscarTurnStore(filePath);
    await store.createTurn(turn());
    const document = JSON.parse(await readFile(filePath, 'utf8'));
    corrupt(document);
    const corruptBytes = JSON.stringify(document, null, 2);
    await writeFile(filePath, corruptBytes, 'utf8');

    await expect(new LocalJsonOscarTurnStore(filePath).getTurnByClientRequestId('client_test_1'))
      .rejects.toMatchObject({ code: 'invalid-document' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(corruptBytes);
  });

  it('rejects a cross-linked outbox supersession cycle instead of hiding both operations', async () => {
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

    await expect(new LocalJsonOscarTurnStore(filePath).listPendingOutbox())
      .rejects.toMatchObject({ code: 'invalid-document' });
    await expect(readFile(filePath, 'utf8')).resolves.toBe(corruptBytes);
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
