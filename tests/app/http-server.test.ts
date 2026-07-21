import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http, { type Server } from 'node:http';
import {
  createMonarchHttpServer,
  isLoopbackRemoteAddress,
  isMutationPeerAllowed,
  type MonarchApplication,
} from '../../src/app';

describe('Monarch HTTP server security', () => {
  it('uses the socket peer instead of a spoofable Host header for mutation trust', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('::1')).toBe(true);
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('192.168.1.40')).toBe(false);
    expect(isLoopbackRemoteAddress('10.0.0.8')).toBe(false);
    expect(isMutationPeerAllowed('192.168.1.40', false)).toBe(false);
    expect(isMutationPeerAllowed('192.168.1.40', true)).toBe(true);
  });

  it('injects the UI session token for a real loopback page request', async () => {
    const server = createMonarchHttpServer({
      app: createFakeApplication(),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const html = await (await fetch(baseUrl)).text();
      expect(html).toContain('name="monarch-api-token"');
      expect(html).toContain('unit-session-token');
    } finally {
      await close(server);
    }
  });

  it('does not disclose the UI session token to a non-loopback peer with a spoofed loopback Host', async () => {
    const server = createMonarchHttpServer({
      app: createFakeApplication(),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '0.0.0.0',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });

    const response = await dispatchStaticRequest(server, '192.168.1.40', '127.0.0.1:4317');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="monarch-api-token" content=""');
    expect(response.body).not.toContain('unit-session-token');
  });

  it('rejects a Coder run without an explicit project id before resolving the controller', async () => {
    const server = createMonarchHttpServer({
      app: createFakeApplication(),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/coder/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Проверь проект.' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'missing-coder-project' });
    } finally {
      await close(server);
    }
  });

  it('should require session tokens for sensitive GET endpoints', async () => {
    const server = createMonarchHttpServer({
      app: createFakeApplication(),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const unauthenticated = await fetch(`${baseUrl}/api/system`);
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(`${baseUrl}/api/system`, {
        headers: { 'X-Monarch-Session': 'unit-session-token' },
      });
      expect(authenticated.status).toBe(200);
      await expect(authenticated.json()).resolves.toMatchObject({
        id: 'monarch.system.profile',
      });
    } finally {
      await close(server);
    }
  });

  it('should block static sibling-prefix path traversal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-http-static-'));
    const publicRoot = path.join(root, 'public');
    const evilRoot = path.join(root, 'public-evil');
    await mkdir(publicRoot, { recursive: true });
    await mkdir(evilRoot, { recursive: true });
    await writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><title>ok</title>', 'utf8');
    await writeFile(path.join(evilRoot, 'secret.txt'), 'outside static root', 'utf8');

    const server = createMonarchHttpServer({
      app: createFakeApplication(),
      publicDirectory: publicRoot,
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);

    try {
      const traversalStatus = await getRawStatus(baseUrl, '/%2e%2e%2fpublic-evil/secret.txt');
      expect(traversalStatus).toBe(403);
    } finally {
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves Studio raster assets with browser-safe content types', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-http-media-'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>ok</title>', 'utf8');
    await writeFile(path.join(root, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const server = createMonarchHttpServer({
      app: createFakeApplication(),
      publicDirectory: root,
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/preview.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
    } finally {
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exposes skill metadata progressively and protects it with the session token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-http-skills-'));
    const skillDirectory = path.join(root, '.agents', 'skills', 'unit-review');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), `---
name: unit-review
description: Review unit test changes and find regressions.
---

Inspect the changed tests and run the focused suite.
`, 'utf8');
    const server = createMonarchHttpServer({
      app: createFakeApplication({ workspaceRoot: root } as Partial<MonarchApplication>),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      expect((await fetch(`${baseUrl}/api/skills`)).status).toBe(401);
      const response = await fetch(`${baseUrl}/api/skills?query=review+unit+test+changes`, {
        headers: { 'X-Monarch-Session': 'unit-session-token' },
      });
      const payload = await response.json() as { matches: Array<{ skill: Record<string, unknown> }> };

      expect(response.status).toBe(200);
      expect(payload.matches[0]?.skill).toMatchObject({ name: 'unit-review', scope: 'project' });
      expect(payload.matches[0]?.skill).not.toHaveProperty('instructions');
    } finally {
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches Oscar system actions through the kernel lane with chat modules excluded', async () => {
    let capturedContext: Record<string, unknown> | undefined;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        submitIntent: async (submission) => {
          capturedContext = submission.context;
          return {
            intent: { id: 'intent_agent', source: 'api', text: submission.text, createdAt: new Date(0).toISOString() },
            route: {
              intentId: 'intent_agent',
              targetModuleId: 'workspace',
              capabilityId: 'workspace.files.read',
              confidence: 0.95,
              reason: 'unit',
              permissionMode: 'allow',
              input: { path: 'PROJECT.md' },
            },
            plan: null,
            execution: { ok: true, summary: 'File read.', output: { content: 'ok' } },
            summary: 'File read.',
          } as any;
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/agent/dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Session': 'unit-session-token',
        },
        body: JSON.stringify({ text: 'прочитай PROJECT.md' }),
      });
      const payload = await response.json() as { handled?: boolean; result?: { route?: { targetModuleId?: string } } };

      expect(response.status).toBe(200);
      expect(payload.handled).toBe(true);
      expect(payload.result?.route?.targetModuleId).toBe('workspace');
      expect(capturedContext).toMatchObject({
        agentDispatch: true,
        excludedModuleIds: ['assistant', 'oscar'],
      });
    } finally {
      await close(server);
    }
  });

  it('accepts typed Action Protocol proposals without routing executable text', async () => {
    let captured: Record<string, unknown> | null = null;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        submitActionProposal: async (submission) => {
          captured = submission as unknown as Record<string, unknown>;
          return {
            proposal: {
              version: 1,
              proposalId: 'proposal_http',
              intentId: 'intent_http',
              intentHash: 'a'.repeat(64),
              capabilityId: 'workspace.files.write',
              args: { path: 'notes/http.txt', content: 'ok' },
              reason: 'unit',
              expectedEffect: 'write note',
              reversibility: 'reversible',
              scope: { level: 'single-object' },
              riskVector: { effect: 'write', scope: 'single-object', reversibility: 'reversible', externality: 'local', privilege: 'user', data: 'workspace', novelty: 'new-args' },
              idempotencyKey: `action:${'b'.repeat(64)}`,
              canonicalHash: 'b'.repeat(64),
              provenance: { model: 'unit', skillIds: [], source: 'runtime-grammar' },
            },
            result: { ok: true, summary: 'written' },
          } as any;
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/agent/proposals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Session': 'unit-session-token',
        },
        body: JSON.stringify({
          proposal: { capabilityId: 'workspace.files.write', args: { path: 'notes/http.txt', content: 'ok' } },
          originatingUserText: 'создай заметку',
        }),
      });
      expect(response.status).toBe(200);
      expect(captured).toMatchObject({
        originatingUserText: 'создай заметку',
        proposal: { capabilityId: 'workspace.files.write', args: { path: 'notes/http.txt', content: 'ok' } },
      });
    } finally {
      await close(server);
    }
  });

  it('maps the single autonomy control onto the compatibility permission profile', async () => {
    let captured: Record<string, unknown> | null = null;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        setPermissionProfile: (profile) => {
          captured = profile as unknown as Record<string, unknown>;
          return profile;
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'unit-session-token' },
        body: JSON.stringify({ autonomyMode: 'full-local' }),
      });
      expect(response.status).toBe(200);
      expect(captured).toEqual({
        autonomyMode: 'full-local',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'on-request',
      });
    } finally {
      await close(server);
    }
  });

  it('exposes hash-guarded action rollback through the local agent API', async () => {
    let capturedLedgerId = '';
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        rollbackAction: async (ledgerId) => {
          capturedLedgerId = ledgerId;
          return {
            status: 'rolled-back',
            targetPath: path.join(process.cwd(), 'notes', 'rollback.txt'),
            capturedAt: new Date(0).toISOString(),
            updatedAt: new Date(1).toISOString(),
            reason: 'restored',
          };
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/agent/ledger/ledger_test/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'unit-session-token' },
        body: '{}',
      });
      const payload = await response.json() as { ok?: boolean; rollback?: { status?: string } };
      expect(response.status).toBe(200);
      expect(capturedLedgerId).toBe('ledger_test');
      expect(payload).toMatchObject({ ok: true, rollback: { status: 'rolled-back' } });
    } finally {
      await close(server);
    }
  });

  it('queues Oscar agent actions with chat modules excluded for streamed progress', async () => {
    let captured: any;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        submitIntentJob: async (submission: any) => {
          captured = submission;
          return { id: 'job_security', status: 'queued', text: submission.text } as any;
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1', port: 4317,
      apiToken: 'unit-session-token', requireApiToken: true,
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/agent/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'unit-session-token' },
        body: JSON.stringify({
          text: 'Проверь сетевые подключения',
          context: {
            modelProposed: true,
            originatingUserText: 'Проверь возможные небезопасные подключения',
            proposalReason: 'Нужен Security scan',
            excludedModuleIds: [],
            agentDispatch: false,
          },
        }),
      });
      expect(response.status).toBe(202);
      expect(captured).toMatchObject({
        source: 'api', confirmed: false,
        context: {
          agentDispatch: true,
          excludedModuleIds: ['assistant', 'oscar'],
          modelProposed: true,
          originatingUserText: 'Проверь возможные небезопасные подключения',
          proposalReason: 'Нужен Security scan',
        },
      });
    } finally {
      await close(server);
    }
  });

  it('finishes an intent-job SSE stream when the job completed before subscription', async () => {
    const completedJob = { id: 'job_completed', status: 'completed', text: 'internal-reflection' } as any;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        getIntentJob: () => completedJob,
        runtime: {
          kernel: {
            subscribeEvent: () => () => undefined,
          },
        } as any,
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1', port: 4317,
      apiToken: 'unit-session-token', requireApiToken: true,
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/intent-jobs/${completedJob.id}/stream`, {
        headers: { 'X-Monarch-Session': 'unit-session-token' },
        signal: AbortSignal.timeout(2000),
      });
      const text = await response.text();

      expect(text).toContain('event: started');
      expect(text).toContain('event: done');
    } finally {
      await close(server);
    }
  });

  it('can omit the expensive application state snapshot for latency-sensitive capability calls', async () => {
    let stateReads = 0;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        getState: async () => {
          stateReads += 1;
          return { marker: 'full-state' } as any;
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'unit-session-token',
      };
      const lightweight = await fetch(`${baseUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          moduleId: 'voice',
          capabilityId: 'voice.mode.classify',
          input: { text: 'привет' },
          requestedBy: 'ui:voice-mode',
          includeState: false,
        }),
      });
      const lightweightPayload = await lightweight.json() as Record<string, unknown>;
      expect(lightweightPayload).not.toHaveProperty('state');
      expect(stateReads).toBe(0);

      const compatible = await fetch(`${baseUrl}/api/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          moduleId: 'voice',
          capabilityId: 'voice.mode.classify',
          input: { text: 'привет' },
          requestedBy: 'unit',
        }),
      });
      await expect(compatible.json()).resolves.toMatchObject({
        state: { marker: 'full-state' },
      });
      expect(stateReads).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('should hide internal exception details in JSON errors', async () => {
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        getState: async () => {
          throw new Error('secret stack C:\\Monarch\\token.txt');
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/state`, {
        headers: { 'X-Monarch-Session': 'unit-session-token' },
      });
      const payload = await response.json() as { message?: string };

      expect(response.status).toBe(500);
      expect(payload.message).toBe('Monarch столкнулся с внутренней ошибкой. Детали остались в локальных логах.');
      expect(JSON.stringify(payload)).not.toContain('token.txt');
    } finally {
      await close(server);
    }
  });

  it('should sanitize execute-stream events and hide thrown stream details', async () => {
    async function* stream() {
      yield { type: 'token\nbad', data: 'hello\nworld' };
      throw new Error('stream secret C:\\Monarch\\token.txt');
    }

    const server = createMonarchHttpServer({
      app: createFakeApplication({
        executeCapability: async () => ({
          ok: true,
          summary: 'stream',
          output: { stream: stream() },
        }),
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/execute-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Session': 'unit-session-token',
        },
        body: JSON.stringify({
          moduleId: 'oscar',
          capabilityId: 'oscar.chat.stream',
          requestedBy: 'unit',
        }),
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: message');
      expect(text).toContain('data: "hello\\nworld"');
      expect(text).toContain('Поток ответа прервался. Попробуй повторить запрос.');
      expect(text).not.toContain('token.txt');
      expect(text).not.toContain('event: token\nbad');
    } finally {
      await close(server);
    }
  });

  it('does not append a stream error after a terminal done event', async () => {
    async function* stream() {
      yield { type: 'token', data: { token: 'готов' } };
      yield { type: 'done', data: { ok: true } };
      throw new Error('backend recycled after terminal event');
    }

    const server = createMonarchHttpServer({
      app: createFakeApplication({
        executeCapability: async () => ({
          ok: true,
          summary: 'stream',
          output: { stream: stream() },
        }),
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/execute-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Session': 'unit-session-token',
        },
        body: JSON.stringify({
          moduleId: 'oscar',
          capabilityId: 'oscar.chat.stream',
          requestedBy: 'unit',
        }),
      });
      const text = await response.text();

      expect(text).toContain('event: done');
      expect(text).toContain('"ok":true');
      expect(text).not.toContain('event: error');
      expect(text).not.toContain('Поток ответа прервался');
    } finally {
      await close(server);
    }
  });
});

