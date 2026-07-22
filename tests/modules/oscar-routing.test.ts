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
      voiceFast: vi.fn().mockResolvedValue({
        text: 'Короткий Fast-ответ.',
        model: 'gemma4-fast',
        generation_ms: 720,
      }),
      voiceRealtime: vi.fn().mockResolvedValue({
        text: 'В Киеве сейчас двадцать градусов.',
        model: 'open-meteo',
        kind: 'weather',
        source_count: 1,
        search_ms: 180,
        generation_ms: 0,
      }),
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

  it('runs the isolated Fast voice contract without building a normal chat request', async () => {
    const result = await module.executeCapability({
      capabilityId: 'oscar.voice.fast',
      input: { text: '  Сравни два варианта  ', language: 'ru' },
    } as any, mockContext);

    expect(result).toMatchObject({
      ok: true,
      output: { text: 'Короткий Fast-ответ.', model: 'gemma4-fast' },
    });
    expect(mockClient.voiceFast).toHaveBeenCalledWith({ text: 'Сравни два варианта', language: 'ru' });
    expect(mockClient.chat).not.toHaveBeenCalled();
    expect(mockContext.emit).toHaveBeenCalledWith(
      'oscar.voice.fast.completed',
      'oscar',
      expect.objectContaining({ model: 'gemma4-fast' }),
    );
  });

  it('runs realtime voice search through its network capability without building normal chat', async () => {
    const result = await module.executeCapability({
      capabilityId: 'oscar.voice.realtime',
      input: { text: '  Погода в Киеве  ', kind: 'weather', language: 'ru', location: 'Киев' },
    } as any, mockContext);

    expect(result).toMatchObject({
      ok: true,
      output: { text: 'В Киеве сейчас двадцать градусов.', kind: 'weather', source_count: 1, model: 'open-meteo' },
    });
    expect(mockClient.voiceRealtime).toHaveBeenCalledWith({
      text: 'Погода в Киеве',
      kind: 'weather',
      language: 'ru',
      location: 'Киев',
    });
    expect(mockClient.chat).not.toHaveBeenCalled();
    expect(mockContext.emit).toHaveBeenCalledWith(
      'oscar.voice.realtime.completed',
      'oscar',
      expect.objectContaining({ sourceCount: 1, kind: 'weather', model: 'open-meteo', generationMs: 0 }),
    );
  });

  it('rejects weather without a location before calling the realtime backend', async () => {
    const result = await module.executeCapability({
      capabilityId: 'oscar.voice.realtime',
      input: { text: 'Погода прямо сейчас', kind: 'weather', language: 'ru' },
    } as any, mockContext);

    expect(result).toMatchObject({
      ok: false,
      error: 'voice-weather-location-required',
    });
    expect(mockClient.voiceRealtime).not.toHaveBeenCalled();
    expect(mockClient.chat).not.toHaveBeenCalled();
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

  it('activates matched SKILL.md workflows before calling the Oscar backend', async () => {
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
    module = new OscarModule(mockClient, { activateForPrompt });

    await module.executeCapability({
      capabilityId: 'oscar.chat.stream',
      input: { messages: [{ role: 'user', content: 'review this worktree' }] },
    } as any, mockContext);

    expect(activateForPrompt).toHaveBeenCalledWith('review this worktree', expect.objectContaining({
      limit: 2,
      minimumScore: 0.55,
    }));
    expect(mockClient.streamChat.mock.calls[0][0].skills).toEqual([expect.objectContaining({
      name: 'review-worktree',
      instructions: 'Inspect the diff and run focused tests.',
    })]);
    expect(mockContext.emit).toHaveBeenCalledWith('oscar.skills.activated', 'oscar', expect.objectContaining({
      skills: ['review-worktree'],
    }));
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

    expect(mockClient.streamChat.mock.calls[1][0].skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'monarch-security',
        instructions: expect.stringContaining('security.scan.system'),
      }),
    ]));
  });

  it('keeps a compact full capability index available to the model', async () => {
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

    expect(mockClient.streamChat.mock.calls[0][0].capabilities).toHaveLength(40);
  });

  it('prioritizes Device capabilities from Russian routing metadata in ordinary chat', async () => {
    const deviceCapability = {
      id: 'device.app.open',
      moduleId: 'device',
      title: 'Open an installed Windows application',
      description: 'Launch an installed app.',
      risk: 'device-control',
      inputSchema: { type: 'object', properties: { app: { type: 'string' } } },
      routing: {
        aliases: ['открой приложение', 'запусти программу'],
        keywords: ['телеграм', 'приложение'],
        examples: ['Оскар, открой Телеграм'],
      },
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
    expect(request.capabilities[0]).toMatchObject({
      id: 'device.app.open',
      module: 'device',
      system: 'Monarch Device',
    });
    expect(request.capabilities[0].inputSchema).toBeTruthy();
  });

  it('restricts a trusted Coder turn to coder capabilities', async () => {
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
    expect(request.capabilities.map((capability: any) => capability.id)).toEqual([
      'coder.files.read',
      'coder.files.write',
    ]);
    expect(request.capabilities.every((capability: any) => capability.inputSchema)).toBe(true);
    expect(request.messages).toEqual([
      { role: 'system', content: marker },
      { role: 'user', content: 'CODER MODE TASK\nПроведи аудит проекта.' },
      {
        role: 'user',
        content: 'CODER TOOL RECEIPTS\nExecution status and capability identity are trusted Kernel facts. '
          + 'The project contains models and SECURITY_AUDIT.md. Continue from these results.',
      },
    ]);
    expect(request.messages.some((message: any) => message.content.includes('<live_monarch_system>'))).toBe(false);
    expect(request.messages.some((message: any) => message.content.includes('<local_user_context>'))).toBe(false);
    expect(request.skills).toEqual([]);
    expect((mockContext as any).execute).not.toHaveBeenCalled();
  });

  it('keeps the full Coder index while bounding detailed schemas to the relevant working set', async () => {
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

    const capabilities = mockClient.chat.mock.calls[0][0].capabilities;
    expect(capabilities).toHaveLength(20);
    expect(capabilities.filter((capability: any) => capability.inputSchema)).toHaveLength(12);
    expect(capabilities.find((capability: any) => capability.id === 'coder.demo.19').inputSchema).toBeTruthy();
  });

  it('provides the complete Security capability catalog for Security conversations', async () => {
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

    const catalog = mockClient.streamChat.mock.calls[0][0].capabilities;
    expect(catalog.filter((item: any) => item.module === 'security')).toHaveLength(30);
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
    expect(request.capabilities.map((item: any) => item.id)).toEqual(expect.arrayContaining(['safe.status', 'sharing.status']));
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
    expect(request.capabilities.map((item: any) => item.id)).toContain('oscar.status');
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

  it('delegates an explicit whole-system check to live Monarch Diagnostics', async () => {
    const decision = await module.handleIntent({
      id: 'intent_oscar_system_inspection',
      text: 'Oscar, проверь всю систему Monarch адаптивно',
    } as any);

    expect(decision).toMatchObject({
      targetModuleId: 'diagnostics',
      capabilityId: 'diagnostics.system.inspect',
      permissionMode: 'allow',
    });
  });

  it('delegates operational Oscar Security commands to the Security module', async () => {
    const decision = await module.handleIntent({
      id: 'intent_oscar_security_scan',
      text: 'Oscar, проверь систему на вирусы через Monarch Security',
    } as any);

    expect(decision).toBeNull();
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

  it('routes Oscar Gemma chat requests with requested_model gemma', async () => {
    const decision = await module.handleIntent({
      id: 'intent_gemma',
      text: 'спроси Oscar через Gemma ответь коротко',
    } as any);

    expect(decision?.capabilityId).toBe('oscar.chat.local');
    expect((decision?.input as any)?.requested_model).toBe('gemma');
  });

  it('keeps Oscar independence followups in chat instead of treating them as bridge requests', async () => {
    const decision = await module.handleIntent({
      id: 'intent_oscar_independence_followup',
      text: 'Oscar, как ты думаешь твой создатель мог создать тебя ради этого,что бы он имел цифровую независимость?',
    } as any);

    expect(decision?.capabilityId).toBe('oscar.chat.local');
    expect((decision?.input as any)?.messages?.[0]?.content).toContain('цифровую независимость');
  });

  it('continues to leave explicit Oscar bridge requests for Astra', async () => {
    const decision = await module.handleIntent({
      id: 'intent_oscar_bridge',
      text: 'Oscar покажи мост с Astra',
    } as any);

    expect(decision).toBeNull();
  });

  it('keeps simple Oscar meta chat on low effort and weak route hint', async () => {
    const decision = await module.handleIntent({
      id: 'intent_oscar_meta_fast',
      text: 'Oscar что ты умеешь',
    } as any);

    expect(decision?.capabilityId).toBe('oscar.chat.local');
    expect((decision?.input as any)?.reasoning_effort).toBe('low');
    expect((decision?.input as any)?.route).toMatchObject({
      intentKind: 'capabilities_question',
      modelTier: 'weak',
    });
  });

  it('routes Russian Oscar unload requests to model unload confirmation', async () => {
    const decision = await module.handleIntent({
      id: 'intent_unload_ru',
      text: 'Oscar выгрузи модель из памяти',
    } as any);

    expect(decision?.capabilityId).toBe('oscar.model.unload');
    expect(decision?.permissionMode).toBe('confirm');
  });

  it('routes and executes Oscar generation cancel without confirmation', async () => {
    const decision = await module.handleIntent({
      id: 'intent_cancel_generation_ru',
      text: 'Oscar сбрось очередь генерации',
    } as any);

    expect(decision?.capabilityId).toBe('oscar.generation.cancel');
    expect(decision?.permissionMode).toBe('allow');

    const result = await module.executeCapability({
      capabilityId: 'oscar.generation.cancel',
      input: {},
    } as any, mockContext);

    expect(result.ok).toBe(true);
    expect(mockClient.cancelGeneration).toHaveBeenCalled();
  });

  it('routes Russian Oscar backend stop requests to backend stop confirmation', async () => {
    const decision = await module.handleIntent({
      id: 'intent_stop_backend_ru',
      text: 'Oscar останови backend runtime',
    } as any);

    expect(decision?.capabilityId).toBe('oscar.backend.stop');
    expect(decision?.permissionMode).toBe('confirm');
  });

  it('routes Russian Oscar backend start requests to backend start confirmation', async () => {
    const decision = await module.handleIntent({
      id: 'intent_start_backend_ru',
      text: 'Oscar запусти backend runtime',
    } as any);

    expect(decision?.capabilityId).toBe('oscar.backend.start');
    expect(decision?.permissionMode).toBe('confirm');
  });

  it.each([
    ['Oscar, объясни теорию очередей', 'oscar.chat.local'],
    ['Oscar, как остановить прокрастинацию?', 'oscar.chat.local'],
    ['Oscar, что думаешь о модели поведения?', 'oscar.chat.local'],
    ['Oscar, что такое память человека?', 'oscar.chat.local'],
    ['Oscar, как работает интернет?', 'oscar.chat.local'],
    ['Oscar, что означает статус-кво?', 'oscar.chat.local'],
    ['Oscar, проверь статус системы кровообращения и объясни', 'oscar.chat.local'],
    ['Oscar, проверь вирус гриппа и объясни риски', 'oscar.chat.local'],
    ['Oscar, как защитить растения от вредителей?', 'oscar.chat.local'],
    ['Oscar, найди в интернете новости OpenAI', 'oscar.search.ingest'],
    ['Oscar, search Monarch', 'oscar.search.ingest'],
    ['Oscar, найди в памяти прошлый разговор', 'oscar.memory.search'],
    ['Oscar, найди файл package.json', 'oscar.chat.local'],
  ])('does not confuse ordinary language with control routes: %s', async (text, capabilityId) => {
    const decision = await module.handleIntent({
      id: `intent_${capabilityId}`,
      text,
    } as any);

    expect(decision?.capabilityId).toBe(capabilityId);
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
