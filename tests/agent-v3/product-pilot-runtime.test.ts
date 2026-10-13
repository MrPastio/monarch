import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MonarchKernel } from '../../src/core/kernel';
import { ASTRA_PRODUCT_PILOT_MODE, createAstraProductPilotRuntime } from '../../src/app/astra-product-pilot';
import { OscarTurnCoordinator } from '../../src/oscar-turn/coordinator';
import { InMemoryOscarTurnStore } from '../../src/oscar-turn/turn-store';
import { ComputerModule } from '../../src/modules/computer';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';
import { ASTRA_TELEGRAM_CONSENT_VERSION, ASTRA_TELEGRAM_REMOTE_MODE,
  createAstraTelegramRemoteAdmissionPolicy } from '../../src/app/astra-telegram-admission';
import { AstraSourceGoalCompiler } from '../../src/app/astra-source-goal-compiler';
import { WorkspaceModule } from '../../src/modules/workspace';
import { astraAgentLocalModelChoiceAllowed, renderAstraCertifiedReadPresentation } from '../../src/app/astra-task-facade';
import { MonarchApplication } from '../../src/app/application';
import { OscarClient } from '../../src/modules/oscar/client';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { TelegramModule, type TelegramIntentDispatcher } from '../../src/modules/telegram';
import { pickAstraTelegramTarget } from '../../desktop/electron/astra-product-host.mjs';
import { ASTRA_RUNTIME_PILOT_MODE, ASTRA_TELEGRAM_PILOT_MODE } from '../../desktop/electron/astra-pilot-policy.mjs';
import { maxCloudPreparedModelDigest, type MaxCloudRole } from '../../src/agent-v3/max-cloud-catalog';

