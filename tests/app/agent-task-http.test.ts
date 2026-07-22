import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { InMemoryAgentTaskStore, ReplayAgentDecisionProvider } from '../../src/agent';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Task API v1', () => {
  it('is disabled by default and does not replace legacy routes', async () => {
    const { app, server, baseUrl } = await setup(false);
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

  it('forces HTTP source=api, exposes versioned JSON replay, and streams durable dotted terminal events', async () => {
    const { app, server, baseUrl } = await setup(true);
    try {
      const invalidVersion = await fetch(`${baseUrl}/api/agent/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 2, request: 'test' }),
      });
      expect(invalidVersion.status).toBe(400);
      await expect(invalidVersion.json()).resolves.toMatchObject({
        version: 1,
        ok: false,
        error: 'unsupported-version',
      });

      const createdResponse = await fetch(`${baseUrl}/api/agent/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          request: 'Create a paused API task.',
          source: 'telegram',
          clientRequestId: 'http-agent-task-1',
          autoStart: false,
        }),
      });
      expect(createdResponse.status).toBe(202);
      const created = await createdResponse.json() as { task: { id: string; source: { surface: string } } };
      expect(created.task.source.surface).toBe('api');
      const replayedCreate = await fetch(`${baseUrl}/api/agent/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          request: 'Create a paused API task.',
          source: 'telegram',
          clientRequestId: 'http-agent-task-1',
          autoStart: false,
        }),
      });
      expect(replayedCreate.status).toBe(202);
      await expect(replayedCreate.json()).resolves.toMatchObject({ task: { id: created.task.id } });

      const replay = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/events?format=json`);
      const replayBody = await replay.json() as { events: Array<{ version: number; type: string; sequence: number }> };
      expect(replayBody.events.map((event) => event.type)).toEqual(['task.created', 'plan.created']);
      expect(replayBody.events.every((event) => event.version === 1)).toBe(true);

      const stream = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/events`, {
        headers: { Accept: 'text/event-stream', 'Last-Event-ID': '1' },
      });
      expect(stream.status).toBe(200);
      const bodyPromise = stream.text();
      const cancelled = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1 }),
      });
      expect(cancelled.status).toBe(200);
      const streamBody = await bodyPromise;
      expect(streamBody).toContain('id: 2\nevent: plan.created');
      expect(streamBody).toContain('event: task.status.changed');
      expect(streamBody).toContain('event: task.cancelled');
      expect(streamBody).toContain('"traceId"');
    } finally {
      await close(server);
      await app.stop();
    }
  }, 30_000);

  it('rejects mistyped optional, nested, and budget fields before creating a task', async () => {
    const { app, server, baseUrl } = await setup(true);
    try {
      const invalidBodies: Array<Record<string, unknown>> = [
        { version: 1, request: 'Invalid client id.', clientRequestId: 42 },
        { version: 1, request: 'Invalid auto start.', autoStart: 'false' },
        { version: 1, request: 'Invalid output container.', expectedOutputs: {} },
        {
          version: 1,
          request: 'Invalid nested output.',
          expectedOutputs: [{ description: 'Return a report.', required: 'false' }],
        },
        {
          version: 1,
          request: 'Invalid nested constraint.',
          constraints: [{ description: 'Stay in scope.', required: true }],
        },
        { version: 1, request: 'Invalid preferences.', userPreferences: ['concise', 42] },
        { version: 1, request: 'Invalid budget type.', budgets: { maxSteps: '1' } },
        { version: 1, request: 'Invalid budget range.', budgets: { maxSteps: 513 } },
        { version: 1, request: 'Invalid budget key.', budgets: { extraTurns: 2 } },
        { version: 1, request: 'Invalid source type.', source: { surface: 'telegram' } },
      ];

      for (const body of invalidBodies) {
        const response = await postJson(`${baseUrl}/api/agent/tasks`, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ version: 1, ok: false });
      }

      const listBeforeValid = await fetch(`${baseUrl}/api/agent/tasks`);
      await expect(listBeforeValid.json()).resolves.toMatchObject({ tasks: [] });

      const valid = await postJson(`${baseUrl}/api/agent/tasks`, {
        version: 1,
        request: 'Create a strictly validated task.',
        clientRequestId: 'strict-agent-task-1',
        expectedOutputs: [{ id: 'report', description: 'Return a report.', kind: 'artifact', required: true }],
        constraints: [{ id: 'scope', description: 'Stay in the workspace.', kind: 'scope' }],
        successCriteria: [{ id: 'verified', description: 'The report is verified.', verificationHint: 'Use a file receipt.' }],
        userPreferences: ['concise'],
        budgets: { maxSteps: 4, maxWallTimeMs: 2_000, maxComputeClass: 'light' },
        autoStart: false,
        source: 'telegram',
      });
      expect(valid.status).toBe(202);
      await expect(valid.json()).resolves.toMatchObject({
        version: 1,
        task: {
          status: 'created',
          source: { surface: 'api' },
          budgets: { maxSteps: 4, maxWallTimeMs: 2_000, maxComputeClass: 'light' },
          goal: {
            expectedOutputs: [{ id: 'report', kind: 'artifact', required: true }],
            constraints: [{ id: 'scope', kind: 'scope' }],
            successCriteria: [{ id: 'verified', verificationHint: 'Use a file receipt.' }],
            userPreferences: ['concise'],
          },
        },
      });
    } finally {
      await close(server);
      await app.stop();
    }
  });

  it('returns versioned 400 errors for malformed IDs and validates mutation optionals', async () => {
    const { app, server, baseUrl } = await setup(true);
    try {
      for (const encodedId of ['bad%24id', 'bad%ZZ']) {
        const response = await fetch(`${baseUrl}/api/agent/tasks/${encodedId}`);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          version: 1,
          ok: false,
          error: 'invalid-id',
        });
      }

      const missing = await fetch(`${baseUrl}/api/agent/tasks/missing_task`);
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({ version: 1, error: 'task-not-found' });

      const method = await fetch(`${baseUrl}/api/agent/tasks`, { method: 'PUT' });
      expect(method.status).toBe(405);
      await expect(method.json()).resolves.toMatchObject({ version: 1, error: 'method-not-allowed' });

      const createdResponse = await postJson(`${baseUrl}/api/agent/tasks`, {
        version: 1,
        request: 'Exercise strict mutation optionals.',
        autoStart: false,
      });
      const created = await createdResponse.json() as { task: { id: string } };

      const invalidMessage = await postJson(`${baseUrl}/api/agent/tasks/${created.task.id}/messages`, {
        version: 1,
        content: 'Keep this message idempotent.',
        messageId: 42,
      });
      expect(invalidMessage.status).toBe(400);
      await expect(invalidMessage.json()).resolves.toMatchObject({ version: 1, error: 'invalid-id' });

      const invalidApproval = await postJson(`${baseUrl}/api/agent/tasks/${created.task.id}/approvals/fake_approval`, {
        version: 1,
        decision: 'approve',
        reason: 42,
      });
      expect(invalidApproval.status).toBe(400);
      await expect(invalidApproval.json()).resolves.toMatchObject({ version: 1, ok: false });

      const checkpointResponse = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}`);
      const checkpoint = await checkpointResponse.json() as { checkpoint: { task: { messages: unknown[] } } };
      expect(checkpoint.checkpoint.task.messages).toHaveLength(1);
    } finally {
      await close(server);
      await app.stop();
    }
  });

  it('keeps session and origin guard failures inside the versioned Agent API envelope', async () => {
    const { app, server, baseUrl } = await setup(true, new ReplayAgentDecisionProvider([]), true);
    try {
      const unauthenticatedRead = await fetch(`${baseUrl}/api/agent/tasks`);
      expect(unauthenticatedRead.status).toBe(401);
      await expect(unauthenticatedRead.json()).resolves.toMatchObject({
        version: 1,
        ok: false,
        error: 'invalid-api-token',
      });

      const untrustedMutation = await fetch(`${baseUrl}/api/agent/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Session': 'agent-http-test-token',
          Origin: 'https://attacker.invalid',
        },
        body: JSON.stringify({ version: 1, request: 'This request must be blocked.' }),
      });
      expect(untrustedMutation.status).toBe(403);
      await expect(untrustedMutation.json()).resolves.toMatchObject({
        version: 1,
        ok: false,
        error: 'untrusted-origin',
      });

      const authenticatedRead = await fetch(`${baseUrl}/api/agent/tasks`, {
        headers: { 'X-Monarch-Session': 'agent-http-test-token' },
      });
      expect(authenticatedRead.status).toBe(200);
    } finally {
      await close(server);
      await app.stop();
    }
  });

  it('keeps SSE open through the durable runner release tail', async () => {
    const provider = new ReplayAgentDecisionProvider([
      JSON.stringify({ kind: 'fail', code: 'fixture-stop', reason: 'Terminal SSE fixture.' }),
    ]);
    const { app, server, baseUrl } = await setup(true, provider);
    try {
      const createdResponse = await fetch(`${baseUrl}/api/agent/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, request: 'Exercise the terminal event tail.', autoStart: false }),
      });
      const created = await createdResponse.json() as { task: { id: string } };
      const stream = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/events`, {
        headers: { Accept: 'text/event-stream' },
      });
      const streamBody = stream.text();
      const resumed = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1 }),
      });
      expect(resumed.status).toBe(200);

      const body = await streamBody;
      expect(body).toContain('event: task.failed');
      expect(body).toContain('event: runner.released');
      expect(body.indexOf('event: runner.released')).toBeGreaterThan(body.indexOf('event: task.failed'));

      const replay = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/events?format=json`);
      const replayBody = await replay.json() as { events: Array<{ sequence: number; type: string }> };
      const terminalSequence = replayBody.events.find((event) => event.type === 'task.failed')!.sequence;
      const releasedSequence = replayBody.events.find((event) => event.type === 'runner.released')!.sequence;

      const terminalReconnect = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/events`, {
        headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(terminalSequence) },
      });
      const terminalTail = await readWithin(terminalReconnect, 2_000);
      expect(terminalTail).toContain('event: runner.released');

      const settledReconnect = await fetch(`${baseUrl}/api/agent/tasks/${created.task.id}/events`, {
        headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(releasedSequence) },
      });
      await expect(readWithin(settledReconnect, 2_000)).resolves.toBe('');
    } finally {
      await close(server);
      await app.stop();
    }
  }, 30_000);
});

async function setup(
  enabled: boolean,
  provider = new ReplayAgentDecisionProvider([]),
  requireApiToken = false,
): Promise<{ app: MonarchApplication; server: Server; baseUrl: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-agent-http-'));
  roots.push(root);
  const app = new MonarchApplication({
    workspaceRoot: root,
    enabledModules: ['workspace'],
    enableLocalSystemRouter: false,
    enableAgentRuntimeV2: enabled,
    ...(enabled ? {
      agentTaskStore: new InMemoryAgentTaskStore(),
      agentDecisionProvider: provider,
    } : {}),
  });
  await app.start();
  const server = createMonarchHttpServer({
    app,
    publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
    host: '127.0.0.1',
    port: 4317,
    apiToken: 'agent-http-test-token',
    requireApiToken,
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

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function readWithin(response: Response, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSE response did not settle within ${timeoutMs}ms.`)), timeoutMs);
    void response.text().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
