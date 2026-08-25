import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OscarDataEgressConsentStore } from '../../src/oscar-turn';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OscarDataEgressConsentStore', () => {
  it('binds a one-use grant to the exact conversation, surface, prompt, attachments and modifiers', async () => {
    const root = await temporaryRoot();
    const store = new OscarDataEgressConsentStore(root);
    const binding = {
      conversationId: 'conversation_egress_1',
      privacyMode: 'persistent' as const,
      source: 'desktop' as const,
      text: 'Найди свежие источники',
      attachmentIds: ['attachment_1'],
      webSearch: true,
      researchMode: 'deep' as const,
    };
    const proposed = await store.createProposal('egress_request_1', binding);
    expect(proposed).toMatchObject({ status: 'pending', purpose: 'deep-research', attachmentCount: 1 });

    await expect(store.decide({
      consentId: proposed.id,
      source: 'api',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'grant',
    })).rejects.toMatchObject({ statusCode: 403, code: 'consent-source-mismatch' });

    await store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'grant',
    });
    await expect(store.consume(proposed.id, 'turn_wrong', {
      ...binding,
      text: 'Изменённый запрос',
    })).rejects.toMatchObject({ statusCode: 409, code: 'stale-consent-binding' });

    const consumed = await store.consume(proposed.id, 'turn_exact', binding);
    expect(consumed).toMatchObject({ status: 'consumed', consumedByTurnId: 'turn_exact' });
    await expect(store.consume(proposed.id, 'turn_exact', binding)).resolves.toMatchObject({ status: 'consumed' });
    await expect(store.consume(proposed.id, 'turn_replay', binding))
      .rejects.toMatchObject({ statusCode: 409, code: 'consent-not-granted' });
  });

  it('keeps private-mode consent volatile and clears it at shutdown', async () => {
    const root = await temporaryRoot();
    const store = new OscarDataEgressConsentStore(root);
    const binding = {
      conversationId: 'conversation_private_egress',
      privacyMode: 'incognito' as const,
      source: 'desktop' as const,
      text: 'Проверь в интернете',
      attachmentIds: [],
      webSearch: true,
      researchMode: 'auto' as const,
    };
    const proposed = await store.createProposal('private_egress_1', binding);
    await store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'grant',
    });
    store.clearVolatile();
    await expect(store.consume(proposed.id, 'turn_private', binding))
      .rejects.toMatchObject({ statusCode: 404, code: 'consent-not-found' });
  });

  it('keeps repeated decisions idempotent and lets Stop revoke only an unused grant', async () => {
    const root = await temporaryRoot();
    const store = new OscarDataEgressConsentStore(root);
    const binding = {
      conversationId: 'conversation_egress_stop_race',
      privacyMode: 'persistent' as const,
      source: 'desktop' as const,
      text: 'Найди свежие новости',
      attachmentIds: [],
      webSearch: true,
      researchMode: 'auto' as const,
    };
    const proposed = await store.createProposal('egress_stop_race_1', binding);
    const granted = await store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'grant',
    });
    await expect(store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'grant',
    })).resolves.toEqual(granted);

    const revoked = await store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'deny',
    });
    expect(revoked.status).toBe('denied');
    await expect(store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'deny',
    })).resolves.toEqual(revoked);
    await expect(store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'grant',
    })).rejects.toMatchObject({ statusCode: 409, code: 'consent-already-decided' });
    await expect(store.consume(proposed.id, 'turn_after_stop', binding))
      .rejects.toMatchObject({ statusCode: 409, code: 'consent-not-granted' });
  });

  it('never revokes a consent after it has been consumed by its exact Turn', async () => {
    const root = await temporaryRoot();
    const store = new OscarDataEgressConsentStore(root);
    const binding = {
      conversationId: 'conversation_egress_consumed',
      privacyMode: 'persistent' as const,
      source: 'desktop' as const,
      text: 'Проверь текущий курс',
      attachmentIds: [],
      webSearch: true,
      researchMode: 'auto' as const,
    };
    const proposed = await store.createProposal('egress_consumed_1', binding);
    await store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'grant',
    });
    await store.consume(proposed.id, 'turn_consumed_1', binding);

    await expect(store.decide({
      consentId: proposed.id,
      source: 'desktop',
      canonicalBindingHash: proposed.canonicalBindingHash,
      decision: 'deny',
    })).rejects.toMatchObject({ statusCode: 409, code: 'consent-already-decided' });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-egress-consent-'));
  roots.push(root);
  return root;
}
