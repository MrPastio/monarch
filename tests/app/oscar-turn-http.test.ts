import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';
import {
  InMemoryOscarTurnStore,
  OscarAttachmentStore,
  OscarDataEgressConsentStore,
  OscarTurnCoordinator,
  type OscarAnswerExecutionInput,
  type OscarAnswerExecutorEvent,
  type OscarPersistedMessage,
} from '../../src/oscar-turn';
import type {
  MonarchComponentManagerSnapshot,
  MonarchModelComponentManager,
} from '../../src/modules/models/component-manager';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Oscar Turn HTTP API', () => {
  it('blocks a new turn while Monarch installs the required local model', async () => {
    const answerExecutor = vi.fn(async () => answerStream());
    const ensureRequiredModel = vi.fn(async () => downloadingComponentSnapshot());
    const modelComponentManager = {
      snapshot: downloadingComponentSnapshot,
      startAutomaticRepair: vi.fn(),
      ensureRequiredModel,
      stop: vi.fn(),
    } as unknown as MonarchModelComponentManager;
    const setup = await startFixture({ answerExecutor, modelComponentManager });
    try {
      const response = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_model_install_gate_1',
        conversationId: 'conversation_model_install_gate_1',
        text: 'Привет, Oscar',
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: 'required-model-not-ready',
        component: { phase: 'downloading', progress: 0.25 },
      });
      expect(ensureRequiredModel).toHaveBeenCalledTimes(1);
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await setup.close();
    }
  });

  it('binds the real image capability without turning a capability question into generation', async () => {
    const setup = await startFixture();
    try {
      const response = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_image_capability_1',
        conversationId: 'conversation_image_capability_1',
        text: 'Ты умеешь создавать картинки?',
      });
      expect(response.status).toBe(202);
      const body = await response.json() as { turn: { request: { modifiers: Record<string, unknown> } } };
      expect(body.turn.request.modifiers).toMatchObject({
        imageGenerationCapability: {
          schemaVersion: 1,
          available: true,
          surface: 'images',
          primaryProvider: { id: 'perchance-interactive', mode: 'interactive' },
          emergencyProvider: { id: 'aihorde-anonymous', mode: 'emergency' },
        },
      });
      expect(body.turn.request.modifiers).not.toHaveProperty('imageGeneration');
    } finally {
      await setup.close();
    }
  });

  it('binds the server-owned Computer Use capability snapshot to relevant Turns', async () => {
    const setup = await startFixture();
    try {
      const response = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_computer_capability_1',
        conversationId: 'conversation_computer_capability_1',
        text: 'Что ты умеешь делать через Computer Use?',
      });
      expect(response.status).toBe(202);
      const body = await response.json() as { turn: { request: { modifiers: Record<string, any> } } };
      expect(body.turn.request.modifiers.computerUseCapability).toMatchObject({
        schemaVersion: 1,
        available: expect.any(Boolean),
        enabled: expect.any(Boolean),
        surface: 'computer-use',
        invocation: '@Computer Use',
        ownCursor: true,
        observeAnalyzeAct: true,
        emergencyShortcut: 'Ctrl+Alt+Escape',
      });
    } finally {
      await setup.close();
    }
  });

  it('does not probe or bind Computer Use state for an unrelated ordinary chat turn', async () => {
    const setup = await startFixture();
    try {
      const readSnapshot = vi.spyOn(setup.app, 'readComputerUseCapabilitySnapshot');
      const response = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_no_computer_capability_1',
        conversationId: 'conversation_no_computer_capability_1',
        text: 'Привет!',
      });
      expect(response.status).toBe(202);
      const body = await response.json() as { turn: { request: { modifiers: Record<string, any> } } };
      expect(body.turn.request.modifiers.computerUseCapability).toBeUndefined();
      expect(readSnapshot).not.toHaveBeenCalled();
    } finally {
      await setup.close();
    }
  });

  it('binds image-generation policy to the durable Turn on the server', async () => {
    const setup = await startFixture();
    try {
      const response = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_image_policy_1',
        conversationId: 'conversation_image_policy_1',
        text: 'Создай эротическое изображение взрослого персонажа',
      });
      expect(response.status).toBe(202);
      const body = await response.json() as { turn: { mode: string; request: { modifiers: Record<string, unknown> } } };
      expect(body.turn).toMatchObject({
        mode: 'answer',
        request: {
          modifiers: {
            imageGeneration: {
              schemaVersion: 1,
              contentRating: 'nsfw',
              disposition: 'provider-consent-required',
              providerId: 'perchance-interactive',
            },
          },
        },
      });
    } finally {
      await setup.close();
    }
  });

  it('returns a replayable terminal SSE outcome with model provenance', async () => {
    const setup = await startFixture();
    try {
      const createdResponse = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_answer_1',
        conversationId: 'conversation_http_1',
        text: 'Сколько будет два плюс два?',
      });
      expect(createdResponse.status).toBe(202);
      const created = await createdResponse.json() as { turn: { id: string } };

      const stream = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}/events`, {
        headers: { Accept: 'text/event-stream' },
      });
      const sse = await readWithin(stream, 2_000);
      expect(sse).toContain('event: answer.delta');
      expect(sse).toContain('event: turn.outcome');
      expect(sse).toContain('"outcome":"answered"');

      const replay = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}/events?format=json`);
      const body = await replay.json() as { turn: { status: string; outcome: { kind: string } }; events: Array<{ type: string }> };
      expect(body.turn).toMatchObject({ status: 'succeeded', outcome: { kind: 'answered' } });
      expect(body.events.at(-1)?.type).toBe('turn.outcome');
      await waitFor(() => setup.persisted.some((message) => message.role === 'assistant'));
      expect(setup.persisted.find((message) => message.role === 'assistant')?.provenance.verification)
        .toBe('unverified-model');
    } finally {
      await setup.close();
    }
  });

  it('delivers an exact answer delta before done and replays byte-identical content', async () => {
    let releaseDone = () => undefined;
    const doneGate = new Promise<void>((resolve) => { releaseDone = resolve; });
    const exact = 'Первая часть.  \n\nВторая часть.';
    const setup = await startFixture({
      answerExecutor: async () => (async function* () {
        yield { type: 'token' as const, token: 'Первая часть.  ' };
        await doneGate;
        yield { type: 'token' as const, token: '\n\nВторая часть.' };
        yield { type: 'done' as const };
      })(),
    });
    try {
      const createdResponse = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_incremental_1',
        conversationId: 'conversation_incremental_1',
        text: 'Ответь двумя частями',
      });
      const created = await createdResponse.json() as { turn: { id: string } };
      const stream = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}/events`, {
        headers: { Accept: 'text/event-stream' },
      });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let streamed = '';
      while (!streamed.includes('event: answer.delta')) {
        const chunk = await readReaderWithin(reader, 1_000);
        streamed += decoder.decode(chunk.value, { stream: !chunk.done });
        if (chunk.done) break;
      }
      expect(streamed).toContain('event: answer.delta');
      expect(streamed).not.toContain('event: turn.outcome');
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseDone();
      while (true) {
        const chunk = await readReaderWithin(reader, 1_000);
        streamed += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        if (chunk.done) break;
      }
      reader.releaseLock();
      expect(streamed).toContain('event: turn.outcome');

      const replay = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}/events?format=json`);
      const body = await replay.json() as {
        turn: { outcome: { summary: string } };
        events: Array<{ type: string; payload: Record<string, unknown> }>;
      };
      expect(reconstructHttpAnswer(body.events)).toBe(exact);
      expect(body.turn.outcome.summary).toBe(exact);
      await waitFor(() => setup.persisted.some((message) => message.role === 'assistant'));
      expect(setup.persisted.find((message) => message.role === 'assistant')?.content).toBe(exact);
    } finally {
      releaseDone();
      await setup.close();
    }
  });

  it('preserves the attested Desktop principal from POST through no-Origin SSE and replay reads', async () => {
    const setup = await startFixture({
      httpSecurity: {
        apiToken: 'oscar-desktop-session-token',
        desktopAttestationToken: 'oscar-desktop-attestation-token',
      },
    });
    const desktopMutationHeaders = {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:4317',
      'X-Monarch-Desktop-Attestation': 'oscar-desktop-attestation-token',
    };
    const desktopReadHeaders = {
      'X-Monarch-Desktop-Attestation': 'oscar-desktop-attestation-token',
    };
    try {
      const createdResponse = await fetch(`${setup.baseUrl}/api/oscar/turns`, {
        method: 'POST',
        headers: desktopMutationHeaders,
        body: JSON.stringify({
          version: 1,
          clientRequestId: 'desktop_principal_turn_1',
          conversationId: 'desktop_principal_conversation_1',
          text: 'ало',
          surface: 'desktop',
        }),
      });
      expect(createdResponse.status).toBe(202);
      const created = await createdResponse.json() as { turn: { id: string; source: string } };
      expect(created.turn.source).toBe('desktop');

      const stream = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}/events`, {
        headers: { ...desktopReadHeaders, Accept: 'text/event-stream' },
      });
      expect(stream.status).toBe(200);
      expect(await readWithin(stream, 2_000)).toContain('event: turn.outcome');

      const replay = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}/events?format=json`, {
        headers: desktopReadHeaders,
      });
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        turn: { source: 'desktop', status: 'succeeded', outcome: { kind: 'answered' } },
      });

      const missingAttestation = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}`, {
        headers: { 'X-Monarch-Session': 'oscar-desktop-session-token' },
      });
      expect(missingAttestation.status).toBe(403);
      await expect(missingAttestation.json()).resolves.toMatchObject({ error: 'turn-source-mismatch' });

      const mismatchedOrigin = await fetch(`${setup.baseUrl}/api/oscar/turns/${created.turn.id}`, {
        headers: { ...desktopReadHeaders, Origin: 'https://attacker.invalid' },
      });
      expect(mismatchedOrigin.status).toBe(403);
      await expect(mismatchedOrigin.json()).resolves.toMatchObject({ error: 'untrusted-origin' });
    } finally {
      await setup.close();
    }
  });

  it('blocks operational requests without Agent Runtime and never invokes chat', async () => {
    const answerExecutor = vi.fn(async () => emptyStream());
    const setup = await startFixture({ answerExecutor });
    try {
      const response = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_audit_1',
        conversationId: 'conversation_http_1',
        text: 'проведи аудит папок на диске D',
      });
      const body = await response.json() as { turn: { status: string; outcome: { kind: string; summary: string } } };

      expect(response.status).toBe(200);
      expect(body.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(body.turn.outcome.summary).toContain('не был отправлен в обычный чат');
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await setup.close();
    }
  });

  it('reserves cancellation by client request before POST and exposes the exact durable result', async () => {
    const answerExecutor = vi.fn(async () => answerStream());
    const setup = await startFixture({ answerExecutor });
    try {
      const clientRequestId = 'http_cancel_before_turn_1';
      const reservation = await postJson(`${setup.baseUrl}/api/oscar/turn-cancellations`, {
        version: 1,
        clientRequestId,
        privacyMode: 'persistent',
      });
      expect(reservation.status).toBe(200);
      await expect(reservation.json()).resolves.toMatchObject({
        cancellation: { clientRequestId, reserved: true },
      });

      const created = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId,
        conversationId: 'conversation_http_cancel_before_turn',
        inputMessageId: 'message_http_cancel_before_turn',
        text: 'Проверь',
      });
      const createdBody = await created.json() as { turn: { id: string; status: string } };
      expect(createdBody.turn.status).toBe('cancelled');
      expect(answerExecutor).not.toHaveBeenCalled();

      const recovered = await fetch(
        `${setup.baseUrl}/api/oscar/turns?clientRequestId=${clientRequestId}&privacyMode=persistent`,
      );
      expect(recovered.status).toBe(200);
      await expect(recovered.json()).resolves.toMatchObject({
        turn: { id: createdBody.turn.id, clientRequestId, status: 'cancelled' },
      });

      const wrongPrivacy = await fetch(
        `${setup.baseUrl}/api/oscar/turns?clientRequestId=${clientRequestId}&privacyMode=encrypted`,
      );
      expect(wrongPrivacy.status).toBe(404);
    } finally {
      await setup.close();
    }
  });

  it('creates a Desktop-only ephemeral incognito conversation and discards every volatile Turn', async () => {
    const setup = await startFixture({
      httpSecurity: {
        apiToken: 'incognito-session-token',
        desktopAttestationToken: 'incognito-attestation-token',
      },
    });
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:4317',
      'X-Monarch-Desktop-Attestation': 'incognito-attestation-token',
    };
    try {
      const sessionResponse = await fetch(`${setup.baseUrl}/api/oscar/incognito-conversations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 1 }),
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json() as { conversationId: string };
      expect(session.conversationId).toMatch(/^incognito_[a-f0-9]{32}$/u);
      const unusedSessionDiscard = await fetch(
        `${setup.baseUrl}/api/oscar/incognito-conversations/${encodeURIComponent(session.conversationId)}`,
        { method: 'DELETE', headers, body: JSON.stringify({ version: 1 }) },
      );
      expect(unusedSessionDiscard.status).toBe(200);

      let activeConversationId = '';
      for (const [index, text] of ['Привет', 'Продолжи ответ'].entries()) {
        const turn = await fetch(`${setup.baseUrl}/api/oscar/turns`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            version: 1,
            clientRequestId: `incognito_turn_${index}`,
            ...(activeConversationId ? { conversationId: activeConversationId } : {}),
            text,
            privacyMode: 'incognito',
            surface: 'desktop',
            history: index === 0 ? [] : [{ role: 'assistant', content: 'Четыре.' }],
          }),
        });
        expect(turn.status).toBe(202);
        const checkpoint = await turn.json() as { turn: { conversationId: string } };
        activeConversationId ||= checkpoint.turn.conversationId;
        expect(checkpoint.turn.conversationId).toBe(activeConversationId);
      }

      expect(await setup.persistentStore.listTurns()).toHaveLength(0);
      expect(await setup.volatileStore.listTurns()).toHaveLength(2);
      expect(setup.persisted).toHaveLength(0);

      const discarded = await fetch(
        `${setup.baseUrl}/api/oscar/incognito-conversations/${encodeURIComponent(activeConversationId)}`,
        { method: 'DELETE', headers, body: JSON.stringify({ version: 1 }) },
      );
      expect(discarded.status).toBe(200);
      await expect(discarded.json()).resolves.toMatchObject({ discardedTurns: 2 });
      expect(await setup.volatileStore.listTurns()).toHaveLength(0);

      const apiAttempt = await fetch(`${setup.baseUrl}/api/oscar/incognito-conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Session': 'incognito-session-token',
        },
        body: JSON.stringify({ version: 1 }),
      });
      expect(apiAttempt.status).toBe(403);
      await expect(apiAttempt.json()).resolves.toMatchObject({ error: 'desktop-only-incognito' });
    } finally {
      await setup.close();
    }
  });

  it('forces every new Desktop turn into volatile storage under zero-retention DEV policy', async () => {
    const setup = await startFixture({
      httpSecurity: {
        apiToken: 'zero-retention-session-token',
        desktopAttestationToken: 'zero-retention-attestation-token',
      },
      devSettings: {
        zeroRetentionEnabled: true,
        internetEnabled: false,
        historyContextEnabled: false,
      },
    });
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:4317',
      'X-Monarch-Desktop-Attestation': 'zero-retention-attestation-token',
    };
    try {
      const response = await fetch(`${setup.baseUrl}/api/oscar/turns`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          clientRequestId: 'zero_retention_turn_1',
          conversationId: 'persistent_client_conversation',
          privacyMode: 'persistent',
          surface: 'desktop',
          text: 'Этот текст не должен попасть в durable store',
          history: [{ role: 'assistant', content: 'durable history must be stripped' }],
          modifiers: {
            webSearch: true,
            researchMode: 'deep',
            dataEgressConsentId: 'stale-consent',
          },
        }),
      });
      expect(response.status).toBe(202);
      const body = await response.json() as {
        turn: { privacyMode: string; request: { history?: unknown[]; modifiers: Record<string, unknown> } };
      };
      expect(body.turn).toMatchObject({
        privacyMode: 'incognito',
        request: { modifiers: { webSearch: false, researchMode: 'off' } },
      });
      expect(body.turn.request.history).toBeUndefined();
      expect(body.turn.request.modifiers).not.toHaveProperty('dataEgressConsentId');
      expect(await setup.persistentStore.listTurns()).toHaveLength(0);
      expect(await setup.volatileStore.listTurns()).toHaveLength(1);
      expect(setup.persisted).toHaveLength(0);

      const consent = await fetch(`${setup.baseUrl}/api/oscar/data-egress-consents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          clientRequestId: 'zero_retention_consent_1',
          conversationId: 'persistent_client_conversation',
          privacyMode: 'persistent',
          surface: 'desktop',
          text: 'fresh search text',
          attachmentIds: [],
          webSearch: true,
          researchMode: 'auto',
        }),
      });
      expect(consent.status).toBe(403);
      await expect(consent.json()).resolves.toMatchObject({ error: 'oscar-internet-disabled' });
    } finally {
      await setup.close();
    }
  });

  it('derives the source server-side and rejects a claimed Desktop surface from API', async () => {
    const setup = await startFixture();
    try {
      const response = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_spoof_1',
        conversationId: 'conversation_http_1',
        text: 'Привет',
        surface: 'desktop',
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ version: 1, error: 'untrusted-oscar-source' });
    } finally {
      await setup.close();
    }
  });

  it('uploads a bounded immutable attachment ref and binds it to the Turn conversation', async () => {
    const setup = await startFixture();
    try {
      const uploaded = await postJson(`${setup.baseUrl}/api/oscar/attachments`, {
        version: 1,
        conversationId: 'conversation_http_1',
        privacyMode: 'persistent',
        name: 'pixel.png',
        mimeType: 'image/png',
        dataBase64: Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          Buffer.from('synthetic-png-fixture'),
        ]).toString('base64'),
      });
      expect(uploaded.status).toBe(201);
      const uploadBody = await uploaded.json() as { attachment: { id: string; digest: string; sizeBytes: number } };
      expect(uploadBody.attachment).toMatchObject({ digest: expect.stringMatching(/^sha256:/), sizeBytes: 29 });
      expect(JSON.stringify(uploadBody)).not.toContain('synthetic-png-fixture');

      const attachmentRead = await fetch(
        `${setup.baseUrl}/api/oscar/attachments/${encodeURIComponent(uploadBody.attachment.id)}`
        + '?conversationId=conversation_http_1&privacyMode=persistent',
      );
      expect(attachmentRead.status).toBe(200);
      await expect(attachmentRead.json()).resolves.toMatchObject({
        version: 1,
        ok: true,
        attachment: {
          id: uploadBody.attachment.id,
          digest: uploadBody.attachment.digest,
          mimeType: 'image/png',
          dataBase64: expect.any(String),
        },
      });

      const crossConversationRead = await fetch(
        `${setup.baseUrl}/api/oscar/attachments/${encodeURIComponent(uploadBody.attachment.id)}`
        + '?conversationId=conversation_http_other&privacyMode=persistent',
      );
      expect(crossConversationRead.status).toBe(409);
      await expect(crossConversationRead.json()).resolves.toMatchObject({
        version: 1,
        error: 'attachment-binding-mismatch',
      });

      const created = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_attachment_1',
        conversationId: 'conversation_http_1',
        text: 'Что на этом изображении?',
        attachmentIds: [uploadBody.attachment.id],
      });
      expect(created.status).toBe(202);
      await waitFor(() => setup.persisted.some((message) => message.role === 'user' && message.attachments?.length));
      expect(setup.persisted.find((message) => message.role === 'user')?.attachments).toEqual([
        expect.objectContaining({ id: uploadBody.attachment.id, digest: uploadBody.attachment.digest }),
      ]);
    } finally {
      await setup.close();
    }
  });

  it('requires a structured exact-binding data-egress decision before web execution', async () => {
    const answerExecutor = vi.fn(async () => answerStream());
    const setup = await startFixture({ answerExecutor });
    try {
      const proposalResponse = await postJson(`${setup.baseUrl}/api/oscar/data-egress-consents`, {
        version: 1,
        clientRequestId: 'http_egress_proposal_1',
        conversationId: 'conversation_egress_http',
        privacyMode: 'persistent',
        text: 'Найди актуальные источники',
        attachmentIds: [],
        webSearch: true,
        researchMode: 'deep',
      });
      expect(proposalResponse.status).toBe(201);
      const proposal = await proposalResponse.json() as {
        consent: { id: string; canonicalBindingHash: string };
        presentation: { target: string; canonicalBindingHash: string };
      };
      expect(proposal.presentation).toMatchObject({
        target: 'Публичные интернет-источники',
        canonicalBindingHash: proposal.consent.canonicalBindingHash,
      });

      const decision = await postJson(
        `${setup.baseUrl}/api/oscar/data-egress-consents/${proposal.consent.id}/decision`,
        {
          version: 1,
          decision: 'grant',
          canonicalBindingHash: proposal.consent.canonicalBindingHash,
        },
      );
      expect(decision.status).toBe(200);

      const turn = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_egress_turn_1',
        conversationId: 'conversation_egress_http',
        text: 'Найди актуальные источники',
        modifiers: {
          webSearch: true,
          researchMode: 'deep',
          dataEgressConsentId: proposal.consent.id,
        },
      });
      expect(turn.status).toBe(202);
      const body = await turn.json() as { turn: { id: string } };
      await waitFor(async () => {
        const checkpoint = await fetch(`${setup.baseUrl}/api/oscar/turns/${body.turn.id}`).then((response) => response.json());
        return checkpoint.turn?.status === 'succeeded';
      });
      expect(answerExecutor).toHaveBeenCalledTimes(1);

      const replay = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_egress_turn_2',
        conversationId: 'conversation_egress_http',
        text: 'Найди актуальные источники',
        modifiers: {
          webSearch: true,
          researchMode: 'deep',
          dataEgressConsentId: proposal.consent.id,
        },
      });
      const replayBody = await replay.json() as { turn: { status: string; outcome: { kind: string } } };
      expect(replayBody.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(answerExecutor).toHaveBeenCalledTimes(1);
    } finally {
      await setup.close();
    }
  });

  it('retries consent decisions idempotently and revokes a grant that Stop never consumed', async () => {
    const answerExecutor = vi.fn(async () => answerStream());
    const setup = await startFixture({ answerExecutor });
    try {
      const proposalResponse = await postJson(`${setup.baseUrl}/api/oscar/data-egress-consents`, {
        version: 1,
        clientRequestId: 'http_egress_stop_race_1',
        conversationId: 'conversation_egress_stop_race',
        privacyMode: 'persistent',
        text: 'Найди свежие новости',
        attachmentIds: [],
        webSearch: true,
        researchMode: 'auto',
      });
      const proposal = await proposalResponse.json() as {
        consent: { id: string; canonicalBindingHash: string };
      };
      const decisionUrl = `${setup.baseUrl}/api/oscar/data-egress-consents/${proposal.consent.id}/decision`;
      const decisionBody = {
        version: 1,
        canonicalBindingHash: proposal.consent.canonicalBindingHash,
      };

      expect((await postJson(decisionUrl, { ...decisionBody, decision: 'grant' })).status).toBe(200);
      expect((await postJson(decisionUrl, { ...decisionBody, decision: 'grant' })).status).toBe(200);
      const revoke = await postJson(decisionUrl, { ...decisionBody, decision: 'deny' });
      expect(revoke.status).toBe(200);
      await expect(revoke.json()).resolves.toMatchObject({ consent: { status: 'denied' } });
      expect((await postJson(decisionUrl, { ...decisionBody, decision: 'deny' })).status).toBe(200);
      expect((await postJson(decisionUrl, { ...decisionBody, decision: 'grant' })).status).toBe(409);

      const turn = await postJson(`${setup.baseUrl}/api/oscar/turns`, {
        version: 1,
        clientRequestId: 'http_egress_after_stop_1',
        conversationId: 'conversation_egress_stop_race',
        text: 'Найди свежие новости',
        modifiers: {
          webSearch: true,
          researchMode: 'auto',
          dataEgressConsentId: proposal.consent.id,
        },
      });
      const turnBody = await turn.json() as { turn: { status: string; outcome: { kind: string } } };
      expect(turnBody.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await setup.close();
    }
  });
});

