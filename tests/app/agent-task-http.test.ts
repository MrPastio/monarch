import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Task API v1', () => {
  it('is disabled by default and does not replace legacy routes', async () => {
    const { app, server, baseUrl } = await setupWithoutV3();
    try {
      const response = await fetch(`${baseUrl}/api/agent/tasks`);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ version: 1, error: 'agent-runtime-disabled' });

      const legacy = await fetch(`${baseUrl}/api/intent-jobs`);
      expect(legacy.status).toBe(200);
    } finally {
      await close(server);
      await app.stop();
    }
  });

  it('has no internal V2 runtime surface and cannot expose one through the public Agent Task API', async () => {
    const { app, server, baseUrl } = await setupWithoutV3();
    try {
      expect('agentRuntime' in app).toBe(false);
      expect('createAgentTask' in app).toBe(false);
      for (const request of [
        fetch(`${baseUrl}/api/agent/tasks`),
        fetch(`${baseUrl}/api/agent/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1, request: 'This must not reach Agent Runtime V2.' }),
        }),
      ]) {
        const response = await request;
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
          version: 1,
          ok: false,
          error: 'agent-runtime-disabled',
        });
      }
    } finally {
      await close(server);
      await app.stop();
    }
  });

  it('keeps Astra V3 approval decisions exact-bound and treats arm as validation only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-astra-approval-'));
    roots.push(root);
    const apiToken = 'agent-v3-approval-api-token';
    const actor = {
      source: 'api' as const,
      id: 'sha256:' + createHmac('sha256', apiToken)
        .update('monarch.astra-v3.http-actor.v1/api').digest('hex'),
    };
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
    });
    await app.start();
    const originalPilot = app.astraProductPilot;
    const taskId = 'astra_agent_http_fixture';
    const approvalId = 'approval_http_fixture';
    const proposalHash = 'a'.repeat(64);
    const approvalDigest = `sha256:${'b'.repeat(64)}`;
    const expiresAt = Date.now() + 60_000;
    const checkpoint = {
      turn: {
        id: 'turn_astra_http_fixture',
        status: 'waiting-input',
        source: 'api',
        request: { astra: { actor, goal: { kind: 'agent' } } },
      },
    };
    const find = vi.spyOn(app.oscarTurnCoordinator, 'findTurnByTaskId').mockResolvedValue(checkpoint as never);
    const submit = vi.spyOn(app.oscarTurnCoordinator, 'submitAstraInput').mockResolvedValue({
      turn: { ...checkpoint.turn, status: 'running' },
    } as never);
    app.astraProductPilot = {
      bridge: { find: () => ({
        id: taskId,
        modelJobs: 2,
        capabilityJobs: 1,
        approval: {
          id: approvalId,
          digest: approvalDigest,
          proposalHash,
          expiresAt,
          capability: { id: 'coder.files.write' },
        },
      }) },
    } as never;
    const server = createMonarchHttpServer({
      app,
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken,
      desktopAttestationToken: 'agent-v3-approval-desktop-attestation',
      requireApiToken: true,
      astraOscarTurns: true,
    });
    const baseUrl = await listen(server);
    const headers = { 'X-Monarch-Session': apiToken };
    try {
      const mismatch = await postJson(`${baseUrl}/api/agent/tasks/${taskId}/approvals/${approvalId}`, {
        version: 1,
        decision: 'approve',
        grantScope: 'once',
        canonicalProposalHash: 'c'.repeat(64),
        capabilityId: 'coder.files.write',
      }, headers);
      expect(mismatch.status).toBe(409);
      await expect(mismatch.json()).resolves.toMatchObject({ error: 'approval-binding-mismatch' });
      expect(submit).not.toHaveBeenCalled();

      const arm = await postJson(`${baseUrl}/api/agent/tasks/${taskId}/approvals/${approvalId}`, {
        version: 1,
        decision: 'arm',
        grantScope: 'once',
        canonicalProposalHash: proposalHash,
        capabilityId: 'coder.files.write',
      }, headers);
      expect(arm.status).toBe(200);
      await expect(arm.json()).resolves.toMatchObject({
        astraVersion: 3,
        arm: { exactOneShot: true, expiresAt: new Date(expiresAt).toISOString() },
      });
      expect(submit).not.toHaveBeenCalled();

      const approve = await postJson(`${baseUrl}/api/agent/tasks/${taskId}/approvals/${approvalId}`, {
        version: 1,
        decision: 'approve',
        grantScope: 'once',
        requestId: 'astra_http_approve',
        canonicalProposalHash: proposalHash,
        capabilityId: 'coder.files.write',
      }, headers);
      expect(approve.status).toBe(200);
      expect(submit).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledWith(checkpoint.turn.id, 'api', {
        kind: 'decide',
        decision: {
          approvalId,
          approvalDigest,
          messageId: expect.stringMatching(/^astra_decision_[a-f0-9]{48}$/u),
          decision: 'approve',
        },
      });
    } finally {
      find.mockRestore();
      submit.mockRestore();
      app.astraProductPilot = originalPilot;
      await close(server);
      await app.stop();
    }
  });

  it('lets the attested Desktop Coder surface decide its exact Astra V3 approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-coder-astra-approval-'));
    roots.push(root);
    const desktopAttestationToken = 'coder-astra-desktop-attestation';
    const app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['workspace'], enableLocalSystemRouter: false });
    await app.start();
    const originalPilot = app.astraProductPilot;
    const taskId = 'astra_coder_http_fixture';
    const approvalId = 'approval_coder_http_fixture';
    const proposalHash = 'd'.repeat(64);
    const approvalDigest = `sha256:${'e'.repeat(64)}`;
    const coderActor = { source: 'coder' as const, id: 'sha256:' + createHmac('sha256', desktopAttestationToken)
      .update('monarch.astra-v3.http-actor.v1/coder').digest('hex') };
    const checkpoint = { turn: { id: 'turn_astra_coder_http_fixture', status: 'waiting-input', source: 'coder',
      request: { astra: { actor: coderActor, goal: { kind: 'agent' } } } } };
    const find = vi.spyOn(app.oscarTurnCoordinator, 'findTurnByTaskId').mockResolvedValue(checkpoint as never);
    const submit = vi.spyOn(app.oscarTurnCoordinator, 'submitAstraInput').mockResolvedValue({
      turn: { ...checkpoint.turn, status: 'running' },
    } as never);
    app.astraProductPilot = { bridge: { find: () => ({ id: taskId, modelJobs: 2, capabilityJobs: 1,
      approval: { id: approvalId, digest: approvalDigest, proposalHash, expiresAt: Date.now() + 60_000,
        capability: { id: 'coder.files.write' } } }) } } as never;
    const server = createMonarchHttpServer({ app, publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1', port: 4317, desktopAttestationToken, requireApiToken: false, astraOscarTurns: true });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/agent/tasks/${taskId}/approvals/${approvalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4317',
          'X-Monarch-Desktop-Attestation': desktopAttestationToken },
        body: JSON.stringify({ version: 1, decision: 'approve', grantScope: 'once', requestId: 'coder_approval_request',
          canonicalProposalHash: proposalHash, capabilityId: 'coder.files.write' }),
      });
      expect(response.status).toBe(200);
      expect(submit).toHaveBeenCalledWith(checkpoint.turn.id, 'coder', { kind: 'decide', decision: {
        approvalId, approvalDigest, messageId: expect.stringMatching(/^astra_decision_[a-f0-9]{48}$/u), decision: 'approve',
      } });
    } finally {
      find.mockRestore(); submit.mockRestore(); app.astraProductPilot = originalPilot;
      await close(server); await app.stop();
    }
  });

  it('binds exact MAX/local models to V3 tasks and preserves MAX across repeat without fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-model-binding-'));
    roots.push(root);
    const desktopAttestationToken = 'agent-model-desktop-attestation';
    const app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['workspace'], enableLocalSystemRouter: false });
    await app.start();
    const originalPilot = app.astraProductPilot;
    const actor = { source: 'desktop' as const, id: 'sha256:' + createHmac('sha256', desktopAttestationToken)
      .update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') };
    const specification = { schemaVersion: 'monarch.astra-v3-agent-task-specification.v1' as const };
    const turn = { id: 'turn_agent_model_binding', clientRequestId: 'agent_model_request',
      conversationId: 'agent_model_conversation', inputMessageId: 'agent_model_message', status: 'running',
      source: 'desktop', privacyMode: 'persistent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      request: { text: 'Проверь подключённую почту.', attachmentIds: [], modifiers: { requestedModel: 'max-gpt-oss-120b' },
        explicitAgentTask: specification, astra: { actor, goal: { kind: 'agent' } } } };
    const submit = vi.spyOn(app.oscarTurnCoordinator, 'submit').mockResolvedValue({ turn } as never);
    const getTurn = vi.spyOn(app.oscarTurnCoordinator, 'getTurn').mockResolvedValue({ turn, events: [] } as never);
    app.astraProductPilot = { bridge: { find: () => ({ id: 'agent_task_model_binding', status: 'running',
      modelJobs: 0, capabilityJobs: 0, nativeCompletionCertified: false }) } } as never;
    const server = createMonarchHttpServer({ app, publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1', port: 4317, desktopAttestationToken, requireApiToken: false, astraOscarTurns: true });
    const baseUrl = await listen(server);
    const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4317',
      'X-Monarch-Desktop-Attestation': desktopAttestationToken };
    try {
      const created = await fetch(`${baseUrl}/api/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({
        version: 1, request: 'Проверь подключённую почту.', clientRequestId: 'agent_model_request',
        conversationId: 'agent_model_conversation', source: 'desktop', model: 'max-gpt-oss-120b',
      }) });
      expect(created.status).toBe(202);
      await expect(created.json()).resolves.toMatchObject({ astraVersion: 3, task: { model: 'max-gpt-oss-120b' } });
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ modifiers: { requestedModel: 'max-gpt-oss-120b' },
        authenticatedAgentActor: actor }));

      const local = await fetch(`${baseUrl}/api/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({
        version: 1, request: 'Use the exact local agent model.', model: 'qwen3-coder-30b-a3b-instruct',
      }) });
      expect(local.status).toBe(202);
      expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
        modifiers: { requestedModel: 'qwen3-coder-30b-a3b-instruct' }, authenticatedAgentActor: actor,
      }));

      const invalid = await fetch(`${baseUrl}/api/agent/tasks`, { method: 'POST', headers, body: JSON.stringify({
        version: 1, request: 'Do not silently fall back.', model: 'invented-local-model',
      }) });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid-agent-model' });
      expect(submit).toHaveBeenCalledTimes(2);

      const repeated = await fetch(`${baseUrl}/api/agent/tasks/${turn.id}/repeat`, { method: 'POST', headers,
        body: JSON.stringify({ version: 1, clientRequestId: 'agent_model_repeat' }) });
      expect(repeated.status).toBe(202);
      expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
        clientRequestId: 'agent_model_repeat', modifiers: { requestedModel: 'max-gpt-oss-120b' },
        authenticatedAgentActor: actor,
      }));
    } finally {
      submit.mockRestore(); getTurn.mockRestore(); app.astraProductPilot = originalPilot;
      await close(server); await app.stop();
    }
  });

  it('projects Astra partial and its bounded reason instead of outer Oscar succeeded', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-partial-http-'));
    roots.push(root);
    const apiToken = 'agent-v3-partial-api-token';
    const actor = { source: 'api' as const, id: 'sha256:' + createHmac('sha256', apiToken)
      .update('monarch.astra-v3.http-actor.v1/api').digest('hex') };
    const turn = { id: 'turn_agent_partial', clientRequestId: 'agent_partial_request',
      conversationId: 'agent_partial_conversation', inputMessageId: 'agent_partial_message', status: 'succeeded',
      source: 'api', privacyMode: 'persistent', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      request: { text: 'Inspect live integrations.', attachmentIds: [],
        explicitAgentTask: { schemaVersion: 'monarch.astra-v3-agent-task-specification.v1' },
        astra: { actor, goal: { kind: 'agent' } } } };
    const app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['workspace'], enableLocalSystemRouter: false });
    await app.start();
    const originalPilot = app.astraProductPilot;
    const getTurn = vi.spyOn(app.oscarTurnCoordinator, 'getTurn').mockResolvedValue({ turn, events: [] } as never);
    app.astraProductPilot = { bridge: { find: () => ({ id: 'agent_task_partial', status: 'partial',
      modelJobs: 5, capabilityJobs: 1, nativeCompletionCertified: false,
      failureReason: 'context-capacity-insufficient' }) } } as never;
    const server = createMonarchHttpServer({ app, publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1', port: 4317, apiToken, requireApiToken: true, astraOscarTurns: true });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/agent/tasks/${turn.id}`, {
        headers: { 'X-Monarch-Session': apiToken },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ astraVersion: 3, task: {
        id: turn.id, status: 'partial', failureReason: 'context-capacity-insufficient',
        nativeCompletionCertified: false, modelTurns: 5, capabilityCalls: 1,
      } });
    } finally {
      getTurn.mockRestore(); app.astraProductPilot = originalPilot;
      await close(server); await app.stop();
    }
  });
});

async function setupWithoutV3(): Promise<{ app: MonarchApplication; server: Server; baseUrl: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-http-'));
  roots.push(root);
  const app = new MonarchApplication({
    workspaceRoot: root,
    enabledModules: ['workspace'],
    enableLocalSystemRouter: false,
  });
  await app.start();
  const server = createMonarchHttpServer({
    app,
    publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
    host: '127.0.0.1',
    port: 4317,
    apiToken: 'agent-http-test-token',
    desktopAttestationToken: 'agent-http-desktop-test-token',
    requireApiToken: false,
  });
  const baseUrl = await listen(server);
  return { app, server, baseUrl };
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

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
