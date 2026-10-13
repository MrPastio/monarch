import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchActionLedger } from '../../src/core/action-ledger';
import { normalizeActionProposal } from '../../src/core/action-protocol';
import { MonarchCapabilityLeaseStore } from '../../src/core/capability-leases';
import type { MonarchCapability, MonarchExecutionRequest } from '../../src/core/contracts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable agency state', () => {
  it('restores scoped leases and revocation state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-'));
    roots.push(root);
    const file = path.join(root, 'leases.json');
    const first = new MonarchCapabilityLeaseStore(root, file);
    const lease = first.issue({
      intentHash: 'intent-hash',
      capabilities: ['workspace.files.write'],
      roots: [root],
      modelId: 'unit-model',
    });
    expect(new MonarchCapabilityLeaseStore(root, file).get(lease.leaseId)?.status).toBe('active');
    first.revoke(lease.leaseId);
    expect(new MonarchCapabilityLeaseStore(root, file).get(lease.leaseId)?.status).toBe('revoked');
  });

  it('replays a completed idempotent result after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-'));
    roots.push(root);
    const file = path.join(root, 'ledger.json');
    const request: MonarchExecutionRequest = {
      id: 'exec-1',
      intentId: 'intent-1',
      moduleId: 'workspace',
      capabilityId: 'workspace.files.write',
      input: { path: 'a.txt', content: 'a' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'unit',
      idempotencyKey: 'action:unit',
      proposalId: 'proposal-unit',
      proposalHash: 'c'.repeat(64),
      riskVector: {
        effect: 'write',
        scope: 'single-object',
        reversibility: 'reversible',
        externality: 'local',
        privilege: 'user',
        data: 'workspace',
        novelty: 'new-args',
      },
    };
    const first = new MonarchActionLedger(10, file);
    expect(first.begin(request).status).toBe('started');
    first.complete('action:unit', { ok: true, summary: 'written' });
    const replay = new MonarchActionLedger(10, file).begin(request);
    expect(replay.status).toBe('replay');
    if (replay.status === 'replay') expect(replay.result.summary).toBe('written');
  });

  it('retains only a bounded privacy-safe Computer receipt for restart reconciliation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-computer-receipt-'));
    roots.push(root);
    const file = path.join(root, 'ledger.json');
    const beforeObservationId = 'computer-observation-11111111-1111-4111-8111-111111111111';
    const afterObservationId = 'computer-observation-22222222-2222-4222-8222-222222222222';
    const actionReceiptId = 'computer-action-33333333-3333-4333-8333-333333333333';
    const processInstanceId = `process:${'4'.repeat(64)}`;
    const privateTitle = 'Private document title must not persist';
    const privatePath = 'D:\\private\\computer-after.png';
    const request: MonarchExecutionRequest = {
      id: 'exec-computer', intentId: 'intent-computer', moduleId: 'computer', capabilityId: 'computer.window.type',
      input: { windowRef: 'hwnd:0000000000000042', observationId: beforeObservationId, elementId: 'private-editor', text: 'private action text' },
      createdAt: new Date(0).toISOString(), requestedBy: 'unit', idempotencyKey: 'action:' + '4'.repeat(64),
      proposalId: 'proposal-computer', proposalHash: '5'.repeat(64),
      riskVector: { effect: 'device', scope: 'single-object', reversibility: 'irreversible', externality: 'local',
        privilege: 'user', data: 'personal', novelty: 'new-args' },
    };
    const ledger = new MonarchActionLedger(10, file);
    expect(ledger.begin(request).status).toBe('started');
    ledger.complete(request.idempotencyKey!, { ok: true, summary: privateTitle, output: { performed: true, verified: true,
      actionReceiptId, beforeObservationId, afterObservationId, windowRef: 'hwnd:0000000000000042',
      after: { verified: true, observationId: afterObservationId, observedAt: new Date().toISOString(),
        window: { windowRef: 'hwnd:0000000000000042', processId: 42, processInstanceId, title: privateTitle,
          processName: 'private-process' }, screenshot: { sha256: '6'.repeat(64), path: privatePath },
        elements: [{ name: 'private element text' }] },
      textVerification: { textMode: 'replace', textSha256: '7'.repeat(64), valueVerifiedAfterDispatch: true } },
      metadata: { dispatchControl: { dispatched: true, reason: 'module-returned' }, artifacts: [{ reference: privatePath }],
        policy: { target: 'private policy target' }, runtimeTelemetry: { toolLatencyMs: 1.25 } } });

    const raw = await readFile(file, 'utf8');
    for (const secret of [privateTitle, privatePath, 'private element text', 'private-process', 'private policy target', 'private action text'])
      expect(raw).not.toContain(secret);
    const replay = new MonarchActionLedger(10, file).begin(request);
    expect(replay.status).toBe('replay');
    if (replay.status === 'replay') expect(replay.result).toMatchObject({ ok: true, summary: 'Durable Computer action receipt.',
      output: { recoverySchemaVersion: 'monarch.computer-action-recovery-output.v1', performed: true, verified: true,
        actionReceiptId, beforeObservationId, afterObservationId, windowRef: 'hwnd:0000000000000042',
        after: { verified: true, observationId: afterObservationId,
          window: { windowRef: 'hwnd:0000000000000042', processId: 42, processInstanceId,
            titleDigest: 'sha256:' + createHash('sha256').update(privateTitle).digest('hex') },
          screenshot: { sha256: '6'.repeat(64) } },
        textVerification: { textMode: 'replace', textSha256: '7'.repeat(64), valueVerifiedAfterDispatch: true } },
      metadata: { recoveryReceipt: { retained: true, reason: 'retained-success' },
        dispatchControl: { dispatched: true, reason: 'module-returned' } } });
    // Restore persists its bounded projection again. A second process restart
    // must not erase the already-sanitized receipt (sanitization is idempotent).
    const secondReplay = new MonarchActionLedger(10, file).begin(request);
    expect(secondReplay).toMatchObject({ status: 'replay', result: { ok: true,
      output: { recoverySchemaVersion: 'monarch.computer-action-recovery-output.v1', after: {
        window: { titleDigest: 'sha256:' + createHash('sha256').update(privateTitle).digest('hex') } } } } });
  });

  it('replays an uncertain Computer failure after restart instead of dispatching the same key again', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-computer-unknown-'));
    roots.push(root);
    const file = path.join(root, 'ledger.json');
    const request: MonarchExecutionRequest = {
      id: 'exec-computer-unknown', intentId: 'intent-computer-unknown', moduleId: 'computer', capabilityId: 'computer.window.click',
      input: { windowRef: 'hwnd:0000000000000042' }, createdAt: new Date(0).toISOString(), requestedBy: 'unit',
      idempotencyKey: 'action:' + '8'.repeat(64), proposalId: 'proposal-computer-unknown', proposalHash: '9'.repeat(64),
      riskVector: { effect: 'device', scope: 'single-object', reversibility: 'irreversible', externality: 'local',
        privilege: 'user', data: 'personal', novelty: 'new-args' },
    };
    const ledger = new MonarchActionLedger(10, file); expect(ledger.begin(request).status).toBe('started');
    ledger.complete(request.idempotencyKey!, { ok: false, summary: 'private uncertain detail', error: 'computer-action-state-uncertain',
      output: { performed: 'unknown', verified: false }, metadata: {
        dispatchControl: { dispatched: true, reason: 'module-returned' },
        computerDispatch: { phase: 'receipt-returned', nativePreflightRejected: false, mayHaveDispatched: true, reportingFailed: false,
          failureCode: 'computer-native-helper-exit-23' },
        warnings: ['private warning detail'] } });
    const raw = await readFile(file, 'utf8'); expect(raw).not.toContain('private uncertain detail'); expect(raw).not.toContain('private warning detail');
    const replay = new MonarchActionLedger(10, file).begin(request);
    expect(replay).toMatchObject({ status: 'replay', result: { ok: false, error: 'computer-action-state-uncertain',
      output: { recoverySchemaVersion: 'monarch.computer-action-recovery-output.v1', performed: 'unknown', verified: false },
      metadata: { dispatchControl: { dispatched: true }, computerDispatch: { phase: 'receipt-returned', mayHaveDispatched: true,
        failureCode: 'computer-native-helper-exit-23' } } } });
  });

  it('replays a non-idempotent filesystem effect when the model changes only its Windows path alias', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-path-alias-'));
    roots.push(root);
    const file = path.join(root, 'ledger.json');
    const capability: MonarchCapability = {
      id: 'workspace.files.append',
      moduleId: 'workspace',
      title: 'Append file',
      description: 'Append exact text once.',
      risk: 'write',
    };
    const options = {
      capability,
      workspaceRoot: 'E:\\Monarch',
      intentId: 'intent-append-alias',
    };
    const firstProposal = normalizeActionProposal({
      capabilityId: capability.id,
      args: { path: '.\\runtime\\LOG.txt', content: 'once' },
    }, options);
    const aliasProposal = normalizeActionProposal({
      capabilityId: capability.id,
      args: { path: 'e:\\monarch\\RUNTIME\\log.txt', content: 'once' },
    }, options);
    const request = (proposal: typeof firstProposal, id: string): MonarchExecutionRequest => ({
      id,
      intentId: proposal.intentId,
      moduleId: capability.moduleId,
      capabilityId: capability.id,
      input: proposal.args,
      createdAt: new Date(0).toISOString(),
      requestedBy: 'unit',
      idempotencyKey: proposal.idempotencyKey,
      proposalId: proposal.proposalId,
      proposalHash: proposal.canonicalHash,
      riskVector: proposal.riskVector,
    });

    const ledger = new MonarchActionLedger(10, file);
    expect(ledger.begin(request(firstProposal, 'exec-alias-1')).status).toBe('started');
    ledger.complete(firstProposal.idempotencyKey, { ok: true, summary: 'appended exactly once' });
    const replay = ledger.begin(request(aliasProposal, 'exec-alias-2'));

    expect(aliasProposal.idempotencyKey).toBe(firstProposal.idempotencyKey);
    expect(aliasProposal.canonicalHash).toBe(firstProposal.canonicalHash);
    expect(replay.status).toBe('replay');
    if (replay.status === 'replay') expect(replay.result.summary).toBe('appended exactly once');
  });

  it('does not re-run a durable action left executing across restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-interrupted-'));
    roots.push(root);
    const file = path.join(root, 'ledger.json');
    const request: MonarchExecutionRequest = {
      id: 'exec-interrupted',
      intentId: 'intent-interrupted',
      moduleId: 'workspace',
      capabilityId: 'workspace.files.write',
      input: { path: 'non-idempotent.txt', content: 'once' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'unit',
      idempotencyKey: 'action:interrupted',
      proposalId: 'proposal-interrupted',
      proposalHash: 'd'.repeat(64),
      riskVector: {
        effect: 'write',
        scope: 'single-object',
        reversibility: 'manual',
        externality: 'local',
        privilege: 'user',
        data: 'workspace',
        novelty: 'new-args',
      },
    };

    expect(new MonarchActionLedger(10, file).begin(request).status).toBe('started');
    const replay = new MonarchActionLedger(10, file).begin(request);
    expect(replay.status).toBe('replay');
    if (replay.status === 'replay') {
      expect(replay.result).toMatchObject({ ok: false, error: 'interrupted-before-completion' });
    }
  });

  it('fails closed on corrupt authority state instead of resetting durable identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-corrupt-'));
    roots.push(root);
    const ledgerFile = path.join(root, 'ledger.json');
    const leasesFile = path.join(root, 'leases.json');
    await writeFile(ledgerFile, '{ broken ledger', 'utf8');
    await writeFile(leasesFile, '{ broken leases', 'utf8');

    expect(() => new MonarchActionLedger(10, ledgerFile)).toThrowError(/invalid JSON/);
    expect(() => new MonarchCapabilityLeaseStore(root, leasesFile)).toThrowError(/invalid JSON/);
    await expect(readFile(ledgerFile, 'utf8')).resolves.toBe('{ broken ledger');
    await expect(readFile(leasesFile, 'utf8')).resolves.toBe('{ broken leases');
  });

  it('rolls back authority state in memory when its durable commit fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agency-write-failure-'));
    roots.push(root);
    const ledgerFile = path.join(root, 'ledger.json');
    const leasesFile = path.join(root, 'leases.json');
    const ledger = new MonarchActionLedger(10, ledgerFile);
    const leases = new MonarchCapabilityLeaseStore(root, leasesFile);
    await mkdir(ledgerFile);
    await mkdir(leasesFile);

    const request: MonarchExecutionRequest = {
      id: 'exec-write-failure',
      intentId: 'intent-write-failure',
      moduleId: 'workspace',
      capabilityId: 'workspace.files.write',
      input: { path: 'failure.txt', content: 'must not run' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'unit',
      idempotencyKey: 'action:write-failure',
      proposalId: 'proposal-write-failure',
      proposalHash: 'e'.repeat(64),
      riskVector: {
        effect: 'write',
        scope: 'single-object',
        reversibility: 'reversible',
        externality: 'local',
        privilege: 'user',
        data: 'workspace',
        novelty: 'new-args',
      },
    };

    expect(() => ledger.begin(request)).toThrowError(/Unable to write durable JSON/);
    expect(ledger.getByIdempotencyKey(request.idempotencyKey!)).toBeNull();
    expect(() => leases.issue({
      intentHash: 'failed-intent',
      capabilities: ['workspace.files.write'],
      roots: [root],
    })).toThrowError(/Unable to write durable JSON/);
    expect(leases.list()).toEqual([]);
  });
});