const roots: string[] = [];
const JOURNAL_KEY = Buffer.alloc(32, 0x4a);
const JOURNAL_KEY_ENV = JOURNAL_KEY.toString('base64');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Astra same-owner product pilot composition', () => {
  it('composes local recall with the real Application settings owner, not a copied policy', async () => {
    const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-product-local-app-'))); roots.push(root);
    await writeFile(path.join(root, 'input.txt'), 'owned synthetic input');
    const env: Record<string, string | undefined> = {
      MONARCH_ASTRA_V3_PILOT: ASTRA_PRODUCT_PILOT_MODE, MONARCH_DESKTOP_ATTESTATION_TOKEN: 'a'.repeat(64),
      MONARCH_ASTRA_V3_HOST_TOKEN: 'b'.repeat(64), MONARCH_ASTRA_V3_MODEL_MODE: 'local',
      MONARCH_ASTRA_V3_JOURNAL_KEY: JOURNAL_KEY_ENV,
      MONARCH_ASTRA_V3_LOCAL_MEMORY: 'owner-settings-v1', MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT: 'http://127.0.0.1:9',
      MONARCH_ASTRA_V3_MODEL_HOST_TOKEN: 'c'.repeat(64), MONARCH_ASTRA_V3_MODEL_HOST_GENERATION: 'fixture',
      MONARCH_ASTRA_V3_MODEL_DIGEST: 'sha256:' + 'a'.repeat(64), MONARCH_ASTRA_V3_MODEL_DIGESTS: undefined,
      MONARCH_ASTRA_TELEGRAM_MODE: undefined, MONARCH_STATE_ROOT: path.join(root, 'state'),
      MONARCH_WORKSPACE_ROOT: root, MONARCH_SECRETS_ROOT: path.join(root, 'secrets'),
      MONARCH_DATA_ROOT: path.join(root, 'data'), MONARCH_LOGS_ROOT: path.join(root, 'logs'),
      MONARCH_MODELS_ROOT: path.join(root, 'models'),
    };
    const old = new Map(Object.keys(env).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const retrieve = vi.spyOn(OscarClient.prototype, 'retrieveAgentMemoryContext').mockResolvedValue({ schemaVersion: 1,
      scope: { type: 'chat' }, revision: '0:0', validityToken: 'sha256:' + 'd'.repeat(64), crossChatEnabled: false,
      explicitMemories: [], episodes: [], budgetChars: 2400, usedChars: 0, engine: 'fixture', semanticTimedOut: false, cache: 'miss' });
    let app: MonarchApplication | undefined;
    try {
      app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['workspace'], enableLocalSystemRouter: false,
        modelComponentManager: { initialize: async () => {}, stop: async () => {} } as any });
      expect(process.env.MONARCH_ASTRA_V3_JOURNAL_KEY).toBeUndefined();
      const pilot = app.astraProductPilot!;
      const selected = pilot.issuePickedTarget(pilot.actor, { version: 1, conversationId: 'local_settings',
        requestId: 'local_settings_target', access: 'observe', selectedPath: path.join(root, 'input.txt') });
      const turn = (await app.oscarTurnCoordinator.submit({ clientRequestId: 'local_settings_request', conversationId: 'local_settings',
        inputMessageId: 'local_settings_message', source: 'desktop', privacyMode: 'persistent', text: 'Analyze selected file',
        astra: { selectionId: selected.selectionId, goal: { kind: 'analyze', targets: [selected.targets[0]!.targetId], modelMode: 'local' } } })).turn;
      expect(await pilot.bridge.prepare(turn)).toMatchObject({ status: 'prepared', policyRevision: 'dev_0' });
      await app.ownerDevSettingsStore.execute({ schemaVersion: 1, clientRequestId: 'disable_fixture_memory', command: 'dev.update',
        scope: { type: 'chat' }, expectedRevision: 0, payload: { patch: { memoryEnabled: false } }, policyDecisionHash: 'b'.repeat(64) });
      expect(await pilot.bridge.prepare(turn)).toEqual({ status: 'omitted', reason: 'disabled' });
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(pilot.bridge.find(turn)).toBeNull();
    } finally {
      await app?.astraProductPilot?.stop(); await app?.stop(); retrieve.mockRestore();
      for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  it('rejects mixed local/cloud hosts and detached memory before allocating state', async () => {
    const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-product-pilot-'))); roots.push(root);
    const stateRoot = path.join(root, 'state'), kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const local = { endpoint: 'http://127.0.0.1:9', bearerToken: 'x'.repeat(64), hostGeneration: 'fixture', modelDigest: 'sha256:' + 'a'.repeat(64) };
    const options = { mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root, stateRoot, kernel,
      desktopAttestationToken: 'a'.repeat(64), hostToken: 'b'.repeat(64), journalEncryptionKey: JOURNAL_KEY };
    const cloud = { ...local, modelDigests: { 'openai/gpt-oss-120b': local.modelDigest, 'qwen/qwen3.8-27b': 'sha256:' + 'b'.repeat(64) } };
    expect(() => createAstraProductPilotRuntime({ ...options, modelHost: cloud, localModelHost: local })).toThrow('model-destination-conflict');
    expect(() => createAstraProductPilotRuntime({ ...options, localMemory: {} as any })).toThrow('model-destination-conflict');
    expect(() => createAstraProductPilotRuntime({ ...options, localModelHost: local,
      localMemory: { admission: {} as any, gate: { destination: 'local-desktop', modelDigest: 'sha256:' + 'b'.repeat(64),
        isCurrent: () => true, readValidity: async () => ({}) } } })).toThrow('local-memory-binding');
    expect(() => createAstraProductPilotRuntime({ ...options, localModelHost: { ...local, modelDigests: {
      'gemma4-fast': local.modelDigest,
      'qwen3-coder-30b-a3b-instruct': local.modelDigest,
      'deepseek-coder-v2-lite-instruct': 'sha256:' + 'c'.repeat(64),
    } } })).toThrow('local-model-host');
    await expect(access(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('binds an exact configured cloud MAX role to the generic V3 agent without exposing a credential', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-cloud-agent-'))); roots.push(root);
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const role = 'max-cloud:deepseek:deepseek-chat' as MaxCloudRole, digest = maxCloudPreparedModelDigest(role);
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'state'), kernel, desktopAttestationToken: 'desktop-' + 'd'.repeat(48),
      hostToken: 'host-' + 'h'.repeat(48), journalEncryptionKey: JOURNAL_KEY,
      optionalMaxHost: { endpoint: 'http://127.0.0.1:9', bearerToken: 'max-' + 'm'.repeat(48),
        hostGeneration: 'dynamic_cloud_fixture', modelDigest: digest, modelDigests: { [role]: digest }, dynamicMaxCloud: true } });
    expect(pilot?.facade.agentTasks).toBeDefined(); if (!pilot) throw Error('pilot-required');
    const binding = pilot.bridge.bindAgent({ clientRequestId: 'cloud_agent_request', conversationId: 'cloud_agent_conversation',
      inputMessageId: 'cloud_agent_message', source: 'desktop', privacyMode: 'persistent',
      request: { text: 'Проверь проект через MAX.', attachmentIds: [], modifiers: { requestedModel: role } } } as never);
    expect(binding).toMatchObject({ admission: 'ordinary-agent-v1', actor: pilot.actor,
      goal: { kind: 'agent', modelMode: 'max', modelChoice: role } });
    const executionProfile = { schemaVersion: 'monarch.agent-execution-profile.v1' as const,
      kind: 'coder-project' as const, projectId: 'project_max_coder', projectRoot: root,
      permissionProfile: { sandboxMode: 'workspace-write' as const, approvalPolicy: 'on-request' as const,
        autonomyMode: 'workspace-autonomous' as const } };
    const coderBinding = pilot.bridge.bindAgent({ clientRequestId: 'cloud_coder_request',
      conversationId: 'cloud_coder_conversation', inputMessageId: 'cloud_coder_message', source: 'coder',
      privacyMode: 'persistent', request: { text: 'Проверь проект через выбранный MAX.', attachmentIds: [],
        modifiers: { requestedModel: role, reasoningEffort: 'high', researchMode: 'off' }, executionProfile } } as never);
    expect(coderBinding).toMatchObject({ admission: 'ordinary-agent-v1', actor: pilot.coderActor,
      goal: { kind: 'agent', modelMode: 'max', modelChoice: role } });
    expect(JSON.stringify(binding)).not.toContain('max-' + 'm'.repeat(48));
    await pilot.stop();
  });
  it('binds an exact configured local role to desktop/API V3 agents without a fallback alias', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-local-agent-'))); roots.push(root);
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const digests = {
      'gemma4-fast': 'sha256:' + '1'.repeat(64),
      'qwen3-coder-30b-a3b-instruct': 'sha256:' + '2'.repeat(64),
      'deepseek-coder-v2-lite-instruct': 'sha256:' + '3'.repeat(64),
    } as const;
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'state'), kernel, desktopAttestationToken: 'desktop-' + 'd'.repeat(48),
      hostToken: 'host-' + 'h'.repeat(48), journalEncryptionKey: JOURNAL_KEY,
      localModelHost: { endpoint: 'http://127.0.0.1:9', bearerToken: 'local-' + 'l'.repeat(48),
        hostGeneration: 'local_agent_fixture', modelDigest: digests['gemma4-fast'], modelDigests: digests } });
    expect(pilot?.facade.agentTasks).toBeDefined(); if (!pilot) throw Error('pilot-required');
    const requestedModel = 'qwen3-coder-30b-a3b-instruct';
    const desktop = pilot.bridge.bindAgent({ clientRequestId: 'local_agent_request',
      conversationId: 'local_agent_conversation', inputMessageId: 'local_agent_message', source: 'desktop',
      privacyMode: 'persistent', request: { text: 'Проверь локально.', attachmentIds: [],
        modifiers: { requestedModel } } } as never);
    expect(desktop).toMatchObject({ admission: 'ordinary-agent-v1', actor: pilot.actor,
      goal: { kind: 'agent', modelMode: 'local', modelChoice: requestedModel } });
    const ordinaryDesktop = pilot.bridge.bindAgent({ clientRequestId: 'ordinary_local_agent_request',
      conversationId: 'ordinary_local_agent_conversation', inputMessageId: 'ordinary_local_agent_message', source: 'desktop',
      privacyMode: 'persistent', request: { text: 'Создай файл и проверь результат.', attachmentIds: [], modifiers: {
        reasoningEffort: 'low', webSearch: false, researchMode: 'auto', imageGenerationCapability: {
          schemaVersion: 1, available: true, surface: 'images', primaryProvider: {
            id: 'fixture', label: 'Fixture', mode: 'interactive', url: 'https://example.invalid/image' },
        } } } } as never);
    expect(ordinaryDesktop).toMatchObject({ admission: 'ordinary-agent-v1', actor: pilot.actor,
      goal: { kind: 'agent', modelMode: 'local', modelChoice: 'qwen3-coder-30b-a3b-instruct' } });
    expect(pilot.bridge.bindAgent({ clientRequestId: 'deep_local_agent_request',
      conversationId: 'deep_local_agent_conversation', inputMessageId: 'deep_local_agent_message', source: 'desktop',
      privacyMode: 'persistent', request: { text: 'Исследуй и создай файл.', attachmentIds: [],
        modifiers: { webSearch: true, researchMode: 'deep' } } } as never)).toBeNull();
    const apiActor = { source: 'api' as const, id: 'sha256:' + '8'.repeat(64) };
    const api = pilot.bridge.bindAgent({ clientRequestId: 'local_api_request', conversationId: 'local_api_conversation',
      inputMessageId: 'local_api_message', source: 'api', privacyMode: 'persistent', request: {
        text: 'Проверь локально через API.', attachmentIds: [], modifiers: { requestedModel },
        authenticatedAgentActor: apiActor } } as never);
    expect(api).toMatchObject({ actor: apiActor,
      goal: { kind: 'agent', modelMode: 'local', modelChoice: requestedModel } });
    expect(JSON.stringify([desktop, api])).not.toContain('local-' + 'l'.repeat(48));
    await pilot.stop();
    const balancedDigest = 'sha256:' + '4'.repeat(64);
    const balancedPilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'balanced-state'), kernel, desktopAttestationToken: 'desktop-' + 'e'.repeat(48),
      hostToken: 'host-' + 'i'.repeat(48), journalEncryptionKey: JOURNAL_KEY,
      localModelHost: { endpoint: 'http://127.0.0.1:9', bearerToken: 'balanced-' + 'b'.repeat(48),
        hostGeneration: 'balanced_agent_fixture', modelDigest: digests['gemma4-fast'],
        modelDigests: { 'gemma4-fast': digests['gemma4-fast'], 'gemma4-balanced': balancedDigest } } });
    const balancedBinding = balancedPilot?.bridge.bindAgent({ clientRequestId: 'balanced_agent_request',
      conversationId: 'balanced_agent_conversation', inputMessageId: 'balanced_agent_message', source: 'desktop',
      privacyMode: 'persistent', request: { text: 'Создай и проверь файл.', attachmentIds: [],
        modifiers: { researchMode: 'auto', webSearch: false } } } as never);
    expect(balancedBinding).toMatchObject({
      goal: { kind: 'agent', modelMode: 'local', modelChoice: 'gemma4-balanced' },
    });
    expect(balancedPilot?.bridge.bindAgent({ clientRequestId: 'balanced_coder_request',
      conversationId: 'balanced_coder_conversation', inputMessageId: 'balanced_coder_message', source: 'coder',
      privacyMode: 'persistent', request: { text: 'Измени проект.', attachmentIds: [],
        modifiers: { requestedModel: 'gemma4-balanced' }, executionProfile: {
          schemaVersion: 'monarch.agent-execution-profile.v1', kind: 'coder-project', projectId: 'balanced_coder',
          projectRoot: root, permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request',
            autonomyMode: 'workspace-autonomous' },
        } } } as never)).toMatchObject({ actor: balancedPilot?.coderActor,
          goal: { kind: 'agent', modelMode: 'local', modelChoice: 'gemma4-balanced' } });
    expect(astraAgentLocalModelChoiceAllowed('desktop', 'gemma4-balanced', ['gemma4-balanced'])).toBe(true);
    expect(astraAgentLocalModelChoiceAllowed('api', 'gemma4-balanced', ['gemma4-balanced'])).toBe(true);
    expect(astraAgentLocalModelChoiceAllowed('coder', 'gemma4-balanced', ['gemma4-balanced'])).toBe(true);
    expect(astraAgentLocalModelChoiceAllowed('desktop', 'gemma4-balanced', [])).toBe(false);
    await balancedPilot?.stop();
  });
  it('defaults an unnamed agent turn to the resident Gemma tier, and to MAX once MAX is connected', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-default-agent-'))); roots.push(root);
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const localDigests = {
      'gemma4-fast': 'sha256:' + '1'.repeat(64),
      'gemma4-balanced': 'sha256:' + '2'.repeat(64),
      'qwen3-coder-30b-a3b-instruct': 'sha256:' + '3'.repeat(64),
    } as const;
    const localModelHost = { endpoint: 'http://127.0.0.1:9', bearerToken: 'local-' + 'l'.repeat(48),
      hostGeneration: 'default_agent_fixture', modelDigest: localDigests['gemma4-fast'], modelDigests: localDigests };
    const ordinary = (suffix: string, modifiers: Record<string, unknown> = {}) => ({
      clientRequestId: 'default_request_' + suffix, conversationId: 'default_conversation_' + suffix,
      inputMessageId: 'default_message_' + suffix, source: 'desktop', privacyMode: 'persistent',
      request: { text: 'Создай файл и проверь результат.', attachmentIds: [], modifiers } }) as never;

    // Local only: an ordinary turn must not implicitly pull the Coder tier while
    // the chat keeps Gemma resident, even though a Coder model is configured.
    const localOnly = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'local-state'), kernel, desktopAttestationToken: 'desktop-' + 'd'.repeat(48),
      hostToken: 'host-' + 'h'.repeat(48), journalEncryptionKey: JOURNAL_KEY, localModelHost });
    expect(localOnly?.bridge.bindAgent(ordinary('local'))).toMatchObject({
      goal: { kind: 'agent', modelMode: 'local', modelChoice: 'gemma4-balanced' } });
    // The Coder tier stays reachable by exact request; it is only not a default.
    expect(localOnly?.bridge.bindAgent(ordinary('local_exact',
      { requestedModel: 'qwen3-coder-30b-a3b-instruct' }))).toMatchObject({
      goal: { kind: 'agent', modelMode: 'local', modelChoice: 'qwen3-coder-30b-a3b-instruct' } });
    await localOnly?.stop();

    // MAX connected: the same unnamed turn runs on the cloud policy budget.
    const maxDigests = { 'openai/gpt-oss-120b': 'sha256:' + '7'.repeat(64), 'qwen/qwen3.8-27b': 'sha256:' + '8'.repeat(64) };
    const withMax = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'max-state'), kernel, desktopAttestationToken: 'desktop-' + 'e'.repeat(48),
      hostToken: 'host-' + 'i'.repeat(48), journalEncryptionKey: JOURNAL_KEY, localModelHost,
      optionalMaxHost: { endpoint: 'http://127.0.0.1:9', bearerToken: 'max-' + 'm'.repeat(48),
        hostGeneration: 'default_max_fixture', modelDigest: maxDigests['openai/gpt-oss-120b'], modelDigests: maxDigests } });
    expect(withMax?.bridge.bindAgent(ordinary('max'))).toMatchObject({
      goal: { kind: 'agent', modelMode: 'max', modelChoice: 'gpt-oss-120b' } });
    // An exact local request is still honoured and never silently upgraded.
    expect(withMax?.bridge.bindAgent(ordinary('max_local_exact',
      { requestedModel: 'gemma4-balanced' }))).toMatchObject({
      goal: { kind: 'agent', modelMode: 'local', modelChoice: 'gemma4-balanced' } });
    expect(JSON.stringify(withMax?.bridge.bindAgent(ordinary('max_secret')))).not.toContain('max-' + 'm'.repeat(48));
    await withMax?.stop();

    // A MAX host exists even without a key. When its selected provider is not
    // ready, the unnamed turn stays local instead of failing `not-configured`.
    let ready = false;
    const probed = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'probe-state'), kernel, desktopAttestationToken: 'desktop-' + 'f'.repeat(48),
      hostToken: 'host-' + 'j'.repeat(48), journalEncryptionKey: JOURNAL_KEY, localModelHost, maxReady: async () => ready,
      optionalMaxHost: { endpoint: 'http://127.0.0.1:9', bearerToken: 'max-' + 'n'.repeat(48),
        hostGeneration: 'probe_max_fixture', modelDigest: maxDigests['openai/gpt-oss-120b'], modelDigests: maxDigests } });
    await probed?.bridge.refreshAgentAvailability?.();
    expect(probed?.bridge.bindAgent(ordinary('probe_unready'))).toMatchObject({
      goal: { kind: 'agent', modelMode: 'local', modelChoice: 'gemma4-balanced' } });
    ready = true; await probed?.bridge.refreshAgentAvailability?.();
    expect(probed?.bridge.bindAgent(ordinary('probe_ready'))).toMatchObject({
      goal: { kind: 'agent', modelMode: 'max', modelChoice: 'gpt-oss-120b' } });
    await probed?.stop();
  });
  it('projects certified read content with an exact global UTF-8 boundary', () => {
    expect(renderAstraCertifiedReadPresentation('Готово.', [{ content: '', sizeBytes: 0 }]))
      .toContain('[пустой файл]');
    const content = 'x'.repeat(65_535) + '🟠';
    const rendered = renderAstraCertifiedReadPresentation('Готово.', [{ content, sizeBytes: Buffer.byteLength(content) }]);
    expect(rendered).not.toContain('�');
    expect(rendered).toContain('[Вывод усечён: показано 65535 из 65539 UTF-8 байт.]');
  });

  it('allocates nothing unless the exact pilot mode and desktop attestation exist', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-pilot-'))); roots.push(root);
    const stateRoot = path.join(root, 'state'), kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const input = { canonicalRoot: root, stateRoot, kernel };
    expect(createAstraProductPilotRuntime(input)).toBeNull();
    expect(createAstraProductPilotRuntime({ ...input, mode: 'true', desktopAttestationToken: 'x'.repeat(64) })).toBeNull();
    await expect(access(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => createAstraProductPilotRuntime({ ...input, mode: ASTRA_PRODUCT_PILOT_MODE })).toThrow('trusted-desktop-required');
    await expect(access(stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shares one Kernel, Journal, scheduler and real Oscar coordinator without model fallback', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-pilot-'))); roots.push(root);
    const token = 'owned-product-pilot-token-' + 'x'.repeat(40);
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'state'), kernel, desktopAttestationToken: token, hostToken: 'host-' + 'y'.repeat(64),
      journalEncryptionKey: JOURNAL_KEY });
    expect(pilot).not.toBeNull(); if (!pilot) throw Error('pilot-required');
    const actorBindingKey = createHmac('sha256', JOURNAL_KEY)
      .update('monarch.astra-v3.actor-binding-root.v2').digest();
    expect(pilot.actor).toEqual({ source: 'desktop', id: 'sha256:' + createHmac('sha256', actorBindingKey)
      .update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') });
    actorBindingKey.fill(0);
    expect(pilot.authenticateHostToken('host-' + 'y'.repeat(64))).toBe(true);
    expect(pilot.authenticateHostToken('host-' + 'z'.repeat(64))).toBe(false);
    expect(pilot.facade.matchesComputerHost(pilot.computerSelections, pilot.journal, kernel)).toBe(true);
    expect(pilot.facade.matchesComputerActionHost(pilot.computerActionPlans, pilot.journal, kernel)).toBe(true);
    const coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(), volatileStore: new InMemoryOscarTurnStore(),
      astra: pilot.bridge, answerExecutor: async () => { throw Error('answer-forbidden'); },
      persistMessage: async () => ({ disposition: 'created' }) });
    await pilot.facade.startWithSourceRestore(() => coordinator.start());
    expect(pilot.facade.hostStatus()).toMatchObject({ phase: 'running', recoveryScheduled: false });
    await coordinator.stop(); await pilot.stop(); await pilot.stop();
    expect(pilot.facade.hostStatus().phase).toBe('stopped');
  });

  it('keeps every persistent local actor stable when the Electron session token rotates', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-actor-restart-'))); roots.push(root);
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const common = { mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'state'), kernel, journalEncryptionKey: JOURNAL_KEY } as const;
    const first = createAstraProductPilotRuntime({ ...common,
      desktopAttestationToken: 'first-session-' + 'a'.repeat(48), hostToken: 'first-host-' + 'b'.repeat(48) });
    expect(first).not.toBeNull(); if (!first) throw Error('first-pilot-required');
    const identities = [first.actor, first.coderActor, first.voiceActor, first.systemActor];
    await first.stop();

    const restarted = createAstraProductPilotRuntime({ ...common,
      desktopAttestationToken: 'second-session-' + 'c'.repeat(48), hostToken: 'second-host-' + 'd'.repeat(48) });
    expect(restarted).not.toBeNull(); if (!restarted) throw Error('restarted-pilot-required');
    expect([restarted.actor, restarted.coderActor, restarted.voiceActor, restarted.systemActor]).toEqual(identities);
    expect(restarted.authenticateHostToken('first-host-' + 'b'.repeat(48))).toBe(false);
    expect(restarted.authenticateHostToken('second-host-' + 'd'.repeat(48))).toBe(true);
    await restarted.stop();
  });

  it('issues a restart-safe read-only target alias for one exact paired Telegram actor', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-telegram-'))); roots.push(root);
    await writeFile(path.join(root, 'report.txt'), 'paired remote evidence', 'utf8');
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] }));
    kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
    let readCalls = 0; const execute = kernel.executeActionProposal.bind(kernel);
    kernel.executeActionProposal = (...args) => { if (args[0].capabilityId === 'workspace.files.read') readCalls += 1; return execute(...args); };
    const options = { mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root, stateRoot: path.join(root, 'state'), kernel,
      desktopAttestationToken: 'desktop-' + 'x'.repeat(40), hostToken: 'host-' + 'y'.repeat(40),
      journalEncryptionKey: JOURNAL_KEY } as const;
    const policy = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!;
    const principalInput = { chatId: 1001, userId: 2002, pairingEpoch: '2026-09-01T00:00:00.000Z', paired: true,
      remotePaused: false, zeroRetention: false, consentVersion: ASTRA_TELEGRAM_CONSENT_VERSION };
    const principal = policy.principal(principalInput);
    let pilot = createAstraProductPilotRuntime(options); expect(pilot).not.toBeNull(); if (!pilot) throw Error('pilot-required');
    let coordinator: OscarTurnCoordinator | undefined;
    try {
      const request = { version: 1, requestId: 'grant_report_1', selectedPath: path.join(root, 'report.txt'), ttlMs: 60_000 };
      const alias = pilot.issueTelegramTargetAlias(pilot.actor, principal, request);
      expect(alias).toMatchObject({ targetAlias: expect.stringMatching(/^astra_remote_alias_[a-f0-9]{32}$/u),
        authority: 'read-only', authorizesCreate: false, authorizesComputer: false });
      expect(JSON.stringify(alias)).not.toContain('report.txt');
      expect(pilot.issueTelegramTargetAlias(pilot.actor, principal, request)).toEqual(alias);
      const selectionId = pilot.selectionIdForTelegramAlias(alias.targetAlias, principal);
      const compiled = new AstraSourceGoalCompiler(pilot.selections).read(selectionId, {
        ...principal, inputMessageId: 'telegram_message_' + '1'.repeat(48), text: 'Read report',
        goal: { kind: 'observe', targets: ['picked'] },
      });
      expect(compiled).toMatchObject({ authority: 'observe', requirements: [{ relativePath: 'report.txt' }] });
      const deliveries: Array<{ role: string; content: string }> = [];
      coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(), volatileStore: new InMemoryOscarTurnStore(),
        astra: pilot.bridge, answerExecutor: async () => { throw Error('answer-forbidden'); },
        persistMessage: async (message) => { deliveries.push({ role: message.role, content: message.content }); return { disposition: 'created' }; } });
      await pilot.facade.startWithSourceRestore(() => coordinator!.start());
      const envelope = policy.admit({ ...principalInput, version: 1, messageId: 71, operation: 'workspace-read',
        targetAlias: alias.targetAlias, text: 'Прочитай локально разрешённый отчёт.' });
      let turn = await coordinator.submit({ clientRequestId: envelope.clientRequestId, conversationId: envelope.conversationId,
        inputMessageId: envelope.inputMessageId, text: envelope.text, source: 'telegram', privacyMode: 'persistent',
        astra: { selectionId, goal: { kind: 'observe', targets: ['picked'] } }, astraActor: envelope.actor });
      const deadline = Date.now() + 5_000;
      while (turn.turn.status !== 'succeeded' && Date.now() < deadline) {
        await pilot.facade.drain(); await coordinator.flushOutbox();
        turn = (await coordinator.getTurn(turn.turn.id))!;
        if (turn.turn.status !== 'succeeded') await new Promise(resolve => setTimeout(resolve, 10));
      }
      await coordinator.flushOutbox();
      expect(turn.turn).toMatchObject({ source: 'telegram', status: 'succeeded', request: { astra: { actor: principal.actor } } });
      expect(deliveries.some(message => message.role === 'assistant' && message.content.includes('paired remote evidence')),
        JSON.stringify(deliveries)).toBe(true);
      expect(readCalls).toBe(1);
      const other = policy.principal({ ...principalInput, userId: 2003 });
      expect(() => pilot!.selectionIdForTelegramAlias(alias.targetAlias, other)).toThrow('telegram-alias-unavailable');
      expect(() => pilot!.issueTelegramTargetAlias({ ...pilot!.actor, id: 'sha256:' + '0'.repeat(64) }, principal, request))
        .toThrow('desktop-principal');
      await coordinator.stop(); coordinator = undefined; await pilot.stop();

      pilot = createAstraProductPilotRuntime({ ...options,
        desktopAttestationToken: 'desktop-restarted-' + 'z'.repeat(40),
        hostToken: 'host-restarted-' + 'w'.repeat(40) });
      expect(pilot).not.toBeNull(); if (!pilot) throw Error('pilot-required');
      expect(pilot.selectionIdForTelegramAlias(alias.targetAlias, principal)).toBe(selectionId);
    } finally {
      if (coordinator) await coordinator.stop();
      await pilot.stop(); await kernel.stop();
    }
  });

  it('runs the real Application Telegram admission and durable delivery through Astra', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-telegram-app-'))); roots.push(root);
    await writeFile(path.join(root, 'report.txt'), 'application telegram evidence 🟠', 'utf8');
    const keys = ['MONARCH_ASTRA_V3_PILOT', 'MONARCH_DESKTOP_ATTESTATION_TOKEN', 'MONARCH_ASTRA_V3_HOST_TOKEN',
      'MONARCH_ASTRA_V3_JOURNAL_KEY',
      'MONARCH_ASTRA_TELEGRAM_MODE', 'MONARCH_STATE_ROOT', 'MONARCH_WORKSPACE_ROOT'] as const;
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    process.env.MONARCH_ASTRA_V3_PILOT = ASTRA_PRODUCT_PILOT_MODE;
    process.env.MONARCH_DESKTOP_ATTESTATION_TOKEN = 'desktop-' + 'x'.repeat(48);
    process.env.MONARCH_ASTRA_V3_HOST_TOKEN = 'host-' + 'y'.repeat(48);
    process.env.MONARCH_ASTRA_V3_JOURNAL_KEY = JOURNAL_KEY_ENV;
    process.env.MONARCH_ASTRA_TELEGRAM_MODE = ASTRA_TELEGRAM_REMOTE_MODE;
    process.env.MONARCH_STATE_ROOT = path.join(root, 'state'); process.env.MONARCH_WORKSPACE_ROOT = root;
    const telegramStateRoot = path.join(root, 'data', 'local');
    await mkdir(telegramStateRoot, { recursive: true });
    await writeFile(path.join(telegramStateRoot, 'telegram-state.json'), JSON.stringify({
      offset: 0,
      pairings: [{ chatId: -1001, userId: 2002, username: 'fixture', pairedAt: '2026-09-01T00:00:00.000Z' }],
      reminders: [],
      pendingTaskDeliveries: [],
      remotePaused: false,
      pairingAttempts: {},
    }), 'utf8');
    let app: MonarchApplication | undefined;
    let server: ReturnType<typeof createMonarchHttpServer> | undefined;
    let restartedTelegram: TelegramModule | undefined;
    try {
      app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['workspace', 'telegram'],
        enableLocalSystemRouter: false,
        modelComponentManager: { initialize: async () => {}, stop: async () => {} } as any });
      app.runtime.kernel.registerModule(isolatedLocalSecurity(root));
      let readCalls = 0, blockNextRead = false, enteredRead!: () => void;
      const readEntered = () => new Promise<void>(resolve => { enteredRead = resolve; });
      let pendingRead = readEntered();
      const execute = app.runtime.kernel.executeActionProposal.bind(app.runtime.kernel);
      app.runtime.kernel.executeActionProposal = async (...args) => {
        if (args[0].capabilityId === 'workspace.files.read') readCalls += 1;
        const returned = await execute(...args);
        if (args[0].capabilityId === 'workspace.files.read' && blockNextRead) {
          enteredRead();
          await new Promise<void>(resolve => {
            const signal = args[1]?.signal;
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        return returned;
      };
      const pilot = app.astraProductPilot; expect(pilot).not.toBeNull(); if (!pilot) throw Error('pilot-required');
      const telegram = app.runtime.modules.find(module => module.manifest.id === 'telegram') as unknown as {
        dispatcher: TelegramIntentDispatcher;
        resolveAstraPairing(chatId: number, userId: number): Promise<{ pairingEpoch: string; remotePaused: boolean }>;
      };
      await app.start();
      const context = { telegramChatId: -1001, telegramUserId: 2002, telegramMessageId: 71,
        telegramPairingEpoch: '2026-09-01T00:00:00.000Z', telegramPaired: true, telegramRemotePaused: false,
        clientRequestId: 'telegram:-1001:71', clientMessageId: 'telegram:-1001:71' };
      const policy = createAstraTelegramRemoteAdmissionPolicy(ASTRA_TELEGRAM_REMOTE_MODE)!;
      const principal = policy.principal({ chatId: context.telegramChatId, userId: context.telegramUserId,
        pairingEpoch: context.telegramPairingEpoch, paired: true, remotePaused: false, zeroRetention: false,
        consentVersion: ASTRA_TELEGRAM_CONSENT_VERSION });
      server = createMonarchHttpServer({ app, publicDirectory: root, desktopAttestationToken: process.env.MONARCH_DESKTOP_ATTESTATION_TOKEN,
        requireApiToken: true, apiToken: 'unused-product-pilot-api', astraHost: pilot });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
      let rendererChecks = 0;
      const picked = await pickAstraTelegramTarget({ mode: ASTRA_RUNTIME_PILOT_MODE,
        telegramMode: ASTRA_TELEGRAM_PILOT_MODE,
        request: { version: 1, chatId: -1001, userId: 2002, requestId: 'application_report', ttlMs: 60_000 },
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(root, 'report.txt')] }) },
        window: {}, runtimeUrl: base, defaultDirectory: root,
        desktopAttestationToken: process.env.MONARCH_DESKTOP_ATTESTATION_TOKEN,
        hostToken: process.env.MONARCH_ASTRA_V3_HOST_TOKEN, fetchImpl: fetch,
        assertRenderer: () => { rendererChecks += 1; } });
      expect(picked.status).toBe('selected');
      expect(rendererChecks).toBe(3);
      expect(JSON.stringify(picked)).not.toContain(path.join(root, 'report.txt'));
      if (picked.status !== 'selected') throw Error('telegram-target-required');
      const alias = picked.alias as ReturnType<typeof pilot.issueTelegramTargetAlias>;
      const deliveredTexts: string[] = [];
      const telegramInternals = telegram as unknown as {
        running: boolean;
        callApi(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
        handleUpdate(update: unknown): Promise<void>;
        taskDeliveryRuns: Map<string, Promise<void>>;
      };
      telegramInternals.running = false;
      telegramInternals.callApi = async (method, parameters = {}) => {
        if (method === 'sendMessage') return { message_id: 900, chat: { id: -1001, type: 'private' } };
        if (method === 'editMessageText') { deliveredTexts.push(String(parameters.text || '')); return true; }
        return true;
      };
      await telegramInternals.handleUpdate({ update_id: 70, message: { message_id: 70,
        chat: { id: -1001, type: 'private' }, from: { id: 2002, username: 'fixture' },
        text: `/astra_read ${alias.targetAlias} Прочитай выданный локальный отчёт.` } });
      expect(deliveredTexts).toEqual([]);
      expect(telegramInternals.taskDeliveryRuns.size).toBe(0);
      restartedTelegram = new TelegramModule({ projectRoot: root, autoStart: false });
      restartedTelegram.setIntentDispatcher(telegram.dispatcher);
      const restartedInternals = restartedTelegram as unknown as {
        running: boolean;
        pollingAbort: AbortController | null;
        callApi(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
        refreshState(): Promise<void>;
        resumePendingTaskDeliveries(): void;
        taskDeliveryRuns: Map<string, Promise<void>>;
        lastError: string;
        state: { pendingTaskDeliveries: unknown[] };
      };
      restartedInternals.callApi = telegramInternals.callApi;
      await restartedInternals.refreshState();
      restartedInternals.running = true;
      restartedInternals.pollingAbort = new AbortController();
      restartedInternals.resumePendingTaskDeliveries();
      const deliveryDeadline = Date.now() + 5_000;
      while ((!deliveredTexts.some((text) => text.includes('application telegram evidence 🟠'))
        || restartedInternals.taskDeliveryRuns.size !== 0)
        && Date.now() < deliveryDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(deliveredTexts.some((text) => text.includes('application telegram evidence 🟠')), JSON.stringify({
        deliveredTexts,
        lastError: restartedInternals.lastError,
        pendingTaskDeliveries: restartedInternals.state.pendingTaskDeliveries,
      })).toBe(true);
      expect(restartedInternals.taskDeliveryRuns.size).toBe(0);
      restartedInternals.pollingAbort.abort(new Error('synthetic-owner-stopped'));
      restartedInternals.running = false;
      expect(readCalls).toBe(1);
      const deniedResponse = await fetch(base + '/api/astra/v3/host/telegram-target-aliases', { method: 'POST', headers: {
        'content-type': 'application/json',
        'x-monarch-desktop-attestation': process.env.MONARCH_DESKTOP_ATTESTATION_TOKEN,
        'x-monarch-astra-host-token': process.env.MONARCH_ASTRA_V3_HOST_TOKEN,
      }, body: JSON.stringify({ version: 1, chatId: -1001, userId: 9999, requestId: 'wrong_actor',
        selectedPath: path.join(root, 'report.txt'), ttlMs: 60_000 }) });
      expect(deniedResponse.status).toBe(403);
      const admission = await telegram.dispatcher.admit!({ text: 'Прочитай выданный локальный отчёт.', context,
        astraRemote: { operation: 'workspace-read', targetAlias: alias.targetAlias } });
      const result = await telegram.dispatcher.resume!(admission, context);
      expect(JSON.stringify(result)).toContain('application telegram evidence 🟠');
      expect(readCalls).toBe(2);
      await expect(telegram.dispatcher.resume!(admission, { ...context, telegramUserId: 2003 }))
        .rejects.toThrow('not bound to this chat');

      blockNextRead = true; pendingRead = readEntered();
      const blockedContext = { ...context, telegramMessageId: 72,
        clientRequestId: 'telegram:-1001:72', clientMessageId: 'telegram:-1001:72' };
      const blockedAlias = pilot.issueTelegramTargetAlias(pilot.actor, principal, { version: 1, requestId: 'application_report_blocked',
        selectedPath: path.join(root, 'report.txt'), ttlMs: 60_000 });
      const blocked = await telegram.dispatcher.admit!({ text: 'Прочитай ещё раз.', context: blockedContext,
        astraRemote: { operation: 'workspace-read', targetAlias: blockedAlias.targetAlias } });
      await Promise.race([pendingRead, new Promise((_, reject) => setTimeout(() => reject(new Error('read-not-entered')), 5_000))]);
      const pausedContext = { ...blockedContext, telegramRemotePaused: true };
      await expect(telegram.dispatcher.inspect!(pausedContext)).resolves.toMatchObject({ turnId: blocked.turnId });
      const cancelled = await telegram.dispatcher.cancelLatest!(pausedContext);
      expect(cancelled?.execution).toMatchObject({ ok: false, error: 'turn-cancelled' });
      await expect(telegram.dispatcher.inspect!(pausedContext)).resolves.toBeNull();

      const rotatedEpoch = '2026-09-01T01:00:00.000Z';
      await writeFile(path.join(telegramStateRoot, 'telegram-state.json'), JSON.stringify({
        offset: 0, pairings: [{ chatId: -1001, userId: 2002, pairedAt: rotatedEpoch }], reminders: [],
        pendingTaskDeliveries: [], remotePaused: false, pairingAttempts: {},
      }), 'utf8');
      await expect(telegram.resolveAstraPairing(-1001, 2002)).resolves.toMatchObject({ pairingEpoch: rotatedEpoch, remotePaused: false });
      await expect(telegram.dispatcher.admit!({ text: 'Старый alias после новой привязки.',
        context: { ...context, telegramPairingEpoch: rotatedEpoch, telegramMessageId: 73,
          clientRequestId: 'telegram:-1001:73', clientMessageId: 'telegram:-1001:73' },
        astraRemote: { operation: 'workspace-read', targetAlias: alias.targetAlias } }))
        .rejects.toThrow('telegram-alias-unavailable');

      await writeFile(path.join(telegramStateRoot, 'telegram-state.json'), JSON.stringify({
        offset: 0, pairings: [{ chatId: -1001, userId: 2002, pairedAt: rotatedEpoch }], reminders: [],
        pendingTaskDeliveries: [], remotePaused: true, pairingAttempts: {},
      }), 'utf8');
      const lockdown = await fetch(base + '/api/astra/v3/host/telegram-target-aliases', { method: 'POST', headers: {
        'content-type': 'application/json',
        'x-monarch-desktop-attestation': process.env.MONARCH_DESKTOP_ATTESTATION_TOKEN,
        'x-monarch-astra-host-token': process.env.MONARCH_ASTRA_V3_HOST_TOKEN,
      }, body: JSON.stringify({ version: 1, chatId: -1001, userId: 2002, requestId: 'lockdown_denied',
        selectedPath: path.join(root, 'report.txt'), ttlMs: 60_000 }) });
      expect(lockdown.status).toBe(403);
    } finally {
      restartedTelegram?.v2.close();
      if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
      if (app) await app.stop();
      for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it('enumerates through the existing Kernel and issues only an index-bound short-lived window selection', async () => {
    const root = await realpath(await mkdtemp(path.join(await realpath('.test-tmp'), 'astra-product-computer-'))); roots.push(root);
    let enumerations = 0; const processInstanceId = 'process:' + '4'.repeat(64);
    const computer = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'computer-runtime'),
      observationRoot: path.join(root, 'observations'), controlStatePath: path.join(root, 'control.json'),
      nativeProvider: { status: async () => ({ available: true }), listWindows: async () => { enumerations++; return [{
        windowRef: 'hwnd:0000000000000042', processId: 42, processInstanceId, processName: 'OwnedFixture', title: 'Owned target',
        minimized: false, foreground: false, bounds: { x: 0, y: 0, width: 400, height: 300 } }]; },
      observe: async () => { throw Error('observe-forbidden'); }, act: async () => { throw Error('act-forbidden'); } } as any,
      visionAnalyzer: { analyze: async () => { throw Error('vision-forbidden'); } } });
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' } });
    kernel.registerModule(computer); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
    computer.control.start('owned-product-computer-picker');
    const pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
      stateRoot: path.join(root, 'state'), kernel, desktopAttestationToken: 'desktop-' + 'x'.repeat(40), hostToken: 'host-' + 'y'.repeat(40),
      journalEncryptionKey: JOURNAL_KEY });
    expect(pilot).not.toBeNull(); if (!pilot) throw Error('pilot-required');
    try {
      const request = { version: 1, conversationId: 'chat', requestId: 'enumerate_1' };
      const candidates = await pilot.listComputerCandidates(pilot.actor, request);
      expect(candidates).toMatchObject({ candidates: [{ index: 0, title: 'Owned target', processName: 'OwnedFixture' }] });
      expect(JSON.stringify(candidates)).not.toMatch(/hwnd|processId|processInstanceId/u);
      expect(await pilot.listComputerCandidates(pilot.actor, request)).toEqual(candidates); expect(enumerations).toBe(1);
      await expect(pilot.listComputerCandidates({ ...pilot.actor, id: 'sha256:' + '0'.repeat(64) }, request)).rejects.toThrow('desktop-principal');
      const selected = pilot.issueComputerWindow(pilot.actor, { version: 1, conversationId: 'chat', requestId: 'select_1',
        candidateSetId: candidates.candidateSetId, index: 0 });
      expect(selected).toMatchObject({ title: 'Owned target', processName: 'OwnedFixture', authority: 'observe', authorizesInput: false });
      expect(JSON.stringify(selected)).not.toMatch(/hwnd|processId|processInstanceId/u);
      expect(pilot.issueComputerWindow(pilot.actor, { version: 1, conversationId: 'chat', requestId: 'select_1',
        candidateSetId: candidates.candidateSetId, index: 0 })).toEqual(selected);
      expect(() => pilot.issueComputerWindow(pilot.actor, { version: 1, conversationId: 'chat', requestId: 'select_2',
        candidateSetId: candidates.candidateSetId, index: 0 })).toThrow('candidate-unavailable');
    } finally { await pilot.stop(); await kernel.stop(); }
  });
});
