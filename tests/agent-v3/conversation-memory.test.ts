import path from 'node:path';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationMemoryHost } from '../fixtures/agent-v3/conversation-memory-host';
import { oscarBridgeHost, oscarBridgeMarker, oscarBridgeRequest } from '../fixtures/agent-v3/oscar-bridge-host';
import type { OscarPersistedMessage } from '../../src/oscar-turn/coordinator';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const parent = await realpath('.test-tmp');
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root).startsWith('astra-v3-oscar-memory-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(oscarBridgeMarker);
    await rm(root, { recursive: true, force: false });
  }
});
async function fixture() {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-memory-'))); roots.push(root);
  await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
  await writeFile(path.join(root, 'selected.txt'), 'Синтетическая история 🟠', { flag: 'wx' });
  return root;
}
function message(content: string, messageId = 'user_message'): OscarPersistedMessage {
  return { conversationId: 'conversation', messageId, role: 'user', content, contentMode: 'exact', turnId: 'turn_one',
    provenance: { schemaVersion: 'monarch.message-provenance.v1', origin: 'user', verification: 'user-assertion', turnId: 'turn_one' } };
}

describe('Astra causal delivery through the real Python conversation store', () => {
  it('derives exact delivery from the durable Astra owner for pre-exact-mode outbox records', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    const host = await oscarBridgeHost(root, { persistMessage: memory.persist });
    try {
      const list = host.persistentStore.listPendingOutbox.bind(host.persistentStore);
      // Simulate the earlier serialized payload shape, not another runtime owner.
      vi.spyOn(host.persistentStore, 'listPendingOutbox').mockImplementation(async (...args) => {
        const items = await list(...args);
        for (const item of items) if (item.kind === 'persist-message') delete item.payload.contentMode;
        return items;
      });
      await host.start(); const source = '  Прочитай выбранный файл.\n';
      const turn = (await host.coordinator.submit({ ...oscarBridgeRequest(), text: source })).turn; await host.flush();
      expect((await memory.history()).messages[0]!.content).toBe(source);
      expect(host.bridge.find((await host.coordinator.getTurn(turn.id))!.turn)!.message!.delivery).toBe('acknowledged');
    } finally { await host.close(); await memory.close(); }
  });
  it.each(['', ' \t\r\n', '  Точные байты 🟠\r\n'])('persists source and literal reply %j, restores history, approves once', async content => {
    const root = await fixture(); let memory = await conversationMemoryHost(root);
    let host = await oscarBridgeHost(root, { persistMessage: memory.persist });
    try {
      await host.start(); const dispatch = vi.spyOn(host.kernel, 'executeActionProposal');
      const source = '  ' + oscarBridgeRequest('reply').text + ' 🟠\n';
      const submitted = await host.coordinator.submit({ ...oscarBridgeRequest('reply'), text: source }); await host.flush();
      let turn = (await host.coordinator.getTurn(submitted.turn.id))!.turn;
      const question = host.bridge.find(turn)!.question!; expect(question).toBeDefined();
      expect((await memory.history()).messages.map(row => row.content)).toEqual([source, question.text]);
      await host.coordinator.submitAstraInput(turn.id, 'desktop', { kind: 'reply', reply: {
        requestId: 'content_request', questionId: question.id, questionDigest: question.digest, messageId: 'literal_message', text: content,
      } });
      await host.flush(); turn = (await host.coordinator.getTurn(turn.id))!.turn;
      const view = host.bridge.find(turn)!;
      const approval = view.approval!; expect(approval, JSON.stringify({ view, pending: await host.persistentStore.listPendingOutbox(new Date(Date.now() + 100000)), history: await memory.history() })).toBeDefined();
      expect(dispatch).toHaveBeenCalledTimes(1);
      const before = await memory.history(); expect(before.messages.find(row => row.client_message_id === 'literal_message')!.content).toBe(content);
      expect(await host.persistentStore.listPendingOutbox(new Date(Date.now() + 100000))).toEqual([]);
      await host.close(); await memory.close();
      memory = await conversationMemoryHost(root); host = await oscarBridgeHost(root, { persistMessage: memory.persist });
      const resumedDispatch = vi.spyOn(host.kernel, 'executeActionProposal'); await host.start(); await host.flush();
      expect((await memory.history()).messages).toEqual(before.messages); expect(resumedDispatch).not.toHaveBeenCalled();
      await host.coordinator.submitAstraInput(turn.id, 'desktop', { kind: 'decide', decision: {
        approvalId: approval.id, approvalDigest: approval.digest, messageId: 'approve_message', decision: 'approve',
      } });
      await host.flush(); turn = (await host.coordinator.getTurn(turn.id))!.turn;
      expect(turn.status).toBe('succeeded'); expect(resumedDispatch).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(root, 'Новый отчёт.txt'), 'utf8')).toBe(content);
      const after = await memory.history(); expect(after.messages).toHaveLength(5);
      expect(after.messages.at(-1)!.provenance.verification).toBe('system-state');
      expect(host.bridge.find(turn)!.message!.delivery).toBe('acknowledged');
      expect(await host.persistentStore.listPendingOutbox(new Date(Date.now() + 100000))).toEqual([]);
      expect(host.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
      expect((await memory.evidence()).productMainImported).toBe(false);
      await expect(readFile(path.join(root, 'deliveries.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await host.close(); await memory.close(); }
  }, 20000);

  it('keeps two conversation histories distinct on one runtime and pages the actual SQLite history', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    const host = await oscarBridgeHost(root, { persistMessage: memory.persist });
    try {
      await host.start(); const dispatch = vi.spyOn(host.kernel, 'executeActionProposal');
      const first = await host.coordinator.submit(oscarBridgeRequest()); await host.flush();
      const second = await host.coordinator.submit({ ...oscarBridgeRequest(), conversationId: 'conversation_two',
        clientRequestId: 'second_request', inputMessageId: 'second_input', text: '  Прочитай выбранный файл. Второй разговор.\n' }); await host.flush();
      expect(dispatch).toHaveBeenCalledTimes(2);
      const a = await memory.history(), b = await memory.history('conversation_two');
      expect(a.messages).toHaveLength(2); expect(b.messages).toHaveLength(2);
      expect(a.messages.every(row => row.turn_id === first.turn.id)).toBe(true);
      expect(b.messages.every(row => row.turn_id === second.turn.id)).toBe(true);
      const page = await memory.history('conversation_two', 1);
      expect(page.messages).toEqual([b.messages[1]]); expect(page.message_page.has_more).toBe(true);
      expect((await memory.history('conversation_two', 1, page.message_page.next_before!)).messages).toEqual([b.messages[0]]);
      await expect(memory.history('unadmitted')).rejects.toThrow();
      expect(host.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
    } finally { await host.close(); await memory.close(); }
  });

  it('replays a committed source after response loss and process restart without duplicate rows', async () => {
    const root = await fixture(); let memory = await conversationMemoryHost(root);
    const source = message('  Источник с пробелами 🟠\n');
    try {
      // Actual committed write; its receipt is deliberately discarded by transport.
      await memory.persist(source); await memory.close(); memory = await conversationMemoryHost(root);
      await expect(memory.persist(source)).resolves.toEqual({ disposition: 'duplicate' });
      await expect(memory.persist({ ...source, content: source.content.trim() })).rejects.toThrow();
      expect((await memory.history()).messages.map(row => row.content)).toEqual([source.content]);
      await expect(memory.persist({ ...source, conversationId: 'conversation_two' })).rejects.toThrow();
      await expect(memory.history('conversation_two')).rejects.toMatchObject({ statusCode: 404 });
    } finally { await memory.close(); }
  });

  it('keeps exact create confirmation even when the original text directly asks to create a file', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    const host = await oscarBridgeHost(root, { persistMessage: memory.persist });
    try {
      await host.start(); const dispatch = vi.spyOn(host.kernel, 'executeActionProposal');
      const source = '  Создай файл: точный ответ последует. 🟠\n';
      let turn = (await host.coordinator.submit({ ...oscarBridgeRequest('reply'), text: source })).turn;
      await host.flush(); const question = host.bridge.find((await host.coordinator.getTurn(turn.id))!.turn)!.question!;
      await host.coordinator.submitAstraInput(turn.id, 'desktop', { kind: 'reply', reply: {
        requestId: 'direct_request', questionId: question.id, questionDigest: question.digest, messageId: 'direct_reply', text: '',
      } }); await host.flush(); turn = (await host.coordinator.getTurn(turn.id))!.turn;
      expect(turn.status).toBe('waiting-for-approval');
      const approval = host.bridge.find(turn)!.approval!; expect(approval).toBeDefined();
      await expect(readFile(path.join(root, 'Новый отчёт.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await host.coordinator.submitAstraInput(turn.id, 'desktop', { kind: 'decide', decision: {
        approvalId: approval.id, approvalDigest: approval.digest, messageId: 'direct_approve', decision: 'approve',
      } });
      await host.flush(); turn = (await host.coordinator.getTurn(turn.id))!.turn;
      expect(turn.status).toBe('succeeded');
      expect(dispatch).toHaveBeenCalledTimes(2); expect(await readFile(path.join(root, 'Новый отчёт.txt'), 'utf8')).toBe('');
      const history = await memory.history(); expect(history.messages).toHaveLength(5);
      expect(history.messages[0]!.content).toBe(source); expect(history.messages[2]!.content).toBe('');
      expect(host.bridge.find(turn)!.message!.delivery).toBe('acknowledged');
    } finally { await host.close(); await memory.close(); }
  });

  it('retains legacy trimming/blank rejection and refuses exact replay over previously normalized content', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    try {
      const source = message('  legacy\n'); delete source.contentMode;
      await expect(memory.persist(source)).resolves.toEqual({ disposition: 'created' });
      expect((await memory.history()).messages[0]!.content).toBe('legacy');
      await expect(memory.persist({ ...source, contentMode: 'exact' })).rejects.toThrow();
      await expect(memory.client.appendConversationMessage('conversation', { role: 'user', content: ' \n' })).rejects.toThrow();
      await expect(memory.client.appendConversationMessage('conversation', { role: 'user', content: '', content_mode: 'exact' })).rejects.toThrow();
      await expect(memory.persist(message('\ud800', 'invalid_unicode'))).rejects.toThrow();
      expect((await memory.history()).messages).toHaveLength(1);
    } finally { await memory.close(); }
  });

  it.each(['created', 'duplicate'])('does not accept a legacy %s receipt as exact persistence', async disposition => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    try {
      const source = message('  receipt\n'); if (disposition === 'duplicate') await memory.persist(source);
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/messages')) {
          const body = await response.json() as Record<string, unknown>; delete body.content_mode; delete body.content_sha256;
          return Response.json(body, { status: response.status });
        }
        return response;
      });
      await expect(memory.persist(source)).rejects.toThrow('did not confirm exact');
      expect((await memory.history()).messages[0]!.content).toBe(source.content);
    } finally { await memory.close(); }
  });

  it.each(['causal', 'legacy-adapter'])('handles a late certificate after a newer user message through %s', async mode => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    const host = await oscarBridgeHost(root, { persistMessage: async source => {
      if (source.astraCertificateDigest) await memory.persist({ ...message('Новый вопрос', 'newer_user'), turnId: 'newer_turn',
        provenance: { schemaVersion: 'monarch.message-provenance.v1', origin: 'user', verification: 'user-assertion', turnId: 'newer_turn' } });
      const legacy = { ...source }; delete legacy.historyLinkMode;
      return memory.persist(mode === 'legacy-adapter' ? legacy : source);
    } });
    try {
      await host.start(); const turn = (await host.coordinator.submit(oscarBridgeRequest())).turn; await host.flush();
      const result = host.bridge.find((await host.coordinator.getTurn(turn.id))!.turn)!.message!;
      const history = await memory.history();
      const pending = await host.persistentStore.listPendingOutbox(new Date(Date.now() + 100000));
      if (mode === 'causal') {
        expect(result.delivery).toBe('acknowledged'); expect(history.messages).toHaveLength(3); expect(pending).toEqual([]);
        expect(history.messages.at(-1)).toMatchObject({ turn_id: turn.id, causal_parent_id: turn.inputMessageId });
      } else {
        expect(result.delivery).not.toBe('acknowledged'); expect(history.messages).toHaveLength(2);
        expect(pending.some(item => item.kind === 'persist-message' && item.lastError === 'astra-message-superseded-before-delivery')).toBe(true);
      }
    } finally { await host.close(); await memory.close(); }
  });

  it('keeps missing-source and no-recreation prerequisites atomic, without leaving empty conversations', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    try {
      await expect(memory.client.appendConversationMessage('conversation_two', {
        role: 'assistant', content: 'Delayed result', content_mode: 'exact', client_message_id: 'terminal', turn_id: 'turn',
        required_previous_message_id: 'missing_user',
      })).rejects.toMatchObject({ statusCode: 409, code: 'conversation-message-prerequisite-pending' });
      await expect(memory.history('conversation_two')).rejects.toMatchObject({ statusCode: 404 });
      await expect(memory.persist({ ...message('source'), conversationId: 'conversation_two', createConversationIfMissing: false }))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(memory.history('conversation_two')).rejects.toMatchObject({ statusCode: 404 });
    } finally { await memory.close(); }
  });

  it('delivers two real Turns in reversed result order without repeating Kernel work or changing causal parents', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    const host = await oscarBridgeHost(root, { persistMessage: memory.persist });
    try {
      const find = host.bridge.find.bind(host.bridge); let holdFirstProjection = true;
      vi.spyOn(host.bridge, 'find').mockImplementation(turn => {
        const view = find(turn);
        if (holdFirstProjection && turn.inputMessageId === 'source_message' && view) delete view.message;
        return view;
      });
      const dispatch = vi.spyOn(host.kernel, 'executeActionProposal'); await host.start();
      const first = (await host.coordinator.submit(oscarBridgeRequest())).turn; await host.flush();
      const second = (await host.coordinator.submit({ ...oscarBridgeRequest(), clientRequestId: 'second', inputMessageId: 'second_user' })).turn;
      await host.flush(); expect((await host.coordinator.getTurn(second.id))!.turn.status).toBe('succeeded');
      expect((await memory.history()).messages.map(row => row.role)).toEqual(['user', 'user', 'assistant']);
      holdFirstProjection = false; await host.flush();
      const history = await memory.history(); expect(history.messages).toHaveLength(4);
      expect(history.messages[2]).toMatchObject({ turn_id: second.id, causal_parent_id: 'second_user' });
      expect(history.messages[3]).toMatchObject({ turn_id: first.id, causal_parent_id: 'source_message' });
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(host.bridge.find((await host.coordinator.getTurn(first.id))!.turn)!.message!.delivery).toBe('acknowledged');
      expect(await host.persistentStore.listPendingOutbox(new Date(Date.now() + 100000))).toEqual([]);
    } finally { await host.close(); await memory.close(); }
  });

  it('validates causal parents by conversation, Turn and user role, then preserves the link across restart/replay', async () => {
    const root = await fixture(); let memory = await conversationMemoryHost(root);
    const source = message('Exact source');
    const reply = { role: 'assistant' as const, content: '  late reply\n', content_mode: 'exact' as const,
      client_message_id: 'causal_reply', turn_id: source.turnId, causal_parent_id: source.messageId };
    try {
      await expect(memory.client.appendConversationMessage('conversation', reply))
        .rejects.toMatchObject({ code: 'conversation-message-prerequisite-pending' });
      await expect(memory.history()).rejects.toMatchObject({ statusCode: 404 });
      await memory.persist(source);
      await expect(memory.client.appendConversationMessage('conversation_two', reply))
        .rejects.toMatchObject({ code: 'conversation-causal-parent-mismatch' });
      await expect(memory.history('conversation_two')).rejects.toMatchObject({ statusCode: 404 });
      await expect(memory.client.appendConversationMessage('conversation', { ...reply, turn_id: 'different_turn' }))
        .rejects.toMatchObject({ code: 'conversation-causal-parent-mismatch' });
      await expect(memory.client.appendConversationMessage('conversation', reply)).resolves.toMatchObject({ disposition: 'created' });
      await expect(memory.client.appendConversationMessage('conversation', { ...reply, client_message_id: 'other_reply', causal_parent_id: reply.client_message_id }))
        .rejects.toMatchObject({ code: 'conversation-causal-parent-mismatch' });
      const before = await memory.history(); expect(before.messages[1]!.causal_parent_id).toBe(source.messageId);
      await memory.close(); memory = await conversationMemoryHost(root);
      await expect(memory.client.appendConversationMessage('conversation', reply)).resolves.toMatchObject({ disposition: 'duplicate' });
      expect((await memory.history()).messages).toEqual(before.messages);
      await expect(memory.client.appendConversationMessage('conversation', { ...reply, causal_parent_id: 'different_parent' }))
        .rejects.toMatchObject({ code: 'client-message-reused' });
      const { content_mode: _exactMode, ...legacyReply } = reply;
      for (const invalid of [ { ...reply, role: 'user' as const }, legacyReply,
        { ...reply, required_previous_message_id: source.messageId }, { ...reply, causal_parent_id: reply.client_message_id } ]) {
        await expect(memory.client.appendConversationMessage('conversation', invalid)).rejects.toMatchObject({ statusCode: 422 });
      }
      expect((await memory.history()).messages).toHaveLength(2);
    } finally { await memory.close(); }
  });

  it('requires an explicit causal-parent receipt even when exact content was persisted', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    try {
      const source = message('source'); await memory.persist(source);
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/messages')) {
          const body = await response.json() as Record<string, unknown>; delete body.causal_parent_id;
          return Response.json(body, { status: response.status });
        }
        return response;
      });
      await expect(memory.client.appendConversationMessage('conversation', { role: 'assistant', content: 'reply', content_mode: 'exact',
        client_message_id: 'reply', turn_id: source.turnId, causal_parent_id: source.messageId })).rejects.toThrow('causal conversation');
      expect((await memory.history()).messages[1]!.causal_parent_id).toBe(source.messageId);
    } finally { await memory.close(); }
  });

  it('retains an empty initial exact message with a nonempty title and rejects an oversized message', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    try {
      await memory.persist(message('')); expect((await memory.history()).title).toBe('Новый чат');
      await expect(memory.persist(message('', 'user_message'))).resolves.toEqual({ disposition: 'duplicate' });
      await expect(memory.persist(message('x'.repeat(20001), 'oversized'))).rejects.toMatchObject({ statusCode: 422 });
      expect((await memory.history()).messages).toHaveLength(1);
    } finally { await memory.close(); }
  });

  it('rejects a mismatching exact digest even when the remaining created receipt is correct', async () => {
    const root = await fixture(), memory = await conversationMemoryHost(root);
    try {
      const original = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
        const response = await original(...args);
        if (String(args[0]).endsWith('/messages')) {
          const body = await response.json() as Record<string, unknown>; body.content_sha256 = '0'.repeat(64);
          return Response.json(body, { status: response.status });
        }
        return response;
      });
      await expect(memory.persist(message('unchanged'))).rejects.toThrow('did not confirm exact');
      expect((await memory.history()).messages).toHaveLength(1);
    } finally { await memory.close(); }
  });
});
