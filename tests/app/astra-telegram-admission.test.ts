import { describe, expect, it } from 'vitest';
import {
  ASTRA_TELEGRAM_CONSENT_VERSION,
  ASTRA_TELEGRAM_REMOTE_MODE,
  createAstraTelegramRemoteAdmissionPolicy,
} from '../../src/app/astra-telegram-admission';
import { AstraOscarBridge } from '../../src/app/astra-oscar-bridge';
import type { MonarchAstraTaskFacade } from '../../src/app/astra-task-facade';
import type { OscarTurnV1 } from '../../src/oscar-turn';

const valid = () => ({
  version: 1 as const,
  chatId: 1001,
  userId: 2002,
  messageId: 71,
  pairingEpoch: '2026-09-01T00:00:00.000Z',
  paired: true,
  remotePaused: false,
  zeroRetention: false,
  consentVersion: ASTRA_TELEGRAM_CONSENT_VERSION,
  operation: 'workspace-read' as const,
  targetAlias: 'astra_remote_alias_0123456789abcdef',
  text: 'Прочитай локально разрешённый отчёт.',
});

describe('Astra Telegram remote admission policy', () => {
  it('derives cancellation identity while remote admission is paused', () => {
    const policy = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!;
    const identity = policy.identity({ chatId: -1001, userId: 2002,
      pairingEpoch: '2026-09-01T00:00:00.000Z', paired: true });
    expect(identity).toMatchObject({
      actor: { source: 'telegram', id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
      conversationId: expect.stringMatching(/^telegram_remote_[a-f0-9]{48}$/u),
    });
    expect(() => policy.principal({ chatId: -1001, userId: 2002,
      pairingEpoch: '2026-09-01T00:00:00.000Z', paired: true, remotePaused: true,
      zeroRetention: false, consentVersion: ASTRA_TELEGRAM_CONSENT_VERSION })).toThrow('remote-paused');
    expect(() => policy.identity({ chatId: -1001, userId: 2002,
      pairingEpoch: '2026-09-01T00:00:00.000Z', paired: true, remotePaused: true })).toThrow('unknown-field');
  });

  it('is physically absent unless the exact default-off mode is selected', () => {
    expect(createAstraTelegramRemoteAdmissionPolicy()).toBeNull();
    expect(createAstraTelegramRemoteAdmissionPolicy('enabled')).toBeNull();
    expect(createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)).not.toBeNull();
  });

  it('derives stable opaque actor/message bindings without granting create or Computer authority', () => {
    const policy = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!;
    const first = policy.admit(valid());
    const replay = policy.admit(valid());

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      version: 1,
      source: 'telegram',
      actor: { id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u), source: 'telegram' },
      clientRequestId: expect.stringMatching(/^telegram_request_[a-f0-9]{48}$/u),
      conversationId: expect.stringMatching(/^telegram_remote_[a-f0-9]{48}$/u),
      inputMessageId: expect.stringMatching(/^telegram_message_[a-f0-9]{48}$/u),
      privacyMode: 'persistent',
      operation: 'workspace-read',
      authority: 'read-only',
      authorizesCreate: false,
      authorizesComputer: false,
    });
    expect(JSON.stringify(first)).not.toContain('"chatId"');
    expect(JSON.stringify(first)).not.toContain('"userId"');
  });

  it('changes remote authority after re-pairing or for another exact Telegram actor', () => {
    const policy = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!;
    const current = policy.admit(valid());
    const repaired = policy.admit({ ...valid(), pairingEpoch: '2026-09-02T00:00:00.000Z' });
    const otherUser = policy.admit({ ...valid(), userId: 2003 });

    expect(repaired.actor.id).not.toBe(current.actor.id);
    expect(otherUser.actor.id).not.toBe(current.actor.id);
    expect(repaired.conversationId).not.toBe(current.conversationId);
  });

  it('binds the authenticated Telegram actor to workspace read without enabling Computer', () => {
    const admission = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!.admit(valid());
    const turn: OscarTurnV1 = {
      schemaVersion: 'monarch.oscar-turn.v1', id: 'turn_remote_read', clientRequestId: admission.clientRequestId,
      conversationId: admission.conversationId, source: 'telegram', privacyMode: 'persistent', mode: 'agent', status: 'accepted',
      request: { text: admission.text, attachmentIds: [], modifiers: {} }, inputMessageId: admission.inputMessageId,
      revision: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const bridge = new AstraOscarBridge({} as MonarchAstraTaskFacade, () => admission.actor);
    const binding = bridge.bind(turn, {
      selectionId: 'selection_remote_alias',
      goal: { kind: 'observe', targets: ['file'] },
    }, admission.actor);

    expect(binding).toMatchObject({ actor: admission.actor, goal: { kind: 'observe' } });
    expect(() => bridge.bind(turn, { selectionId: 'selection_remote_alias', goal: { kind: 'computer-observe' } }, admission.actor))
      .toThrow('astra-computer-source-unavailable');
    const forged = bridge.bind(turn, { selectionId: 'selection_remote_alias', goal: { kind: 'observe', targets: ['file'] } },
      { ...admission.actor, id: `sha256:${'f'.repeat(64)}` });
    expect(() => bridge.find({ ...turn, request: { ...turn.request, astra: forged } })).toThrow('astra-oscar-actor-changed');
  });

  it.each([
    ['unpaired', { paired: false }, 'pairing-required'],
    ['lockdown', { remotePaused: true }, 'remote-paused'],
    ['zero retention', { zeroRetention: true }, 'persistent-mode-required'],
    ['wrong consent', { consentVersion: 'old-consent' }, 'consent-required'],
    ['create operation', { operation: 'workspace-create' }, 'operation-denied'],
    ['computer operation', { operation: 'computer-action' }, 'operation-denied'],
    ['raw Windows path', { targetAlias: 'E:\\Monarch\\secret.txt' }, 'host-alias-required'],
    ['raw relative path', { targetAlias: '../secret.txt' }, 'host-alias-required'],
    ['unknown field', { selectedPath: 'report.txt' }, 'unknown-field'],
  ])('rejects %s before an Astra Turn exists', (_name, patch, code) => {
    const policy = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!;
    expect(() => policy.admit({ ...valid(), ...patch })).toThrow(`astra-telegram:${code}`);
  });

  it('rejects empty and oversized UTF-8 task text', () => {
    const policy = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!;
    expect(() => policy.admit({ ...valid(), text: '   ' })).toThrow('astra-telegram:invalid-text');
    expect(() => policy.admit({ ...valid(), text: '🟠'.repeat(2_049) })).toThrow('astra-telegram:invalid-text');
  });
});