function createFakeApplication(overrides: Partial<MonarchApplication> = {}): MonarchApplication {
  const app = {
    start: async () => undefined,
    stop: async () => undefined,
    getState: async () => ({
      runtime: {
        snapshot: {
          modules: [],
          capabilities: [],
          events: [],
        },
        health: { ok: true },
        loadRecords: [],
      },
      app: {},
      models: {},
      modelRuntime: {},
      selectedModel: {},
      routerPipeline: {},
      lastIntent: null,
      system: { id: 'monarch.system.profile' },
    }),
    getSystemProfile: () => ({ id: 'monarch.system.profile' }),
    getPermissionProfile: () => ({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }),
    setPermissionProfile: (profile: unknown) => profile,
    submitIntent: async () => ({ route: null }),
    workspaceRoot: process.cwd(),
    executeCapability: async () => ({
      ok: true,
      summary: 'ok',
    }),
    runtime: {
      kernel: {
        audit: () => undefined,
      },
    },
  } as unknown as MonarchApplication;
  return {
    ...app,
    ...overrides,
  } as MonarchApplication;
}

function getRawStatus(baseUrl: string, rawPath: string): Promise<number> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: url.hostname,
      port: url.port,
      path: rawPath,
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode || 0));
    });
    request.on('error', reject);
  });
}

function dispatchStaticRequest(
  server: Server,
  remoteAddress: string,
  host: string,
): Promise<{ statusCode: number; body: string }> {
  const listener = server.listeners('request')[0] as ((request: unknown, response: unknown) => void) | undefined;
  if (!listener) throw new Error('HTTP request listener is missing.');
  return new Promise((resolve, reject) => {
    let statusCode = 0;
    const chunks: string[] = [];
    const response = {
      headersSent: false,
      writeHead(code: number) {
        statusCode = code;
        this.headersSent = true;
        return this;
      },
      write(chunk: unknown) {
        chunks.push(String(chunk ?? ''));
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) chunks.push(String(chunk));
        resolve({ statusCode, body: chunks.join('') });
      },
    };
    try {
      listener.call(server, {
        method: 'GET',
        url: '/',
        headers: { host },
        socket: { remoteAddress },
      }, response);
    } catch (error) {
      reject(error);
    }
  });
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
