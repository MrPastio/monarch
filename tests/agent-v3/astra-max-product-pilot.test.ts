import path from 'node:path';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { startAstraMaxModelServer } from '../../desktop/electron/astra-max-model-server.mjs';
import { AstraMaxPreparedModelHost } from '../../src/agent-v3/max-prepared-model-host';
import { AstraMaxHostService } from '../../src/agent-v3/max-host-service';
import type { AstraMaxSettingsStore } from '../../src/agent-v3/max-settings-store';
import { ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, astraMaxInputDigest, astraMaxOutputDigest,
  type AstraMaxProposalRequestV1 } from '../../src/agent-v3/max-provider-contract';
import { ASTRA_PRODUCT_PILOT_MODE, createAstraProductPilotRuntime } from '../../src/app/astra-product-pilot';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import { OscarTurnCoordinator } from '../../src/oscar-turn/coordinator';
import { InMemoryOscarTurnStore } from '../../src/oscar-turn/turn-store';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';
import { maxCloudPreparedModelDigest, type MaxCloudRole } from '../../src/agent-v3/max-cloud-catalog';

describe('Astra MAX -> product pilot -> Kernel', () => {
  it.each([false, true])('moves a sealed draft through the real loopback client with exact approval (optional MAX=%s)', async optionalMax => {
    const parent = await realpath('.test-tmp');
    expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-max-product-')));
    const outputPath = path.join(root, 'MAX черновик.txt');
    const qwenOutputPath = path.join(root, 'MAX GPT второй черновик.txt');
    const consent = { agreementVersion: ASTRA_MAX_PROVIDER_AGREEMENT_VERSION, providerId: 'groq' as const,
      acceptedAt: new Date().toISOString(), nonLocalProcessingAcknowledged: true as const,
      selectedContextAcknowledged: true as const, providerTermsAcknowledged: true as const };
    const modelCalls: Array<{ surface: string; requestId: string; modelId: string; maxCompletionTokens: number }> = [];
    const provider = { proposePrepared: vi.fn(async (input: Omit<AstraMaxProposalRequestV1, 'consent'> & { signal?: AbortSignal }) => {
      const { signal: _signal, ...prepared } = input;
      modelCalls.push({ surface: input.messages[1].content, requestId: input.requestId,
        modelId: input.modelId, maxCompletionTokens: input.maxCompletionTokens });
      const request = { ...prepared, consent } as AstraMaxProposalRequestV1;
      const schema = JSON.stringify(input.responseSchema);
      const value = schema.includes('"const":"create"')
        ? { kind: 'create', requirementId: 'draft_file', capabilityHandle: 'create_file',
          targetHandle: 'selected_file', content: 'Черновик от MAX через Astra V3 🟠' } as const
        : schema.includes('"const":"read"')
          ? { kind: 'read', requirementId: 'selected_0', capabilityHandle: 'read_selected_0',
            targetHandle: 'target_selected_0' } as const
          : { kind: 'respond', text: 'В выбранном файле записано: проект готов к проверке.' } as const;
      if (optionalMax) {
        const host = new AstraMaxHostService({ deployment: 'native-desktop', settings: {
          resolveConnection: async () => ({ apiKey: 'gsk_synthetic_product_test_123456789', consent }),
        } as AstraMaxSettingsStore, fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const content = body.model === 'openai/gpt-oss-safeguard-20b'
            ? { decision: 'allow', reasonCode: 'fixture', summary: 'synthetic' }
            : body.response_format.json_schema.schema.properties?.proposal ? { proposal: value } : value;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] }),
            { headers: { 'Content-Type': 'application/json' } });
        } });
        return host.proposePrepared(input);
      }
      return { authority: 'none' as const, providerId: 'groq' as const, modelId: request.modelId,
        safetyModelId: 'openai/gpt-oss-safeguard-20b' as const, requestId: request.requestId,
        executionId: request.executionId, inputDigest: astraMaxInputDigest(request),
        outputDigest: astraMaxOutputDigest(value), finishReason: 'stop' as const, value };
    }) };
    const preparedHost = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation',
      modelId: 'openai/gpt-oss-120b', modelIds: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
      provider, hostGeneration: 'max_product_fixture' });
    const modelServer = await startAstraMaxModelServer({ mode: 'source-preview-v1', host: preparedHost });
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] }));
    kernel.registerModule(isolatedLocalSecurity(root));
    const dispatches: Array<{ capabilityId: string; dispatched: unknown }> = [], execute = kernel.executeActionProposal.bind(kernel);
    kernel.executeActionProposal = async (...args) => { const returned = await execute(...args);
      dispatches.push({ capabilityId: args[0].capabilityId,
        dispatched: (returned.result.metadata?.dispatchControl as { dispatched?: unknown } | undefined)?.dispatched });
      return returned; };
    let pilot: ReturnType<typeof createAstraProductPilotRuntime> = null;
    let coordinator: OscarTurnCoordinator | undefined;
    try {
      await kernel.start();
      pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
        ...(optionalMax ? { localModelHost: { endpoint: 'http://127.0.0.1:1', bearerToken: 'local-' + 'l'.repeat(48),
          hostGeneration: 'synthetic_local_no_calls', modelDigest: 'sha256:' + 'a'.repeat(64) } } : {}),
        stateRoot: path.join(root, 'state'), kernel, desktopAttestationToken: 'desktop-' + 'x'.repeat(48),
        journalEncryptionKey: Buffer.alloc(32, 0x4d),
        hostToken: 'host-' + 'y'.repeat(48), [optionalMax ? 'optionalMaxHost' : 'modelHost']: { endpoint: modelServer.endpoint,
          bearerToken: modelServer.bearerToken, hostGeneration: modelServer.hostGeneration,
          modelDigest: modelServer.modelDigest, modelDigests: modelServer.modelDigests } });
      expect(pilot).not.toBeNull(); if (!pilot) throw Error('pilot-required');
      expect(() => pilot!.issuePickedTarget(pilot!.actor, { version: 1, conversationId: 'max_conversation',
        requestId: 'duplicate_targets', access: 'observe', selectedPaths: [outputPath, outputPath] }))
        .toThrow('host-request');
      expect(() => pilot!.issuePickedTarget(pilot!.actor, { version: 1, conversationId: 'max_conversation',
        requestId: 'multi_create_targets', access: 'exclusive-create', selectedPaths: [outputPath] }))
        .toThrow('host-request');
      expect(() => pilot!.issuePickedTarget(pilot!.actor, { version: 1, conversationId: 'max_conversation',
        requestId: 'nine_targets', access: 'observe', selectedPaths: Array.from({ length: 9 }, (_, index) => `${root}\\${index}.txt`) }))
        .toThrow('host-request');
      const selection = pilot.issuePickedTarget(pilot.actor, { version: 1, conversationId: 'max_conversation',
        requestId: 'max_target', access: 'exclusive-create', selectedPath: outputPath });
      expect(dispatches).toEqual([]);
      coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(),
        volatileStore: new InMemoryOscarTurnStore(), astra: pilot.bridge,
        answerExecutor: async () => { throw Error('legacy-answer-forbidden'); },
        persistMessage: async () => ({ disposition: 'created' }) });
      await pilot.facade.startWithSourceRestore(() => coordinator!.start());
      if (!optionalMax) {
      expect(() => pilot!.facade.submit(pilot!.actor, { version: 1, clientRequestId: 'max_without_mode',
        conversationId: 'max_conversation', inputMessageId: 'max_without_mode_message',
        text: 'Создай черновик.', selectionId: selection.selectionId, privacyMode: 'persistent',
        goal: { kind: 'create', target: selection.targets[0]!.targetId, content: { kind: 'draft' } } }, 'create'))
        .toThrow('astra-model-mode-required');
      expect(modelCalls).toEqual([]); expect(dispatches).toEqual([]);
      await expect(coordinator.submit({ clientRequestId: 'max_turn_without_mode',
        conversationId: 'max_conversation', inputMessageId: 'max_turn_without_mode_message',
        text: 'Создай черновик.', source: 'desktop', privacyMode: 'persistent',
        astra: { selectionId: selection.selectionId,
          goal: { kind: 'create', target: selection.targets[0]!.targetId, content: { kind: 'draft' } } } }))
        .rejects.toThrow('astra-model-mode-required');
      expect(await coordinator.persistentStore.listTurns()).toHaveLength(0);
      }
      expect(modelCalls).toEqual([]); expect(dispatches).toEqual([]);
      let checkpoint = await coordinator.submit({ clientRequestId: 'max_product_request',
        conversationId: 'max_conversation', inputMessageId: 'max_product_message',
        text: 'Создай короткий черновик через MAX.', source: 'desktop', privacyMode: 'persistent',
        astra: { selectionId: selection.selectionId,
          goal: { kind: 'create', target: selection.targets[0]!.targetId, content: { kind: 'draft', modelMode: 'max' } } } });
      const progress = async (status: string) => {
        const deadline = Date.now() + 5_000;
        while (checkpoint.turn.status !== status && Date.now() < deadline) {
          await pilot!.facade.drain(); await coordinator!.flushOutbox();
          checkpoint = (await coordinator!.getTurn(checkpoint.turn.id))!;
        }
        expect(checkpoint.turn.status, JSON.stringify(checkpoint.turn)).toBe(status);
      };
      await progress('waiting-for-approval');
      expect(modelCalls).toHaveLength(1);
      expect(modelCalls[0]!.maxCompletionTokens).toBe(65_536);
      expect(modelCalls[0]!.surface).toContain('Создай короткий черновик через MAX.');
      expect(modelCalls[0]!.surface).not.toContain(outputPath);
      await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const approval = pilot.bridge.find(checkpoint.turn)!.approval!;
      expect(approval.content).toBe('Черновик от MAX через Astra V3 🟠');
      await coordinator.submitAstraInput(checkpoint.turn.id, 'desktop', { kind: 'decide', decision: {
        approvalId: approval.id, approvalDigest: approval.digest, messageId: 'max_exact_approval', decision: 'approve' } });
      await progress('succeeded');
      expect(await readFile(outputPath, 'utf8')).toBe(approval.content);
      expect(modelCalls).toHaveLength(1);
      expect(dispatches).toEqual([
        { capabilityId: 'workspace.files.write', dispatched: false },
        { capabilityId: 'workspace.files.write', dispatched: true },
      ]);
      expect(checkpoint.turn.outcome?.kind).toBe('partial');

      const qwenSelection = pilot.issuePickedTarget(pilot.actor, { version: 1, conversationId: 'max_conversation',
        requestId: 'max_qwen_target', access: 'exclusive-create', selectedPath: qwenOutputPath });
      checkpoint = await coordinator.submit({ clientRequestId: 'max_qwen_product_request',
        conversationId: 'max_conversation', inputMessageId: 'max_qwen_product_message',
        text: 'Создай второй короткий черновик через GPT.', source: 'desktop', privacyMode: 'persistent',
        astra: { selectionId: qwenSelection.selectionId,
          goal: { kind: 'create', target: qwenSelection.targets[0]!.targetId, content: { kind: 'draft',
            modelMode: 'max', modelChoice: 'gpt-oss-120b' } } } });
      await progress('waiting-for-approval');
      expect(modelCalls.at(-1)).toMatchObject({ modelId: 'openai/gpt-oss-120b', maxCompletionTokens: 65_536 });
      const qwenApproval = pilot.bridge.find(checkpoint.turn)!.approval!;
      await coordinator.submitAstraInput(checkpoint.turn.id, 'desktop', { kind: 'decide', decision: {
        approvalId: qwenApproval.id, approvalDigest: qwenApproval.digest,
        messageId: 'max_qwen_exact_approval', decision: 'approve' } });
      await progress('succeeded');
      expect(await readFile(qwenOutputPath, 'utf8')).toBe(qwenApproval.content);
      expect(modelCalls).toHaveLength(2);
      expect(dispatches.slice(-2)).toEqual([
        { capabilityId: 'workspace.files.write', dispatched: false },
        { capabilityId: 'workspace.files.write', dispatched: true },
      ]);

      const analysisPath = path.join(root, 'Состояние.txt');
      await writeFile(analysisPath, 'Проект готов к проверке.', 'utf8');
      const analysisSelection = pilot.issuePickedTarget(pilot.actor, { version: 1, conversationId: 'max_conversation',
        requestId: 'max_analysis_target', access: 'observe', selectedPath: analysisPath });
      const beforeAnalysisCalls = modelCalls.length, beforeAnalysisDispatches = dispatches.length;
      checkpoint = await coordinator.submit({ clientRequestId: 'max_analysis_request',
        conversationId: 'max_conversation', inputMessageId: 'max_analysis_message',
        text: 'Что сказано о состоянии проекта?', source: 'desktop', privacyMode: 'persistent',
        astra: { selectionId: analysisSelection.selectionId,
          goal: { kind: 'analyze', targets: [analysisSelection.targets[0]!.targetId], modelMode: 'max',
            modelChoice: 'gpt-oss-120b' } } });
      await progress('succeeded');
      expect(modelCalls.slice(beforeAnalysisCalls).map(call => call.modelId)).toEqual(['openai/gpt-oss-120b']);
      expect(modelCalls.at(-1)!.surface).toContain('Проект готов к проверке.');
      expect(dispatches.slice(beforeAnalysisDispatches).map(item => item.capabilityId)).toEqual(['workspace.files.read']);
      expect(pilot.bridge.find(checkpoint.turn)).toMatchObject({ status: 'completed', modelJobs: 1, readJobs: 1,
        message: { content: 'В выбранном файле записано: проект готов к проверке.' } });
      expect(checkpoint.turn.outcome?.summary).toBe('В выбранном файле записано: проект готов к проверке.');

      const largeAnalysisPath = path.join(root, 'Большой контекст.txt');
      const largeAnalysisContent = 'large-context-sentinel:' + 'z'.repeat(11_900);
      await writeFile(largeAnalysisPath, largeAnalysisContent, 'utf8');
      const largeAnalysisSelection = pilot.issuePickedTarget(pilot.actor, { version: 1,
        conversationId: 'max_conversation', requestId: 'max_large_analysis_target', access: 'observe',
        selectedPath: largeAnalysisPath });
      const beforeLargeCalls = modelCalls.length, beforeLargeDispatches = dispatches.length;
      checkpoint = await coordinator.submit({ clientRequestId: 'max_large_analysis_request',
        conversationId: 'max_conversation', inputMessageId: 'max_large_analysis_message',
        text: 'Найди маркер в большом выбранном файле.', source: 'desktop', privacyMode: 'persistent',
        astra: { selectionId: largeAnalysisSelection.selectionId,
          goal: { kind: 'analyze', targets: [largeAnalysisSelection.targets[0]!.targetId], modelMode: 'max',
            modelChoice: 'gpt-oss-120b' } } });
      await progress('succeeded');
      expect(modelCalls.slice(beforeLargeCalls).map(call => call.modelId)).toEqual(['openai/gpt-oss-120b']);
      expect(modelCalls.at(-1)!.surface).toContain(largeAnalysisContent);
      expect(dispatches.slice(beforeLargeDispatches).map(item => item.capabilityId)).toEqual(['workspace.files.read']);
      expect(pilot.bridge.find(checkpoint.turn)).toMatchObject({ status: 'completed', modelJobs: 1, readJobs: 1 });

      const additionalAnalysisPaths = Array.from({ length: 7 }, (_, index) => path.join(root, `Дополнение-${index + 2}.txt`));
      await Promise.all(additionalAnalysisPaths.map((file, index) => writeFile(file, `Файл ${index + 2}: проверка назначена.`, 'utf8')));
      const multiAnalysisPaths = [analysisPath, ...additionalAnalysisPaths];
      const multiAnalysisSelection = pilot.issuePickedTarget(pilot.actor, { version: 1,
        conversationId: 'max_conversation', requestId: 'max_multi_analysis_target', access: 'observe',
        selectedPaths: multiAnalysisPaths });
      expect(multiAnalysisSelection.targets.map(target => target.targetId))
        .toEqual(Array.from({ length: 8 }, (_, index) => `picked_${index}`));
      const beforeMultiCalls = modelCalls.length, beforeMultiDispatches = dispatches.length;
      checkpoint = await coordinator.submit({ clientRequestId: 'max_multi_analysis_request',
        conversationId: 'max_conversation', inputMessageId: 'max_multi_analysis_message',
        text: 'Сопоставь состояние в двух выбранных файлах.', source: 'desktop', privacyMode: 'persistent',
        astra: { selectionId: multiAnalysisSelection.selectionId,
          goal: { kind: 'analyze', targets: multiAnalysisSelection.targets.map(target => target.targetId), modelMode: 'max',
            modelChoice: 'gpt-oss-120b' } } });
      await progress('succeeded');
      expect(modelCalls.slice(beforeMultiCalls).map(call => call.modelId)).toEqual(['openai/gpt-oss-120b']);
      expect(modelCalls.at(-1)!.surface).toContain('Проект готов к проверке.');
      for (let index = 2; index <= 8; index++) expect(modelCalls.at(-1)!.surface).toContain(`Файл ${index}: проверка назначена.`);
      expect(dispatches.slice(beforeMultiDispatches).map(item => item.capabilityId))
        .toEqual(Array.from({ length: 8 }, () => 'workspace.files.read'));
      expect(pilot.bridge.find(checkpoint.turn)).toMatchObject({ status: 'completed', modelJobs: 1, readJobs: 8 });
    } finally {
      if (coordinator) await coordinator.stop();
      if (pilot) await pilot.stop();
      await modelServer.close(); await kernel.stop();
      expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
      await rm(root, { recursive: true, force: false });
    }
  }, 20_000);

  it('runs Coder through cloud MAX, repeated V3 model calls, and one project-bound Kernel receipt', async () => {
    const parent = await realpath('.test-tmp');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-cloud-agent-')));
    const role = 'max-cloud:deepseek:deepseek-chat' as MaxCloudRole, digest = maxCloudPreparedModelDigest(role);
    let capabilityCalls = 0;
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule({ manifest: { id: 'cloud-agent-fixture', name: 'Cloud Agent fixture', version: '1.0.0',
      kind: 'runtime', description: 'One receipt-bound read.', owns: ['synthetic receipt'], permissions: ['read'],
      capabilities: [{ id: 'coder.fixture.project.status', moduleId: 'cloud-agent-fixture', title: 'Read project status', risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        agent: { supportedSources: ['coder'], cancellation: 'supported' } }] },
    async activate() {}, async executeCapability() { capabilityCalls += 1;
      return { ok: true, summary: 'Project status verified.', output: { ready: true } }; } } as never);
    await kernel.start();
    const cloudCalls: string[] = [];
    const cloudProvider = { propose: vi.fn(async (input: { role: string; messages: readonly { content: string }[] }) => {
      const surface = input.messages[1]?.content ?? ''; cloudCalls.push(surface);
      const handle = /cap_[a-f0-9]{48}/u.exec(surface)?.[0];
      const value = surface.includes('receipt_0')
        ? { kind: 'complete', text: 'Проект готов — статус проверен через V3.', evidenceRef: 'receipt_0' }
        : { kind: 'act', capabilityHandle: handle, argsJson: '{}', reason: 'Verify the current project status.' };
      return { value, modelId: 'deepseek-chat' };
    }) };
    const nativeProvider = { proposePrepared: vi.fn(async () => { throw Error('native-provider-forbidden'); }) };
    const preparedHost = new AstraMaxPreparedModelHost({ deployment: 'isolated-validation',
      modelId: role, modelIds: [role, 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'], provider: nativeProvider,
      cloudProvider, hostGeneration: 'cloud_agent_host' });
    const modelServer = await startAstraMaxModelServer({ mode: 'source-preview-v1', host: preparedHost });
    let pilot: ReturnType<typeof createAstraProductPilotRuntime> = null, coordinator: OscarTurnCoordinator | undefined;
    try {
      pilot = createAstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: root,
        stateRoot: path.join(root, 'state'), kernel, desktopAttestationToken: 'desktop-' + 'd'.repeat(48),
        journalEncryptionKey: Buffer.alloc(32, 0x4e), hostToken: 'host-' + 'h'.repeat(48),
        optionalMaxHost: { endpoint: modelServer.endpoint, bearerToken: modelServer.bearerToken,
          hostGeneration: modelServer.hostGeneration, modelDigest: modelServer.modelDigest,
          modelDigests: modelServer.modelDigests, dynamicMaxCloud: true } });
      if (!pilot) throw Error('pilot-required');
      coordinator = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(),
        volatileStore: new InMemoryOscarTurnStore(), astra: pilot.bridge,
        dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'semantic-request', confidence: 1,
          reason: 'fixture cloud work', requiresExternalResearch: false }) },
        answerExecutor: async () => { throw Error('legacy-answer-forbidden'); },
        persistMessage: async () => ({ disposition: 'created' }) });
      await pilot.facade.startWithSourceRestore(() => coordinator!.start());
      const executionProfile = { schemaVersion: 'monarch.agent-execution-profile.v1' as const,
        kind: 'coder-project' as const, projectId: 'cloud_coder_project', projectRoot: root,
        permissionProfile: { sandboxMode: 'read-only' as const, approvalPolicy: 'on-request' as const } };
      let checkpoint = await coordinator.submit({ clientRequestId: 'cloud_agent_request', conversationId: 'cloud_agent_conversation',
        inputMessageId: 'cloud_agent_message', text: 'Проверь состояние проекта.', source: 'coder', privacyMode: 'persistent',
        modifiers: { requestedModel: role, reasoningEffort: 'high', researchMode: 'off' }, executionProfile });
      const deadline = Date.now() + 10_000;
      while (checkpoint.turn.status !== 'succeeded' && Date.now() < deadline) {
        await pilot.facade.drain(); await coordinator.flushOutbox();
        checkpoint = (await coordinator.getTurn(checkpoint.turn.id))!;
        if (checkpoint.turn.status !== 'succeeded') await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (checkpoint.turn.status !== 'succeeded') throw Error('cloud-agent-timeout:' + JSON.stringify({ checkpoint,
        tasks: pilot.facade.agentTasks?.list(pilot.coderActor, checkpoint.turn.conversationId), host: pilot.facade.hostStatus(),
        cloudCalls: cloudCalls.length, capabilityCalls }, null, 2));
      expect(checkpoint.turn).toMatchObject({ status: 'succeeded', mode: 'agent',
        request: { astra: { admission: 'ordinary-agent-v1', goal: { kind: 'agent', modelMode: 'max', modelChoice: role } } },
        outcome: { summary: 'Проект готов — статус проверен через V3.' } });
      expect(cloudCalls).toHaveLength(2); expect(capabilityCalls).toBe(1);
      expect(nativeProvider.proposePrepared).not.toHaveBeenCalled();
    } finally {
      await coordinator?.stop(); await pilot?.stop(); await modelServer.close(); await kernel.stop();
      await rm(root, { recursive: true, force: false });
    }
  }, 20_000);
});
