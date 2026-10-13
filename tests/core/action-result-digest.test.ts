import { describe, expect, it } from 'vitest';
import { actionResultDigest } from '../../src/core/action-result-digest';
import { astraCapabilityResultDigest } from '../../src/agent-v3/capability-work-adapter';

describe('action result digest', () => {
  it.each([
    { ok: true, summary: 'Wrote and verified 10166 bytes.', output: { path: 'E:\Qsharp\site.html', sizeBytes: 10166, verified: true, nested: { b: 2, a: [1, 'два', null] } } },
    { ok: false, summary: 'Read failed.', error: 'x'.repeat(2048) },
    { ok: true, summary: 'Пусто', output: undefined, metadata: { ignored: true } },
  ])('is byte-identical to the digest Astra observes (%#)', (result) => {
    expect(actionResultDigest(result as any)).toBe(astraCapabilityResultDigest(result as any));
  });
});

describe('agent receipts across a restart', () => {
  it('keeps a finished read receipt with the digest its certificate needs', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const os = await import('node:os'); const path = await import('node:path');
    const { MonarchActionLedger } = await import('../../src/core/action-ledger');
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-ledger-restart-'));
    const file = path.join(root, 'action-ledger.json');
    const ledger = new MonarchActionLedger(1000, file);
    const request = { id: 'exec_read', intentId: 'agent_task_x', moduleId: 'coder', capabilityId: 'coder.files.read',
      input: {}, requestedBy: 'agent:agent_task_x', createdAt: new Date(0).toISOString(), proposalId: 'proposal_read',
      proposalHash: 'a'.repeat(64), idempotencyKey: 'action:' + 'b'.repeat(64), riskVector: { effect: 'read' } } as any;
    const started = ledger.begin(request);
    expect(started.status).toBe('started');
    const result = { ok: true, summary: 'Read 6 characters.', output: { path: 'E:\CODERTEST\notes\a.txt', content: 'a.txt\n' } };
    ledger.complete(request.idempotencyKey, result);
    const restored = new MonarchActionLedger(1000, file).getByLedgerId(started.record.ledgerId);
    expect(restored).toMatchObject({ status: 'completed', receipt: true, resultDigest: astraCapabilityResultDigest(result as any) });
    // The full output is not kept on disk; the digest is what binds it.
    expect(restored?.result?.output).toBeUndefined();
    const { readFile } = await import('node:fs/promises');
    const persisted = await readFile(file, 'utf8');
    expect(persisted).not.toContain('Read 6 characters');
    expect(persisted).not.toContain('notes');
  });
});

describe('repeated agent actions', () => {
  it('keeps the receipt of a failed attempt when the same action is repeated, also across a restart', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const os = await import('node:os'); const path = await import('node:path');
    const { MonarchActionLedger } = await import('../../src/core/action-ledger');
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-ledger-repeat-'));
    const file = path.join(root, 'action-ledger.json');
    const ledger = new MonarchActionLedger(1000, file);
    const request = { id: 'exec_cmd', intentId: 'agent_task_y', moduleId: 'coder', capabilityId: 'coder.command.run',
      input: {}, requestedBy: 'agent:agent_task_y', createdAt: new Date(0).toISOString(), proposalId: 'proposal_cmd',
      proposalHash: 'c'.repeat(64), idempotencyKey: 'action:' + 'd'.repeat(64), riskVector: { effect: 'execute' } } as any;
    const first = ledger.begin(request);
    ledger.complete(request.idempotencyKey, { ok: false, summary: 'Command exited with code 1.', error: 'command-failed' });
    const second = ledger.begin({ ...request, id: 'exec_cmd_2' });
    expect(second.status).toBe('started');
    ledger.complete(request.idempotencyKey, { ok: false, summary: 'Command exited with code 1.', error: 'command-failed' });
    expect(ledger.getByLedgerId(first.record.ledgerId)).toMatchObject({ status: 'failed' });
    expect(ledger.getByLedgerId(second.record.ledgerId)).toMatchObject({ status: 'failed' });
    const restored = new MonarchActionLedger(1000, file);
    expect(restored.getByLedgerId(first.record.ledgerId)).toMatchObject({ status: 'failed' });
    expect(restored.getByIdempotencyKey(request.idempotencyKey)?.ledgerId).toBe(second.record.ledgerId);
  });
});
