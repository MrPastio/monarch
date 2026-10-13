import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OscarModule } from '../../src/modules/oscar/index.js';
import type { MonarchKernelContext } from '../../src/core/index.js';

describe('OscarModule Routing & Filtering', () => {
  let module: OscarModule;
  let mockClient: any;
  let mockContext: MonarchKernelContext;

  beforeEach(() => {
    mockClient = {
      config: { apiBase: 'http://127.0.0.1:7861' },
      chat: vi.fn().mockResolvedValue({
        answer: 'Test answer',
        sources: [
          'http://old-web-source.com',
          { url: 'https://another-old-source.com', title: 'Old' },
          { source: 'internal_memory_doc' }
        ]
      }),
      status: vi.fn().mockResolvedValue({ connected: true }),
      cancelGeneration: vi.fn().mockResolvedValue({ ok: true, cancelled: true }),
      appendConversationMessage: vi.fn().mockResolvedValue({ ok: true }),
    };
    mockContext = {
      emit: vi.fn(),
      audit: vi.fn(),
      listCapabilities: vi.fn().mockReturnValue([]),
      listModules: vi.fn().mockReturnValue([]),
      getPermissionProfile: vi.fn().mockReturnValue({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }),
    } as unknown as MonarchKernelContext;
    
    module = new OscarModule(mockClient);
  });

  it('keeps an explicit self-check local but still sends it to the model', async () => {
    const input = { messages: [{ role: 'user', content: 'проверка связи' }] };

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.web',
      input
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.chat).toHaveBeenCalledOnce();
    expect(mockClient.chat.mock.calls[0][0].web_search).toBe(false);
    expect(result.output?.response.answer).toBe('Test answer');
    expect(result.output?.response.sources).toEqual([{ source: 'internal_memory_doc' }]);
  });

  it.each(['none', 'gemma4-fast', 'gemma4-balanced', 'gemma4-deepthinking', 'gemma4-31b'])(
    'streams an ordinary how-you-work question through the selected model profile: %s',
    async (requestedModel) => {
      mockClient.streamChat = vi.fn().mockImplementation(async function* () {
        yield { type: 'token', data: { token: 'real model answer' } };
        yield { type: 'done', data: {} };
      });
      const input = {
        messages: [{ role: 'user', content: 'Можешь подробно рассказать о том, как ты работаешь?' }],
        requested_model: requestedModel,
      };

      const result = await module.executeCapability({
        capabilityId: 'oscar.chat.stream',
        input,
      } as any, mockContext);

      expect(result.ok).toBe(true);
      expect(mockClient.streamChat).toHaveBeenCalledOnce();
      expect(mockClient.streamChat.mock.calls[0][0].requested_model).toBe(requestedModel);
    },
  );

  it('preserves web search for internal terms if explicit marker is used', async () => {
    const input = { messages: [{ role: 'user', content: 'Найди новости про Monarch' }] };

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.web',
      input
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.chat).toHaveBeenCalled();
    const chatReq = mockClient.chat.mock.calls[0][0];

    // Explicit marker "Найди" overrides any suppression
    expect(chatReq.web_search).toBe(true);
  });

  it('does not web-search a question about Oscar fallback state', async () => {
    const input = { messages: [{ role: 'user', content: 'почему ты так часто уходишь в безопасный fallback-режим?' }] };

    await module.executeCapability({
      capabilityId: 'oscar.chat.web',
      input,
    } as any, mockContext);

    expect(mockClient.chat.mock.calls[0][0].web_search).toBe(false);
  });

  it('drops web_search from chatReq if oscar.chat.local is used', async () => {
    const input = { messages: [{ role: 'user', content: 'hello' }] };

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.local',
      input
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.chat).toHaveBeenCalled();
    const chatReq = mockClient.chat.mock.calls[0][0];

    // Local chat delegates search selection to the backend auto-router.
    expect(chatReq.web_search).toBeUndefined();
  });

  it('keeps web_search as false if missing in stream input', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'token', data: { token: 'stream' } };
    });

    const input = { messages: [{ role: 'user', content: 'hello stream' }] };

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.streamChat).toHaveBeenCalled();
    const chatReq = mockClient.streamChat.mock.calls[0][0];

    // Missing web_search means automatic freshness routing.
    expect(chatReq.web_search).toBeUndefined();
  });

  it('keeps SKILL.md workflows out of answer-only prompts', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    const activateForPrompt = vi.fn().mockResolvedValue([{
      id: 'codex.project.demo',
      name: 'review-worktree',
      displayName: 'Review Worktree',
      description: 'Review risky changes.',
      provider: 'codex',
      scope: 'project',
      location: '.agents/skills/review-worktree/SKILL.md',
      allowImplicitInvocation: true,
      userInvocable: true,
      argumentHint: '',
      context: 'inline',
      agent: '',
      allowedTools: [],
      disallowedTools: [],
      paths: [],
      legacyCommand: false,
      instructions: 'Inspect the diff and run focused tests.',
      arguments: '',
      explicit: false,
      truncated: false,
    }]);
    module = new OscarModule(mockClient);

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'review this worktree' }] },
    } as any, mockContext);

    expect(activateForPrompt).not.toHaveBeenCalled();
    expect(mockClient.streamChat.mock.calls[0][0]).toMatchObject({
      execution_authority: 'none',
      skills: [],
    });
    expect(mockClient.streamChat.mock.calls[0][0]).not.toHaveProperty('capabilities');
    expect(mockContext.emit).not.toHaveBeenCalledWith('oscar.skills.activated', 'oscar', expect.anything());
  });

  it('propagates a rejected nonstream backend response instead of reporting chat completion', async () => {
    mockClient.chat.mockResolvedValue({
      ok: false,
      answer: 'Оборванный ответ',
      sources: [],
      usage: { generation_stop_reason: 'length', likely_truncated: true },
    });

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.local',
      input: { messages: [{ role: 'user', content: 'Расскажи подробно' }] },
    } as any, mockContext);

    expect(result).toMatchObject({
      ok: false,
      error: 'model-output-truncated',
      output: { response: { answer: 'Оборванный ответ', ok: false } },
    });
    expect(mockContext.emit).toHaveBeenCalledWith(
      'oscar.chat.failed',
      'oscar',
      expect.objectContaining({ error: 'model-output-truncated' }),
    );
    expect(mockContext.emit).not.toHaveBeenCalledWith(
      'oscar.chat.completed',
      'oscar',
      expect.anything(),
    );
  });

  it('rejects contradictory nonstream success when completion telemetry says length', async () => {
    mockClient.chat.mockResolvedValue({
      ok: true,
      answer: 'Правдоподобный, но оборванный ответ',
      sources: [],
      usage: { generation_stop_reason: 'length', likely_truncated: true },
    });

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.local',
      input: { messages: [{ role: 'user', content: 'Расскажи подробно' }] },
    } as any, mockContext);

    expect(result).toMatchObject({
      ok: false,
      error: 'model-output-truncated',
      output: { response: { answer: 'Правдоподобный, но оборванный ответ', ok: true } },
    });
    expect(mockContext.emit).toHaveBeenCalledWith(
      'oscar.chat.failed',
      'oscar',
      expect.objectContaining({ error: 'model-output-truncated' }),
    );
    expect(mockContext.emit).not.toHaveBeenCalledWith(
      'oscar.chat.completed',
      'oscar',
      expect.anything(),
    );
  });

  it('attaches the native Security contract only to Security prompts', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'привет' }] },
    } as any, mockContext);

    expect(mockClient.streamChat.mock.calls[0][0].skills).toEqual([]);

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'Расскажи про Monarch Security' }] },
    } as any, mockContext);

    expect(mockClient.streamChat.mock.calls[1][0].skills).toEqual([]);
    expect(mockClient.streamChat.mock.calls[1][0].execution_authority).toBe('none');
  });

  it('does not expose the capability index to an answer-only model', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    (mockContext.listCapabilities as any).mockReturnValue(Array.from({ length: 40 }, (_, index) => ({
      id: `workspace.demo.${index}`,
      moduleId: 'workspace',
      title: `Demo ${index}`,
      description: 'demo capability',
      risk: 'read',
    })));

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'прочитай проект' }] },
    } as any, mockContext);

    expect(mockClient.streamChat.mock.calls[0][0]).toMatchObject({
      execution_authority: 'none',
    });
    expect(mockClient.streamChat.mock.calls[0][0]).not.toHaveProperty('capabilities');
    expect(mockClient.streamChat.mock.calls[0][0].access).toBeUndefined();
  });

  it('does not leak Device action contracts into ordinary Russian chat', async () => {
    const deviceCapability = {
      id: 'device.app.open',
      moduleId: 'device',
      title: 'Open an installed Windows application',
      description: 'Launch an installed app.',
      risk: 'device-control',
      inputSchema: { type: 'object', properties: { app: { type: 'string' } } },
    };
    (mockContext.listCapabilities as any).mockReturnValue([
      ...Array.from({ length: 55 }, (_, index) => ({
        id: `artifacts.demo.${index}`,
        moduleId: 'artifacts',
        title: `Artifact ${index}`,
        description: 'unrelated artifact capability',
        risk: 'read',
      })),
      deviceCapability,
    ]);

    await module.executeCapability({
      capabilityId: 'oscar.chat.local',
      input: { messages: [{ role: 'user', content: 'Оскар, открой Телеграм' }] },
    } as any, mockContext);

    const request = mockClient.chat.mock.calls[0][0];
    expect(request.execution_authority).toBe('none');
    expect(request).not.toHaveProperty('capabilities');
    expect(request).not.toHaveProperty('access');
  });

  it('keeps a legacy Coder marker answer-only and outside typed Agent authority', async () => {
    const capabilities = [
      { id: 'workspace.files.write', moduleId: 'workspace', title: 'Workspace write', description: 'write', risk: 'write' },
      { id: 'coder.files.read', moduleId: 'coder', title: 'Coder read', description: 'read', risk: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { id: 'coder.files.write', moduleId: 'coder', title: 'Coder write', description: 'write', risk: 'write', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    ];
    (mockContext.listCapabilities as any).mockReturnValue(capabilities);
    (mockContext.listModules as any).mockReturnValue([
      {
        manifest: {
          id: 'workspace', name: 'Monarch Workspace', version: '0.1.0', kind: 'tooling',
          description: 'Workspace files.', owns: ['files'], permissions: ['read'],
          capabilities: [capabilities[0]],
        },
        status: 'active',
        registeredAt: new Date(0).toISOString(),
      },
      {
        manifest: {
          id: 'profile', name: 'Monarch Identity', version: '0.1.0', kind: 'system',
          description: 'Identity profile.', owns: ['identity'], permissions: ['read'],
          capabilities: [],
        },
        status: 'active',
        registeredAt: new Date(0).toISOString(),
      },
      {
        manifest: {
          id: 'diagnostics', name: 'Monarch Diagnostics', version: '0.1.0', kind: 'system',
          description: 'Kernel audit status.', owns: ['kernel', 'audit', 'status'], permissions: ['read'],
          capabilities: [],
        },
        status: 'active',
        registeredAt: new Date(0).toISOString(),
      },
    ]);
    (mockContext as any).execute = vi.fn().mockResolvedValue({
      ok: true,
      output: { profile: { adaptiveSummary: 'must not enter Coder' } },
    });
    const marker = '<monarch_coder_mode>{"project":{"root":"E:\\\\Work"}}</monarch_coder_mode>';

    await module.executeCapability({
      capabilityId: 'oscar.chat.local',
      input: {
        messages: [
          { role: 'system', content: marker },
          { role: 'user', content: 'CODER MODE TASK\nПроведи аудит проекта.' },
          {
            role: 'user',
            content: 'CODER TOOL RECEIPTS\nExecution status and capability identity are trusted Kernel facts. '
              + 'The project contains models and SECURITY_AUDIT.md. Continue from these results.',
          },
        ],
        use_memory: false,
      },
    } as any, mockContext);

    const request = mockClient.chat.mock.calls[0][0];
    expect(request.execution_authority).toBe('none');
    expect(request).not.toHaveProperty('capabilities');
    expect(request).not.toHaveProperty('access');
    expect(request.messages[0]).toEqual({ role: 'system', content: '<monarch_answer_only_authority version="1" />' });
    expect(request.messages.some((message: any) => message.content.includes('<monarch_coder_mode>'))).toBe(false);
    expect(request.skills).toEqual([]);
  });

  it('applies zero-retention and context removal to the Coder chat lane too', async () => {
    module.setOwnerDevSettingsProvider(() => ({
      zeroRetentionEnabled: true,
      internetEnabled: false,
      memoryEnabled: false,
      historyContextEnabled: false,
      runtimeContextEnabled: false,
    }));
    (mockContext.listCapabilities as any).mockReturnValue([{
      id: 'coder.files.read', moduleId: 'coder', title: 'Coder read', description: 'read', risk: 'read',
    }]);
    const marker = '<monarch_coder_mode>{"project":{"root":"E:\\\\Work"}}</monarch_coder_mode>';

    await module.executeCapability({
      capabilityId: 'oscar.chat.local',
      input: {
        messages: [
          { role: 'system', content: marker },
          { role: 'user', content: 'Старый Coder ход' },
          { role: 'assistant', content: 'Старый Coder ответ' },
          { role: 'user', content: 'Новый Coder ход' },
        ],
        web_search: true,
        use_memory: true,
      },
    } as any, mockContext);

    const request = mockClient.chat.mock.calls[0][0];
    expect(request).toMatchObject({
      incognito: true,
      web_search: false,
      use_memory: false,
      dev_mode: { zero_retention: true, history_context_enabled: false },
    });
    expect(request.messages).toEqual([
      { role: 'system', content: '<monarch_answer_only_authority version="1" />' },
      { role: 'user', content: 'Новый Coder ход' },
    ]);
  });

  it('does not expose a Coder capability index through the compatibility chat lane', async () => {
    (mockContext.listCapabilities as any).mockReturnValue(Array.from({ length: 20 }, (_, index) => ({
      id: `coder.demo.${index}`,
      moduleId: 'coder',
      title: `Coder demo ${index}`,
      description: `bounded coder capability ${index}`,
      risk: 'write',
      inputSchema: { type: 'object', properties: { [`field_${index}`]: { type: 'string' } } },
    })));
    const marker = '<monarch_coder_mode>{"project":{"root":"E:\\\\Work"}}</monarch_coder_mode>';

    await module.executeCapability({
      capabilityId: 'oscar.chat.local',
      input: {
        messages: [
          { role: 'system', content: marker },
          { role: 'user', content: 'Use coder.demo.19 for this exact task' },
        ],
        use_memory: false,
      },
    } as any, mockContext);

    expect(mockClient.chat.mock.calls[0][0]).not.toHaveProperty('capabilities');
    expect(mockClient.chat.mock.calls[0][0].execution_authority).toBe('none');
  });

  it('keeps the Security action catalog out of answer-only Security conversations', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    const securityCapabilities = Array.from({ length: 30 }, (_, index) => ({
      id: `security.demo.${index}`,
      moduleId: 'security',
      title: `Security ${index}`,
      description: 'security capability',
      risk: index % 2 ? 'read' : 'execute',
    }));
    (mockContext.listCapabilities as any).mockReturnValue([
      ...securityCapabilities,
      { id: 'workspace.files.list', moduleId: 'workspace', title: 'Files', risk: 'read' },
    ]);

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'расскажи про Monarch Security и доступные проверки' }] },
    } as any, mockContext);

    expect(mockClient.streamChat.mock.calls[0][0]).not.toHaveProperty('capabilities');
    expect(mockClient.streamChat.mock.calls[0][0].execution_authority).toBe('none');
  });

  it('grounds named module questions for the model and raises the automatic route floor', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    const manifests = [
      {
        id: 'safe', name: 'Monarch Safe', version: '0.2.0', kind: 'domain',
        description: 'Isolated local vault.', owns: ['monarch safe'], permissions: ['read'],
        capabilities: [{ id: 'safe.status', moduleId: 'safe', title: 'Safe status', risk: 'read' }],
      },
      {
        id: 'sharing', name: 'Monarch Sharing', version: '0.1.0', kind: 'runtime',
        description: 'Offline OpenAI-compatible local model API.', owns: ['sharing', 'local model api'], permissions: ['read'],
        capabilities: [{ id: 'sharing.status', moduleId: 'sharing', title: 'Sharing status', risk: 'read' }],
      },
      {
        id: 'artifacts', name: 'Monarch Canvas', version: '0.1.0', kind: 'tooling',
        description: 'Artifact generation.', owns: ['artifacts', 'canvas'], permissions: ['read'],
        capabilities: [{ id: 'artifacts.list', moduleId: 'artifacts', title: 'Artifacts', risk: 'read' }],
      },
    ];
    (mockContext.listModules as any).mockReturnValue(manifests.map((manifest) => ({
      manifest, status: 'active', registeredAt: new Date(0).toISOString(),
    })));
    (mockContext.listCapabilities as any).mockReturnValue(manifests.flatMap((manifest) => manifest.capabilities));

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: {
        conversation_id: 'registry-chat',
        messages: [
          { role: 'user', content: 'Как тебе новые модули Monarch?' },
          { role: 'assistant', content: 'Какие именно?' },
          { role: 'user', content: 'Я про самые новые, Safe-Sharing' },
        ],
      },
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.streamChat).toHaveBeenCalledOnce();
    expect(mockClient.appendConversationMessage).not.toHaveBeenCalled();
    const request = mockClient.streamChat.mock.calls[0][0];
    const systemContext = request.messages.find((message: any) => message.role === 'system' && message.content.includes('<live_monarch_system>'));
    expect(request.route).toMatchObject({
      intentKind: 'monarch_registry_question',
      modelTier: 'medium',
      language: 'ru',
    });
    expect(systemContext?.content).toContain('Monarch Safe');
    expect(systemContext?.content).toContain('Monarch Sharing');
    expect(systemContext?.content).not.toContain('Monarch Canvas');
    expect(systemContext?.content).toContain('отдельные модули');
    expect(systemContext?.content).toContain('"resolvedMentionIds":["safe","sharing"]');
    expect(systemContext?.content).toContain('не выгружай сырой JSON');
    expect(request).not.toHaveProperty('capabilities');
    expect(request.execution_authority).toBe('none');
  });

  it('treats a leading Oscar address as a vocative instead of a registry module mention', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    const oscarManifest = {
      id: 'oscar', name: 'Monarch Oscar', version: '0.1.0', kind: 'domain',
      description: 'Local assistant.', owns: ['oscar', 'оскар'], permissions: ['read'],
      capabilities: [{ id: 'oscar.status', moduleId: 'oscar', title: 'Oscar status', risk: 'read' }],
    };
    (mockContext.listModules as any).mockReturnValue([{
      manifest: oscarManifest, status: 'active', registeredAt: new Date(0).toISOString(),
    }]);
    (mockContext.listCapabilities as any).mockReturnValue(oscarManifest.capabilities);

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: {
        messages: [{
          role: 'user',
          content: 'Эй Оскар зацени сайт https://julia-kolesnik.mrpastio.chatgpt.site/#contact',
        }],
        web_search: true,
      },
    } as any, mockContext);

    const request = mockClient.streamChat.mock.calls[0][0];
    expect(request.messages.some((message: any) => message.content.includes('<live_monarch_system>'))).toBe(false);
    expect(request).not.toHaveProperty('capabilities');
    expect(request.execution_authority).toBe('none');
  });

  it('still grounds an explicit Oscar module question', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    const oscarManifest = {
      id: 'oscar', name: 'Monarch Oscar', version: '0.1.0', kind: 'domain',
      description: 'Local assistant.', owns: ['oscar', 'оскар'], permissions: ['read'],
      capabilities: [{ id: 'oscar.status', moduleId: 'oscar', title: 'Oscar status', risk: 'read' }],
    };
    (mockContext.listModules as any).mockReturnValue([{
      manifest: oscarManifest, status: 'active', registeredAt: new Date(0).toISOString(),
    }]);

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'Проверь модуль Оскар и его статус' }] },
    } as any, mockContext);

    const request = mockClient.streamChat.mock.calls[0][0];
    const systemContext = request.messages.find((message: any) => message.content.includes('<live_monarch_system>'));
    expect(systemContext?.content).toContain('"resolvedMentionIds":["oscar"]');
  });

  it.each([
    'Расскажи про новую систему образования',
    'Что такое память человека?',
  ])('does not inject Monarch registry data into an unrelated semantic question: %s', async (content) => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    const manifests = [
      {
        id: 'memory', name: 'Monarch Memory', version: '0.1.0', kind: 'domain',
        description: 'Durable assistant memory.', owns: ['memory', 'память'], permissions: ['read'],
        capabilities: [{ id: 'memory.search', moduleId: 'memory', title: 'Memory search', risk: 'read' }],
      },
      {
        id: 'diagnostics', name: 'Monarch Diagnostics', version: '0.1.0', kind: 'domain',
        description: 'System diagnostics.', owns: ['system', 'система'], permissions: ['read'],
        capabilities: [{ id: 'diagnostics.system.inspect', moduleId: 'diagnostics', title: 'Inspect', risk: 'read' }],
      },
    ];
    (mockContext.listModules as any).mockReturnValue(manifests.map((manifest) => ({
      manifest, status: 'active', registeredAt: new Date(0).toISOString(),
    })));
    (mockContext.listCapabilities as any).mockReturnValue(manifests.flatMap((manifest) => manifest.capabilities));

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content }] },
    } as any, mockContext);

    const request = mockClient.streamChat.mock.calls[0][0];
    expect(request.messages.some((message: any) => message.content.includes('<live_monarch_system>'))).toBe(false);
    expect(request.route?.intentKind).not.toBe('monarch_registry_question');
  });

  it('keeps operational module checks on the capability path instead of synthesizing status', async () => {
    mockClient.streamChat = vi.fn().mockImplementation(async function* () {
      yield { type: 'done', data: { ok: true } };
    });
    (mockContext.listModules as any).mockReturnValue([{
      manifest: {
        id: 'sharing', name: 'Monarch Sharing', version: '0.1.0', kind: 'runtime',
        description: 'Offline API.', owns: ['sharing'], permissions: ['read'],
        capabilities: [{ id: 'sharing.status', moduleId: 'sharing', title: 'Sharing status', risk: 'read' }],
      },
      status: 'active',
      registeredAt: new Date(0).toISOString(),
    }]);

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'Проверь статус Monarch Sharing' }] },
    } as any, mockContext);

    expect(mockClient.streamChat).toHaveBeenCalledOnce();
  });

  it('raises stream chat risk when web search is requested', () => {
    expect(module.resolveCapabilityRisk({
      capabilityId: 'oscar.chat.stream',
      input: {
        web_search: true,
        messages: [{ role: 'user', content: 'найди в интернете' }],
      },
    } as any)).toBe('network');
  });

  it('keeps local stream risk unchanged when web search is off', () => {
    expect(module.resolveCapabilityRisk({
      capabilityId: 'oscar.chat.stream',
      input: {
        web_search: false,
        messages: [{ role: 'user', content: 'ответь локально' }],
      },
    } as any)).toBeUndefined();
  });

  it('does not raise network risk when a checked web toggle is suppressed for runtime diagnostics', () => {
    expect(module.resolveCapabilityRisk({
      capabilityId: 'oscar.chat.stream',
      input: {
        web_search: true,
        messages: [{ role: 'user', content: 'почему ты ушёл в fallback-режим?' }],
      },
    } as any)).toBeUndefined();
  });

  it('executes Oscar backend start through status auto-start probe', async () => {
    const result = await module.executeCapability({
      capabilityId: 'oscar.backend.start',
      input: {},
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.status).toHaveBeenCalledWith({ autoStart: true });
    expect(mockContext.emit).toHaveBeenCalledWith('oscar.backend.started', 'oscar', expect.objectContaining({
      connected: true,
    }));
  });

  it('suppresses web_search for internal project terms without explicit markers', async () => {
    const input = { messages: [{ role: 'user', content: 'что такое Monarch' }] };

    const result = await module.executeCapability({
      capabilityId: 'oscar.chat.web',
      input
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.chat).toHaveBeenCalled();
    const chatReq = mockClient.chat.mock.calls[0][0];

    // Internal query without marker drops web_search
    expect(chatReq.web_search).toBe(false);
  });
});