async function startFixture(options: {
  answerExecutor?: (input: OscarAnswerExecutionInput) => Promise<AsyncIterable<OscarAnswerExecutorEvent>>;
  httpSecurity?: { apiToken: string; desktopAttestationToken: string };
  devSettings?: Partial<{
    zeroRetentionEnabled: boolean;
    internetEnabled: boolean;
    memoryEnabled: boolean;
    historyContextEnabled: boolean;
    personalityEnabled: boolean;
    skillsEnabled: boolean;
    runtimeContextEnabled: boolean;
    qualityRegenerationEnabled: boolean;
  }>;
  modelComponentManager?: MonarchModelComponentManager;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-oscar-turn-http-'));
  roots.push(root);
  const persisted: OscarPersistedMessage[] = [];
  const persistentStore = new InMemoryOscarTurnStore();
  const volatileStore = new InMemoryOscarTurnStore();
  const attachments = new OscarAttachmentStore(path.join(root, 'runtime'));
  const dataEgressConsents = new OscarDataEgressConsentStore(path.join(root, 'runtime'));
  const coordinator = new OscarTurnCoordinator({
    persistentStore,
    volatileStore,
    agentRuntime: null,
    answerExecutor: options.answerExecutor || (async () => answerStream()),
    persistMessage: async (message) => { persisted.push(message); },
    resolveAttachments: (ids, privacy, source, conversationId) => attachments.resolve(ids, privacy, source, conversationId),
    consumeDataEgressConsent: (consentId, turn) => dataEgressConsents.consume(consentId, turn.id, {
      conversationId: turn.conversationId,
      privacyMode: turn.privacyMode,
      source: turn.source,
      text: turn.request.text,
      attachmentIds: turn.request.attachmentIds,
      webSearch: turn.request.modifiers.webSearch === true,
      researchMode: turn.request.modifiers.researchMode || 'auto',
    }).then(() => undefined),
  });
  const app = new MonarchApplication({
    workspaceRoot: root,
    enabledModules: ['workspace'],
    enableLocalSystemRouter: false,
    enableAgentRuntimeV2: false,
    oscarTurnCoordinator: coordinator,
    oscarAttachmentStore: attachments,
    oscarDataEgressConsentStore: dataEgressConsents,
    ...(options.modelComponentManager ? { modelComponentManager: options.modelComponentManager } : {}),
  });
  await app.start();
  if (options.devSettings) {
    await app.ownerDevSettingsStore.execute({
      schemaVersion: 1,
      clientRequestId: 'owner_dev_http_fixture',
      command: 'dev.update',
      scope: { type: 'chat' },
      expectedRevision: 0,
      payload: { patch: options.devSettings },
      policyDecisionHash: 'a'.repeat(64),
    });
  }
  const server = createMonarchHttpServer({
    app,
    publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
    host: '127.0.0.1',
    port: 4317,
    apiToken: options.httpSecurity?.apiToken,
    desktopAttestationToken: options.httpSecurity?.desktopAttestationToken,
    requireApiToken: Boolean(options.httpSecurity),
  });
  const baseUrl = await listen(server);
  return {
    app,
    server,
    baseUrl,
    persisted,
    persistentStore,
    volatileStore,
    close: async () => {
      await close(server);
      await app.stop();
    },
  };
}

function downloadingComponentSnapshot(): MonarchComponentManagerSnapshot {
  return {
    schemaVersion: 1,
    autoRepairEnabled: true,
    ready: false,
    requiredModel: {
      id: 'model.gemma4-fast.text',
      role: 'gemma4-fast',
      label: 'Gemma 4 Fast',
      required: true,
      phase: 'downloading',
      provider: 'Hugging Face · Unsloth',
      license: 'Apache-2.0',
      relativePath: 'gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf',
      expectedBytes: 3_356_037_216,
      downloadedBytes: 839_009_304,
      progress: 0.25,
      sha256: '90293b8cdaf9c973012bf4df8a1e92bde7d74ad66a4fe56cf905ccd563d660c5',
      error: null,
      errorCode: null,
      updatedAt: '2026-08-12T00:00:00.000Z',
    },
  };
}

async function* answerStream() {
  yield { type: 'token' as const, token: 'Четыре.' };
  yield { type: 'done' as const };
}

async function* emptyStream() {
  yield { type: 'done' as const };
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Invalid test server address.'));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readWithin(response: Response, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSE response did not settle within ${timeoutMs}ms.`)), timeoutMs);
    void response.text().then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, reject);
  });
}

function readReaderWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out reading SSE chunk.')), timeoutMs);
    void reader.read().then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function reconstructHttpAnswer(events: Array<{ type: string; payload: Record<string, unknown> }>): string {
  let content = '';
  for (const event of events) {
    if (event.type === 'answer.delta') content += String(event.payload.content || '');
    if (event.type === 'answer.replace') content = String(event.payload.content || '');
  }
  return content;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for fixture state.');
}
