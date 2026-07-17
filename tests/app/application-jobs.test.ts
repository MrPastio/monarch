import { describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { MonarchApplication } from '../../src/app';

describe('MonarchApplication intent jobs', () => {
  it('uses a responsive default timeout for queued intent jobs', async () => {
    const app = new MonarchApplication({
      enabledModules: ['assistant'],
      enableLocalSystemRouter: false,
    });

    try {
      const queued = await app.submitIntentJob({
        text: 'hello',
      });
      expect(queued.timeoutMs).toBe(90000);
      app.cancelIntentJob(queued.id);
    } finally {
      await app.stop().catch(() => undefined);
    }
  });

  it('should run a long-form assistant request through the async job lifecycle', async () => {
    const server = createOpenAiCompatibleServer();
    const baseUrl = await listen(server);
    const previousEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    const previousModel = process.env.MONARCH_CHAT_MODEL_NAME;
    const previousAllowExternal = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    process.env.MONARCH_CHAT_MODEL_ENDPOINT = baseUrl;
    process.env.MONARCH_CHAT_MODEL_NAME = 'job-smoke-model';
    process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS = '1';

    const app = new MonarchApplication({
      enabledModules: ['assistant'],
      enableLocalSystemRouter: false,
    });

    try {
      const queued = await app.submitIntentJob({
        text: 'hello, explain Monarch briefly',
        timeoutMs: 10000,
      });
      expect(queued.status).toBe('queued');

      const completed = await waitForTerminalJob(app, queued.id);
      expect(completed.status).toBe('completed');
      expect(completed.result?.route?.targetModuleId).toBe('assistant');
      expect(completed.result?.execution?.ok).toBe(true);
      expect(completed.result?.execution?.summary).toContain('Assistant reply completed');
    } finally {
      await app.stop().catch(() => undefined);
      await close(server);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousEndpoint);
      restoreEnv('MONARCH_CHAT_MODEL_NAME', previousModel);
      restoreEnv('MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS', previousAllowExternal);
    }
  });

  it('aborts a cancelled assistant job so the next queued job can run', async () => {
    let hang = true;
    let seenSlowRequest: (() => void) | undefined;
    const slowRequestSeen = new Promise<void>((resolve) => {
      seenSlowRequest = resolve;
    });
    const server = createOpenAiCompatibleServer(() => {
      if (hang) {
        seenSlowRequest?.();
        return null;
      }
      return 'Monarch job after cancel ok';
    });
    const baseUrl = await listen(server);
    const previousEndpoint = process.env.MONARCH_CHAT_MODEL_ENDPOINT;
    const previousModel = process.env.MONARCH_CHAT_MODEL_NAME;
    const previousAllowExternal = process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS;

    process.env.MONARCH_CHAT_MODEL_ENDPOINT = baseUrl;
    process.env.MONARCH_CHAT_MODEL_NAME = 'job-smoke-model';
    process.env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS = '1';

    const app = new MonarchApplication({
      enabledModules: ['assistant'],
      enableLocalSystemRouter: false,
    });

    try {
      const hanging = await app.submitIntentJob({
        text: 'hello, explain Monarch briefly',
        timeoutMs: 10000,
      });
      await slowRequestSeen;
      const cancelled = app.cancelIntentJob(hanging.id);
      expect(cancelled?.status).toBe('cancelled');

      hang = false;
      const next = await app.submitIntentJob({
        text: 'hello, explain Monarch briefly',
        timeoutMs: 10000,
      });
      const completed = await waitForTerminalJob(app, next.id);
      expect(completed.status).toBe('completed');
      expect(completed.result?.execution?.ok).toBe(true);
    } finally {
      await app.stop().catch(() => undefined);
      server.closeAllConnections();
      await close(server);
      restoreEnv('MONARCH_CHAT_MODEL_ENDPOINT', previousEndpoint);
      restoreEnv('MONARCH_CHAT_MODEL_NAME', previousModel);
      restoreEnv('MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS', previousAllowExternal);
    }
  }, 25000);

  it('lists recent jobs only within the same client scope and applies limit after injectable filtering', () => {
    const app = new MonarchApplication({
      enabledModules: ['assistant'],
      enableLocalSystemRouter: false,
    });
    const now = Date.now();

    seedJob(app, {
      id: 'job_running_latest',
      status: 'running',
      updatedAt: new Date(now).toISOString(),
      clientConversationId: 'conversation_a',
      clientSessionId: 'session_a',
    });
    seedJob(app, {
      id: 'job_paused_previous',
      status: 'completed',
      updatedAt: new Date(now - 1000).toISOString(),
      clientConversationId: 'conversation_a',
      clientSessionId: 'session_a',
      result: confirmationRequiredResult(),
    });
    seedJob(app, {
      id: 'job_other_scope_failure',
      status: 'failed',
      updatedAt: new Date(now - 500).toISOString(),
      clientConversationId: 'conversation_b',
      clientSessionId: 'session_a',
      error: 'other scope',
    });

    const missingScope = app.listRecentIntentJobs({
      source: 'desktop',
      clientConversationId: 'conversation_a',
      maxAgeMs: 5000,
      limit: 1,
    });
    expect(missingScope).toEqual([]);

    const recent = app.listRecentIntentJobs({
      source: 'desktop',
      clientConversationId: 'conversation_a',
      clientSessionId: 'session_a',
      maxAgeMs: 5000,
      limit: 1,
    });

    expect(recent).toHaveLength(1);
    expect(recent[0]?.jobId).toBe('job_paused_previous');
    expect(recent[0]?.normalizedStatus).toBe('paused_at_security_gate');
  });

  it('uses updatedAt for TTL so security gate actions can expire and become fresh again', () => {
    const app = new MonarchApplication({
      enabledModules: ['assistant'],
      enableLocalSystemRouter: false,
    });
    const now = Date.now();
    const staleJob = seedJob(app, {
      id: 'job_security_gate',
      status: 'completed',
      updatedAt: new Date(now - 6 * 60 * 1000).toISOString(),
      clientConversationId: 'conversation_a',
      clientSessionId: 'session_a',
      result: confirmationRequiredResult(),
    });

    const stale = app.listRecentIntentJobs({
      source: 'desktop',
      clientConversationId: 'conversation_a',
      clientSessionId: 'session_a',
      maxAgeMs: 5 * 60 * 1000,
      limit: 1,
    });
    expect(stale).toEqual([]);

    staleJob.status = 'cancelled';
    staleJob.updatedAt = new Date(now).toISOString();
    staleJob.finishedAt = new Date(now).toISOString();

    const fresh = app.listRecentIntentJobs({
      source: 'desktop',
      clientConversationId: 'conversation_a',
      clientSessionId: 'session_a',
      maxAgeMs: 5 * 60 * 1000,
      limit: 1,
    });
    expect(fresh[0]?.jobId).toBe('job_security_gate');
    expect(fresh[0]?.normalizedStatus).toBe('user_aborted');
  });
});

