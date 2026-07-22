import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchActionLedger } from '../../src/core/action-ledger';
import { MonarchCapabilityLeaseStore } from '../../src/core/capability-leases';
import type { MonarchExecutionRequest } from '../../src/core/contracts';

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
});
