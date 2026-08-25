import { describe, expect, it, vi } from 'vitest';
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
import { IMAGE_PROVIDER_AGREEMENT_VERSION } from '../../src/image-generation';

describe('Monarch HTTP server security', () => {
  it('starts an explicit first-run model selection without restricting the chosen tier', async () => {
    const startModelInstall = vi.fn(() => ({
      schemaVersion: 2,
      ready: false,
      activeInstall: { source: 'onboarding', roles: ['qwen3.8-27b-pro'] },
    }));
    const server = createMonarchHttpServer({
      app: createFakeApplication({ startModelInstall } as Partial<MonarchApplication>),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/models/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: ['qwen3.8-27b-pro'], source: 'onboarding' }),
      });
      expect(response.status).toBe(202);
      expect(startModelInstall).toHaveBeenCalledWith(['qwen3.8-27b-pro'], 'onboarding');
    } finally {
      await close(server);
    }
  });

  it('persists model setup skip and one-time welcome acknowledgement', async () => {
    const skipModelOnboarding = vi.fn(async () => ({
      schemaVersion: 2,
      onboarding: { required: false, completion: 'skipped', welcomeRequired: true },
    }));
    const acknowledgeModelOnboardingWelcome = vi.fn(async () => ({
      schemaVersion: 2,
      onboarding: { required: false, completion: 'skipped', welcomeRequired: false },
    }));
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        skipModelOnboarding,
        acknowledgeModelOnboardingWelcome,
      } as Partial<MonarchApplication>),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);
    try {
      const skipped = await fetch(`${baseUrl}/api/models/onboarding/skip`, { method: 'POST' });
      expect(skipped.status).toBe(200);
      await expect(skipped.json()).resolves.toMatchObject({
        onboarding: { completion: 'skipped', welcomeRequired: true },
      });
      const acknowledged = await fetch(`${baseUrl}/api/models/onboarding/welcome`, { method: 'POST' });
      expect(acknowledged.status).toBe(200);
      await expect(acknowledged.json()).resolves.toMatchObject({
        onboarding: { welcomeRequired: false },
      });
      expect(skipModelOnboarding).toHaveBeenCalledOnce();
      expect(acknowledgeModelOnboardingWelcome).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });

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

  it('reports server readiness independently from degraded module health', async () => {
    let stateReads = 0;
    const app = createFakeApplication({
      getState: async () => {
        stateReads += 1;
        return {
          runtime: {
            snapshot: { modules: [], capabilities: [], events: [] },
            health: { ok: false },
            loadRecords: [],
          },
          app: {},
          models: {},
          modelRuntime: {},
          selectedModel: {},
          routerPipeline: {},
          lastIntent: null,
          system: { id: 'monarch.system.profile' },
        } as Awaited<ReturnType<MonarchApplication['getState']>>;
      },
    });
    const server = createMonarchHttpServer({
      app,
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);

    try {
      const ready = await fetch(`${baseUrl}/api/ready`);
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toEqual({ ok: true, ready: true });
      expect(stateReads).toBe(0);

      const health = await fetch(`${baseUrl}/api/health`);
      await expect(health.json()).resolves.toMatchObject({ ok: false });
      expect(stateReads).toBe(1);
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

      const dispositionHeaders = {
        'Content-Type': 'application/json',
        'X-Monarch-Session': 'unit-session-token',
      };
      const ordinaryChat = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
        method: 'POST',
        headers: dispositionHeaders,
        body: JSON.stringify({ text: 'что делать в случае ракетного обстрела?' }),
      });
      expect(ordinaryChat.headers.get('cache-control')).toBe('no-store');
      await expect(ordinaryChat.json()).resolves.toMatchObject({
        ok: true,
        disposition: { mode: 'chat', kind: 'explanation', requiresExternalResearch: false },
      });

      const freshNews = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
        method: 'POST',
        headers: dispositionHeaders,
        body: JSON.stringify({ text: 'Найди мне последние новости OpenAI' }),
      });
      expect(freshNews.headers.get('deprecation')).toBeNull();
      await expect(freshNews.json()).resolves.toMatchObject({
        ok: true,
        disposition: {
          mode: 'chat',
          kind: 'search',
          requiresExternalResearch: true,
          hasLocalEffectTarget: false,
        },
      });

      const learningSiteLookup = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
        method: 'POST',
        headers: dispositionHeaders,
        body: JSON.stringify({
          text: 'мне нужен какой то сайт который позволит эффективно учить пайтон,найди такой сайт',
        }),
      });
      await expect(learningSiteLookup.json()).resolves.toMatchObject({
        ok: true,
        disposition: {
          mode: 'chat',
          kind: 'search',
          requiresExternalResearch: true,
          hasLocalEffectTarget: false,
        },
      });

      const quotedFreshNews = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
        method: 'POST',
        headers: dispositionHeaders,
        body: JSON.stringify({
          text: 'Вот текст: «Найди последние новости OpenAI». Это пример запроса для проверки интерфейса.',
        }),
      });
      await expect(quotedFreshNews.json()).resolves.toMatchObject({
        ok: true,
        disposition: {
          mode: 'chat',
          kind: 'text_generation',
          requiresExternalResearch: false,
          hasLocalEffectTarget: false,
        },
      });

      const steamAction = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
        method: 'POST',
        headers: dispositionHeaders,
        body: JSON.stringify({ text: 'открой стим' }),
      });
      await expect(steamAction.json()).resolves.toMatchObject({
        ok: true,
        disposition: { mode: 'agent', kind: 'system_action' },
      });

      const requestedMaterial = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
        method: 'POST',
        headers: dispositionHeaders,
        body: JSON.stringify({
          text: '1. Записи восстановлены. 2. Claim Gate ловит «выполнил» и «запустил». 3. Workspace Monarch защищён.',
          history: [
            { role: 'user', content: 'Хочешь скину список?' },
            { role: 'assistant', content: 'Скидывай, я готов посмотреть.' },
          ],
        }),
      });
      await expect(requestedMaterial.json()).resolves.toMatchObject({
        ok: true,
        disposition: {
          mode: 'chat',
          kind: 'material_review',
          requiresExternalResearch: false,
        },
      });

      const unicodeBoundary = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
        method: 'POST',
        headers: dispositionHeaders,
        body: JSON.stringify({
          text: `Объясни ${'я'.repeat(15_990)}`,
          history: [{ role: 'assistant', content: `Покажи ${'щ'.repeat(3_990)}` }],
        }),
      });
      expect(unicodeBoundary.status).toBe(200);

      for (const history of [
        Array.from({ length: 5 }, () => ({ role: 'user', content: 'bounded' })),
        [{ role: 'system', content: 'must not enter disposition history' }],
        [{ role: 'assistant', content: ' '.repeat(10) }],
      ]) {
        const invalidHistory = await fetch(`${baseUrl}/api/oscar/request-disposition`, {
          method: 'POST',
          headers: dispositionHeaders,
          body: JSON.stringify({ text: 'Проверь контракт', history }),
        });
        expect(invalidHistory.status).toBe(400);
        await expect(invalidHistory.json()).resolves.toMatchObject({
          error: 'invalid-oscar-disposition-history',
        });
      }

      const promptInQuery = await fetch(
        `${baseUrl}/api/oscar/request-disposition?text=${encodeURIComponent('открой стим')}`,
        { headers: { 'X-Monarch-Session': 'unit-session-token' } },
      );
      expect(promptInQuery.status).toBe(405);
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

  it('adapts legacy agent dispatch into one server-owned Oscar Turn', async () => {
    let capturedContext: Record<string, unknown> | undefined;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        submitAgentSurfaceIntent: async (submission) => {
          capturedContext = submission.context;
          return {
            intent: { id: 'oscar_turn_agent', source: 'api', text: submission.text, createdAt: new Date(0).toISOString() },
            route: null,
            plan: null,
            execution: { ok: true, summary: 'Verified Turn.', output: { turnId: 'oscar_turn_agent', status: 'succeeded' } },
            summary: 'Verified Turn.',
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
      const payload = await response.json() as { handled?: boolean; result?: { intent?: { id?: string } } };

      expect(response.status).toBe(200);
      expect(response.headers.get('deprecation')).toBe('true');
      expect(payload.handled).toBe(true);
      expect(payload.result?.intent?.id).toBe('oscar_turn_agent');
      expect(capturedContext).toMatchObject({
        legacyAgentDispatch: true,
        clientConversationId: expect.stringMatching(/^legacy:api:/),
        clientRequestId: expect.stringMatching(/^legacy:api:/),
      });
    } finally {
      await close(server);
    }
  });

  it('creates skills only through the attested draft, validation, and read-back flow', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-http-skill-authoring-'));
    const server = createMonarchHttpServer({
      app: createFakeApplication({ workspaceRoot: root } as Partial<MonarchApplication>),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      desktopAttestationToken: 'unit-desktop-attestation',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);
    const desktopHeaders = {
      'Content-Type': 'application/json',
      'X-Monarch-Session': 'unit-session-token',
      'X-Monarch-Desktop-Attestation': 'unit-desktop-attestation',
    };

    try {
      const apiOnly = await fetch(`${baseUrl}/api/skills/draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Session': 'unit-session-token',
        },
        body: JSON.stringify({ purpose: 'Проверяй тестовый релиз перед публикацией.' }),
      });
      expect(apiOnly.status).toBe(403);

      const draftResponse = await fetch(`${baseUrl}/api/skills/draft`, {
        method: 'POST',
        headers: desktopHeaders,
        body: JSON.stringify({
          purpose: 'Проверяй уникальный релиз Aurora перед публикацией и подтверждай тестами.',
          scope: 'project',
        }),
      });
      const draftPayload = await draftResponse.json() as any;
      expect(draftResponse.status).toBe(200);
      expect(draftPayload).toMatchObject({
        ok: true,
        valid: true,
        draft: { source: 'auto', scope: 'project', allowImplicitInvocation: false },
      });

      const validationResponse = await fetch(`${baseUrl}/api/skills/validate`, {
        method: 'POST',
        headers: desktopHeaders,
        body: JSON.stringify({ draft: draftPayload.draft }),
      });
      const validation = await validationResponse.json() as any;
      expect(validation).toMatchObject({ ok: true, valid: true, draftHash: draftPayload.draftHash });

      const createResponse = await fetch(`${baseUrl}/api/skills`, {
        method: 'POST',
        headers: desktopHeaders,
        body: JSON.stringify({
          draft: validation.draft,
          expectedDraftHash: validation.draftHash,
        }),
      });
      const created = await createResponse.json() as any;
      expect(createResponse.status).toBe(201);
      expect(created).toMatchObject({
        ok: true,
        receipt: { created: true, verified: true, draftHash: validation.draftHash },
        skill: { name: validation.draft.name, creationSource: 'auto' },
      });
      expect(created.receipt.packageHash).toBe(created.receipt.readBackHash);
    } finally {
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks durable Coder run content while zero retention is active', async () => {
    const app = createFakeApplication({
      getOwnerDevSettings: () => ({
        schemaVersion: 1,
        zeroRetentionEnabled: true,
        internetEnabled: true,
        memoryEnabled: true,
        historyContextEnabled: true,
        personalityEnabled: true,
        skillsEnabled: true,
        runtimeContextEnabled: true,
        qualityRegenerationEnabled: true,
        updatedAt: '',
      }),
    });
    const server = createMonarchHttpServer({
      app,
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);

    try {
      const start = await fetch(`${baseUrl}/api/coder/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Не сохраняй этот Coder prompt.', projectId: 'project-zero' }),
      });
      expect(start.status).toBe(409);
      await expect(start.json()).resolves.toMatchObject({
        error: 'coder-durable-run-disabled-by-zero-retention',
      });

      const resume = await fetch(`${baseUrl}/api/coder/runs/coder-run-zero/resume`, { method: 'POST' });
      expect(resume.status).toBe(409);
    } finally {
      await close(server);
    }
  });

  it('keeps local settings behind Desktop attestation instead of the API token', async () => {
    let reads = 0;
    const app = createFakeApplication({
      settingsCommandBus: {
        read: async (request: any) => {
          reads += 1;
          return {
            ...request,
            revision: 0,
            contentHash: 'a'.repeat(64),
            value: { records: [] },
          };
        },
      } as any,
    });
    const server = createMonarchHttpServer({
      app,
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'settings-api-token',
      desktopAttestationToken: 'settings-desktop-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);
    const body = JSON.stringify({ schemaVersion: 1, kind: 'memory', scope: { type: 'chat' } });

    try {
      const apiOnly = await fetch(`${baseUrl}/api/settings/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'settings-api-token' },
        body,
      });
      expect(apiOnly.status).toBe(403);
      await expect(apiOnly.json()).resolves.toMatchObject({ error: 'settings-desktop-required' });

      const wrongOrigin = await fetch(`${baseUrl}/api/settings/read`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.invalid',
          'X-Monarch-Desktop-Attestation': 'settings-desktop-token',
        },
        body,
      });
      expect(wrongOrigin.status).toBe(403);

      const desktop = await fetch(`${baseUrl}/api/settings/read`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Monarch-Desktop-Attestation': 'settings-desktop-token',
        },
        body,
      });
      expect(desktop.status).toBe(200);
      await expect(desktop.json()).resolves.toMatchObject({
        ok: true,
        context: { revision: 0, contentHash: 'a'.repeat(64) },
      });
      expect(reads).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('does not expose Owner authority or DEV policies to an unattested browser session', async () => {
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        getState: async () => ({
          authority: {
            tier: 'owner',
            source: 'signed-device-entitlement',
            entitlementId: 'owner-unit',
            keyId: 'owner-root-unit',
            verifiedAt: new Date(0).toISOString(),
            deviceIdPrefix: 'unit-device',
            diagnostic: null,
          },
          ownerDev: { zeroRetentionEnabled: true },
        } as Awaited<ReturnType<MonarchApplication['getState']>>),
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'owner-ui-session-token',
      desktopAttestationToken: 'owner-desktop-attestation',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);

    try {
      const browserResponse = await fetch(`${baseUrl}/api/state`, {
        headers: { 'X-Monarch-Session': 'owner-ui-session-token' },
      });
      await expect(browserResponse.json()).resolves.toMatchObject({
        authority: { tier: 'public', source: 'default' },
      });
      const browserPayload = await (await fetch(`${baseUrl}/api/state`, {
        headers: { 'X-Monarch-Session': 'owner-ui-session-token' },
      })).json() as Record<string, unknown>;
      expect(browserPayload).not.toHaveProperty('ownerDev');

      const desktopResponse = await fetch(`${baseUrl}/api/state`, {
        headers: {
          'X-Monarch-Session': 'owner-ui-session-token',
          'X-Monarch-Desktop-Attestation': 'owner-desktop-attestation',
        },
      });
      await expect(desktopResponse.json()).resolves.toMatchObject({
        authority: { tier: 'owner', source: 'signed-device-entitlement' },
        ownerDev: { zeroRetentionEnabled: true },
      });
    } finally {
      await close(server);
    }
  });

  it('keeps image policy Desktop-only while allowing typed generation handoffs from the trusted UI', async () => {
    let policyWrites = 0;
    let policyInput: Record<string, unknown> | null = null;
    let generations = 0;
    let translations = 0;
    const app = createFakeApplication({
      translateImagePrompt: async (text: string) => {
        translations += 1;
        return {
          schemaVersion: 1,
          sourceText: text,
          translatedText: 'orange cat',
          targetLanguage: 'en',
          model: 'gemma4-fast',
          stateless: true,
          memoryUsed: false,
          webUsed: false,
        };
      },
      imageGeneration: {
        readContext: async () => ({
          schemaVersion: 1,
          policy: { matureMode: 'off', matureModeActive: false, incognitoPersistence: 'never' },
          library: [],
        }),
        updatePolicy: async (input: Record<string, unknown>) => {
          policyWrites += 1;
          policyInput = input;
          return { matureMode: 'off', matureModeActive: false, providerConsentCurrent: true, providerAgreementVersion: IMAGE_PROVIDER_AGREEMENT_VERSION };
        },
        evaluateIntent: async (text: string) => ({
          schemaVersion: 1,
          isImageGeneration: text.includes('image'),
          prompt: text.includes('image') ? text : '',
          contentRating: 'safe',
          disposition: text.includes('image') ? 'ready' : 'not-image-generation',
          providerId: 'perchance-interactive',
        }),
        startGeneration: async () => {
          generations += 1;
          return {
            schemaVersion: 1,
            status: 'queued',
            jobId: 'image_job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            providerId: 'aihorde-anonymous',
            providerLabel: 'AI Horde',
            contentRating: 'safe',
            privacyMode: 'persistent',
            savePolicy: 'save',
            prompt: 'lake',
            requestedCount: 1,
            queuePosition: 2,
            waitTimeSeconds: 12,
            finishedCount: 0,
            processingCount: 0,
            waitingCount: 1,
            sharedWithLaion: true,
            results: [],
            warnings: [],
            error: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          };
        },
        readGenerationJob: async () => ({ status: 'processing', jobId: 'image_job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
        cancelGeneration: async () => ({ status: 'cancelled', jobId: 'image_job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
        saveGenerationResults: async () => ({ status: 'completed', jobId: 'image_job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', savePolicy: 'save' }),
        readGenerationResult: async () => ({ mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
      } as any,
    });
    const server = createMonarchHttpServer({
      app,
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'images-api-token',
      desktopAttestationToken: 'images-desktop-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);
    try {
      const contextResponse = await fetch(`${baseUrl}/api/images/context`, {
        headers: { 'X-Monarch-Session': 'images-api-token' },
      });
      expect(contextResponse.status).toBe(200);
      await expect(contextResponse.json()).resolves.toMatchObject({ context: { library: [] } });

      const agreementResponse = await fetch(`${baseUrl}/api/images/provider-agreement`, {
        headers: { 'X-Monarch-Session': 'images-api-token' },
      });
      expect(agreementResponse.status).toBe(200);
      await expect(agreementResponse.json()).resolves.toMatchObject({
        agreement: {
          version: IMAGE_PROVIDER_AGREEMENT_VERSION,
          provider: { name: 'AI Horde', minimumAge: 13 },
        },
      });

      const generationResponse = await fetch(`${baseUrl}/api/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'images-api-token' },
        body: JSON.stringify({ prompt: 'lake' }),
      });
      expect(generationResponse.status).toBe(202);
      await expect(generationResponse.json()).resolves.toMatchObject({ preparation: { status: 'queued', providerId: 'aihorde-anonymous' } });
      expect(generations).toBe(1);

      const jobResponse = await fetch(`${baseUrl}/api/images/generations/image_job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, {
        headers: { 'X-Monarch-Session': 'images-api-token' },
      });
      expect(jobResponse.status).toBe(200);
      await expect(jobResponse.json()).resolves.toMatchObject({ job: { status: 'processing' } });

      const resultResponse = await fetch(`${baseUrl}/api/images/generations/image_job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/results/0`, {
        headers: { 'X-Monarch-Session': 'images-api-token' },
      });
      expect(resultResponse.status).toBe(200);
      expect(resultResponse.headers.get('content-type')).toBe('image/png');

      const cancelResponse = await fetch(`${baseUrl}/api/images/generations/image_job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, {
        method: 'DELETE',
        headers: { 'X-Monarch-Session': 'images-api-token' },
      });
      expect(cancelResponse.status).toBe(200);
      await expect(cancelResponse.json()).resolves.toMatchObject({ job: { status: 'cancelled' } });

      const intentResponse = await fetch(`${baseUrl}/api/images/intents/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'images-api-token' },
        body: JSON.stringify({ text: 'create image' }),
      });
      expect(intentResponse.status).toBe(200);
      await expect(intentResponse.json()).resolves.toMatchObject({ intent: { isImageGeneration: true, disposition: 'ready' } });

      const translationResponse = await fetch(`${baseUrl}/api/images/prompt/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'images-api-token' },
        body: JSON.stringify({ text: 'рыжий кот' }),
      });
      expect(translationResponse.status).toBe(200);
      await expect(translationResponse.json()).resolves.toMatchObject({
        translation: {
          translatedText: 'orange cat',
          model: 'gemma4-fast',
          stateless: true,
          memoryUsed: false,
          webUsed: false,
        },
      });
      expect(translations).toBe(1);

      const apiOnlyPolicy = await fetch(`${baseUrl}/api/images/policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'images-api-token' },
        body: JSON.stringify({ action: 'provider-consent', enabled: true }),
      });
      expect(apiOnlyPolicy.status).toBe(403);

      const desktopPolicy = await fetch(`${baseUrl}/api/images/policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Desktop-Attestation': 'images-desktop-token' },
        body: JSON.stringify({
          action: 'provider-consent',
          enabled: true,
          agreementVersion: IMAGE_PROVIDER_AGREEMENT_VERSION,
          cloudProcessingAccepted: true,
          thirdPartyTermsAccepted: true,
        }),
      });
      expect(desktopPolicy.status).toBe(200);
      expect(policyWrites).toBe(1);
      expect(policyInput).toEqual({
        action: 'provider-consent',
        enabled: true,
        agreementVersion: IMAGE_PROVIDER_AGREEMENT_VERSION,
        cloudProcessingAccepted: true,
        thirdPartyTermsAccepted: true,
      });
    } finally {
      await close(server);
    }
  });

  it('keeps Personality preview Desktop-only and returns the runtime preview binding', async () => {
    let previews = 0;
    const app = createFakeApplication({
      previewPersonality: async (scope: any) => {
        previews += 1;
        return {
          scope,
          settingsRevision: 8,
          personality: {
            schemaVersion: 2,
            profileId: 'personality-direct',
            profileRevision: 3,
            profileHash: 'c'.repeat(64),
            variant: 'direct',
            name: 'Прямой',
            dimensions: {},
            addressForm: 'ты',
            language: 'ru',
            customRules: [],
          },
          answer: 'Короткий runtime-preview.',
        };
      },
    } as any);
    const server = createMonarchHttpServer({
      app,
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'preview-api-token',
      desktopAttestationToken: 'preview-desktop-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);
    const body = JSON.stringify({ scope: { type: 'coder-project', projectId: 'project-preview' } });
    try {
      const apiOnly = await fetch(`${baseUrl}/api/settings/personality/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'preview-api-token' },
        body,
      });
      expect(apiOnly.status).toBe(403);

      const desktop = await fetch(`${baseUrl}/api/settings/personality/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Desktop-Attestation': 'preview-desktop-token' },
        body,
      });
      expect(desktop.status).toBe(200);
      await expect(desktop.json()).resolves.toMatchObject({
        ok: true,
        preview: {
          settingsRevision: 8,
          answer: 'Короткий runtime-preview.',
          personality: { profileId: 'personality-direct', profileRevision: 3 },
        },
      });
      expect(previews).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('rejects text confirmation authority on every legacy execution adapter before any action runs', async () => {
    let turnCalls = 0;
    let capabilityCalls = 0;
    let proposalCalls = 0;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        submitAgentSurfaceIntent: async () => {
          turnCalls += 1;
          throw new Error('must not run');
        },
        executeCapability: async () => {
          capabilityCalls += 1;
          throw new Error('must not run');
        },
        submitActionProposal: async () => {
          proposalCalls += 1;
          throw new Error('must not run');
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      apiToken: 'unit-session-token',
      requireApiToken: true,
    });
    const baseUrl = await listen(server);
    const headers = { 'Content-Type': 'application/json', 'X-Monarch-Session': 'unit-session-token' };
    const cases = [
      ['/api/intent', { text: 'сделай действие' }],
      ['/api/intent-jobs', { text: 'сделай действие' }],
      ['/api/agent/dispatch', { text: 'сделай действие' }],
      ['/api/agent/jobs', { text: 'сделай действие' }],
      ['/api/agent/proposals', { proposal: { capabilityId: 'workspace.files.write', args: {} } }],
      ['/api/execute', { moduleId: 'workspace', capabilityId: 'workspace.files.write', input: {} }],
      ['/api/execute-stream', { moduleId: 'workspace', capabilityId: 'workspace.files.write', input: {} }],
    ] as const;
    try {
      for (const [endpoint, payload] of cases) {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...payload, confirmed: true, confirmationToken: 'я подтверждаю' }),
        });
        expect(response.status, endpoint).toBe(410);
        await expect(response.json()).resolves.toMatchObject({ error: 'legacy-text-confirmation-disabled' });
      }
      expect({ turnCalls, capabilityCalls, proposalCalls }).toEqual({ turnCalls: 0, capabilityCalls: 0, proposalCalls: 0 });
    } finally {
      await close(server);
    }
  });

  it('pins Coder fast-chat to answer-only authority with coordinator-owned persistence', async () => {
    let captured: Parameters<MonarchApplication['executeCapability']>[0] | null = null;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        executeCapability: async (execution) => {
          captured = execution;
          return { ok: true, summary: 'answer', output: { response: { answer: 'Ответ.' } } };
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: false,
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/coder/fast-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Объясни код кратко.' }),
      });
      expect(response.status).toBe(200);
      expect(captured).toMatchObject({
        moduleId: 'oscar',
        capabilityId: 'oscar.chat.local',
        input: {
          incognito: true,
          execution_authority: 'none',
          persistence_owner: 'coordinator',
        },
      });
    } finally {
      await close(server);
    }
  });

  it('never executes an effectful legacy Action Protocol proposal outside a bound Turn', async () => {
    let captured: Record<string, unknown> | null = null;
    let directProposalCalls = 0;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        submitActionProposal: async () => {
          directProposalCalls += 1;
          throw new Error('effectful legacy proposal must not execute directly');
        },
        submitAgentSurfaceIntent: async (submission) => {
          captured = submission as unknown as Record<string, unknown>;
          return {
            intent: { id: 'oscar_turn_proposal', text: submission.text, source: 'api', createdAt: new Date(0).toISOString() },
            route: null,
            plan: null,
            execution: { ok: false, error: 'confirmation-required', summary: 'Action-card required.', output: { turnId: 'oscar_turn_proposal' } },
            summary: 'Action-card required.',
          } as any;
        },
        runtime: {
          kernel: {
            audit: async () => undefined,
            getCapability: () => ({ id: 'workspace.files.write', moduleId: 'workspace', risk: 'write' }),
          },
        } as any,
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
      const payload = await response.json() as { accepted?: boolean };
      expect(response.status).toBe(202);
      expect(payload.accepted).toBe(true);
      expect(directProposalCalls).toBe(0);
      expect(captured).toMatchObject({
        source: 'api',
        context: { legacyProposal: true },
      });
      expect(String((captured as any)?.text)).toContain('workspace.files.write');
    } finally {
      await close(server);
    }
  });

  it('adapts an effectful legacy capability call into a Turn and keeps read-only calls synchronous', async () => {
    let directExecutions = 0;
    let submittedText = '';
    const fake = createFakeApplication({
      submitAgentSurfaceIntent: async (submission) => {
        submittedText = submission.text;
        return {
          intent: { id: 'oscar_turn_execute', text: submission.text, source: 'api', createdAt: new Date(0).toISOString() },
          route: null,
          plan: null,
          execution: { ok: false, error: 'confirmation-required', summary: 'Action-card required.', output: { turnId: 'oscar_turn_execute' } },
          summary: 'Action-card required.',
        } as any;
      },
      executeCapability: async () => {
        directExecutions += 1;
        return { ok: true, summary: 'Observed read-only state.' } as any;
      },
      runtime: {
        kernel: {
          audit: async () => undefined,
          getCapability: (id: string) => id === 'workspace.files.write'
            ? { id, moduleId: 'workspace', risk: 'write' }
            : { id, moduleId: 'workspace', risk: 'read' },
        },
      } as any,
    });
    const server = createMonarchHttpServer({
      app: fake,
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1', port: 4317,
      apiToken: 'unit-session-token', requireApiToken: true,
    });
    const baseUrl = await listen(server);
    const headers = { 'Content-Type': 'application/json', 'X-Monarch-Session': 'unit-session-token' };
    try {
      const effectful = await fetch(`${baseUrl}/api/execute`, {
        method: 'POST', headers,
        body: JSON.stringify({ moduleId: 'workspace', capabilityId: 'workspace.files.write', input: { path: 'note.txt', content: 'ok' } }),
      });
      expect(effectful.status).toBe(202);
      await expect(effectful.json()).resolves.toMatchObject({ accepted: true, successor: '/api/oscar/turns' });
      expect(directExecutions).toBe(0);
      expect(submittedText).toContain('workspace.files.write');

      const readOnly = await fetch(`${baseUrl}/api/execute`, {
        method: 'POST', headers,
        body: JSON.stringify({ moduleId: 'workspace', capabilityId: 'workspace.files.read', input: { path: 'note.txt' }, includeState: false }),
      });
      expect(readOnly.status).toBe(200);
      expect(directExecutions).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('revokes Computer Use through the dedicated attested stop route without Agent planning', async () => {
    let captured: any = null;
    let agentTurns = 0;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        executeCapability: async (execution) => {
          captured = execution;
          return { ok: true, summary: 'Computer Use stopped.', output: { stopped: true } } as any;
        },
        submitAgentSurfaceIntent: async () => {
          agentTurns += 1;
          throw new Error('Emergency stop must not enter Agent planning.');
        },
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1',
      port: 4317,
      requireApiToken: true,
      apiToken: 'unit-session-token',
      desktopAttestationToken: 'computer-stop-desktop-token',
    });
    const baseUrl = await listen(server);

    try {
      const unauthenticated = await fetch(`${baseUrl}/api/computer-use/emergency-stop`, { method: 'POST' });
      expect(unauthenticated.status).toBe(401);

      const stopped = await fetch(`${baseUrl}/api/computer-use/emergency-stop`, {
        method: 'POST',
        headers: { 'X-Monarch-Desktop-Attestation': 'computer-stop-desktop-token' },
      });
      expect(stopped.status).toBe(200);
      await expect(stopped.json()).resolves.toMatchObject({ ok: true, result: { output: { stopped: true } } });
      expect(captured).toEqual({
        moduleId: 'computer',
        capabilityId: 'computer.control.stop',
        input: {},
        requestedBy: 'desktop-emergency-stop',
        source: 'desktop',
        confirmed: false,
      });
      expect(agentTurns).toBe(0);
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

      const read = await fetch(`${baseUrl}/api/permissions`, {
        headers: { 'X-Monarch-Session': 'unit-session-token' },
      });
      await expect(read.json()).resolves.toMatchObject({
        ok: true,
        profile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
        authority: { tier: 'public', source: 'default' },
      });

      const authorityMutation = await fetch(`${baseUrl}/api/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'unit-session-token' },
        body: JSON.stringify({ autonomyMode: 'full-local', authority: { tier: 'owner' } }),
      });
      expect(authorityMutation.status).toBe(400);
      await expect(authorityMutation.json()).resolves.toMatchObject({ error: 'authority-read-only' });
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

  it('adapts legacy Agent jobs into durable Oscar Turns without an in-memory job authority map', async () => {
    let captured: any;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        submitAgentSurfaceIntent: async (submission: any) => {
          captured = submission;
          return {
            intent: { id: 'oscar_turn_security', source: 'api', text: submission.text, createdAt: new Date(0).toISOString() },
            route: null,
            plan: null,
            execution: { ok: false, error: 'turn-running', summary: 'Running.', output: { turnId: 'oscar_turn_security', status: 'running' } },
            summary: 'Running.',
          } as any;
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
        source: 'api',
        context: {
          legacyAgentDispatch: true,
          modelProposed: true,
          originatingUserText: 'Проверь возможные небезопасные подключения',
          proposalReason: 'Нужен Security scan',
        },
      });
      expect(captured).not.toHaveProperty('confirmed');
    } finally {
      await close(server);
    }
  });

  it('replays and finishes a legacy job SSE adapter from the durable Turn checkpoint', async () => {
    const completedTurn = {
      turn: {
        id: 'oscar_turn_completed',
        conversationId: 'legacy:api:test',
        source: 'api',
        status: 'succeeded',
        request: { text: 'internal-reflection' },
        outcome: { kind: 'answered', summary: 'Answered.', evidenceRefs: [], completedAt: new Date(0).toISOString() },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        revision: 3,
      },
      events: [{ sequence: 1, type: 'turn.outcome', payload: { outcome: 'answered' } }],
    } as any;
    const server = createMonarchHttpServer({
      app: createFakeApplication({
        oscarTurnCoordinator: {
          getTurn: async () => completedTurn,
          subscribe: () => () => undefined,
        } as any,
      }),
      publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'),
      host: '127.0.0.1', port: 4317,
      apiToken: 'unit-session-token', requireApiToken: true,
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/intent-jobs/${completedTurn.turn.id}/stream`, {
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
          capabilityId: 'voice.transcribe.prepare',
          input: {},
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
          capabilityId: 'voice.transcribe.prepare',
          input: {},
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
    getAuthorityContext: () => ({
      tier: 'public', source: 'default', entitlementId: null, keyId: null,
      verifiedAt: null, deviceIdPrefix: null, diagnostic: 'owner-entitlement-absent',
    }),
    setPermissionProfile: (profile: unknown) => profile,
    submitIntent: async () => ({ route: null }),
    submitAgentSurfaceIntent: async (submission: any) => ({
      intent: {
        id: 'oscar_turn_fake',
        text: submission.text,
        source: submission.source,
        createdAt: new Date(0).toISOString(),
        context: submission.context,
      },
      route: null,
      plan: null,
      execution: { ok: true, summary: 'Turn answered.', output: { turnId: 'oscar_turn_fake', status: 'succeeded' } },
      summary: 'Turn answered.',
    }),
    workspaceRoot: process.cwd(),
    executeCapability: async () => ({
      ok: true,
      summary: 'ok',
    }),
    imageGeneration: {
      evaluateIntent: async () => ({
        schemaVersion: 1,
        isImageGeneration: false,
        prompt: '',
        contentRating: 'unknown',
        disposition: 'not-image-generation',
        providerId: 'perchance-interactive',
      }),
    },
    runtime: {
      kernel: {
        audit: async () => undefined,
        listCapabilities: () => [{ id: 'workspace.files.read' }],
        evaluateLocalSettingsCommand: () => ({
          outcome: 'allow',
          reason: 'Attested local test command.',
          policyDecisionHash: 'f'.repeat(64),
        }),
        getCapability: (capabilityId: string) => ({
          id: capabilityId,
          moduleId: capabilityId.split('.')[0] || 'unknown',
          title: capabilityId,
          description: capabilityId,
          risk: 'read',
        }),
      },
    },
    oscarTurnCoordinator: {
      persistentStore: { listTurns: async () => [] },
      volatileStore: { listTurns: async () => [] },
      getTurn: async () => null,
      subscribe: () => () => undefined,
    },
    settingsCommandBus: {
      read: async () => ({
        schemaVersion: 1,
        kind: 'memory',
        scope: { type: 'chat' },
        revision: 0,
        contentHash: 'a'.repeat(64),
        value: { records: [] },
      }),
      execute: async () => {
        throw new Error('settings-command-not-configured');
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