function createOpenAiCompatibleServer(reply: (() => string | null) | string = 'Monarch job ok'): Server {
  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      sendJson(response, 200, { data: [{ id: 'job-smoke-model' }] });
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      request.resume();
      request.on('close', () => {
        if (!response.writableEnded) {
          response.end();
        }
      });
      request.on('end', () => {
        const content = typeof reply === 'function' ? reply() : reply;
        if (content === null) {
          return;
        }
        sendJson(response, 200, {
          model: 'job-smoke-model',
          choices: [
            {
              message: {
                content,
              },
            },
          ],
        });
      });
      return;
    }

    sendJson(response, 404, { error: 'not-found' });
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Invalid test server address.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForTerminalJob(
  app: MonarchApplication,
  jobId: string
): Promise<NonNullable<ReturnType<MonarchApplication['getIntentJob']>>> {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'timeout']);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = app.getIntentJob(jobId);
    if (job && terminal.has(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Job did not reach a terminal state.');
}

function restoreEnv(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}

function seedJob(
  app: MonarchApplication,
  overrides: Record<string, unknown>
): Record<string, any> {
  const now = new Date().toISOString();
  const job: Record<string, any> = {
    id: overrides.id || `job_${Math.random().toString(36).slice(2)}`,
    text: 'previous action',
    source: 'desktop',
    status: 'completed',
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    startedAt: overrides.startedAt || now,
    finishedAt: overrides.finishedAt || now,
    timeoutMs: 90000,
    summary: 'seeded job',
    progress: ['seeded'],
    result: successResult(),
    error: null,
    cancelled: false,
    ...overrides,
  };
  const registry = (app as unknown as { intentJobs: Map<string, Record<string, any>> }).intentJobs;
  registry.set(String(job.id), job);
  return job;
}

function successResult(): Record<string, unknown> {
  return {
    route: {
      targetModuleId: 'workspace',
      capabilityId: 'workspace.files.write',
      input: {
        path: 'report.txt',
        auth: {
          authorization: 'Bearer secret',
        },
      },
    },
    plan: {
      steps: [
        {
          moduleId: 'workspace',
          capabilityId: 'workspace.files.write',
          input: {
            path: 'report.txt',
            token: 'secret-token',
          },
        },
      ],
    },
    execution: {
      ok: true,
      summary: 'ok',
      output: {
        path: 'report.txt',
      },
    },
    summary: 'ok',
  };
}

function confirmationRequiredResult(): Record<string, unknown> {
  return {
    ...successResult(),
    execution: {
      ok: false,
      summary: 'Confirmation required',
      error: 'confirmation-required',
    },
    summary: 'Confirmation required',
  };
}
