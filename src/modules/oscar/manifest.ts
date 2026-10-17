import type { MonarchModuleManifest } from '../../core';

const OSCAR_MODEL_IDS = [
  'weak',
  'medium',
  'gemma',
  'gemma_low',
  'gemma_high',
  'gemma4-fast',
  'gemma4-balanced',
  'qwen3.8-27b-pro',
  'qwen3-coder-30b-a3b-instruct',
  'deepseek-coder-v2-lite-instruct',
];

const OSCAR_CHAT_INPUT_PROPERTIES = {
  messages: { type: 'array' },
  conversation_id: { type: 'string' },
  incognito: { type: 'boolean' },
  image_attachments: { type: 'array' },
  research_mode: { type: 'string', enum: ['auto', 'off', 'deep'] },
  use_memory: { type: 'boolean' },
  reasoning_effort: { type: 'string' },
  requested_model: { type: 'string', enum: OSCAR_MODEL_IDS },
  model_selection_source: { type: 'string', enum: ['auto', 'user-explicit', 'fallback', 'recovery'] },
  deep_thinking_consent: { type: 'string', enum: ['allow', 'deny'] },
  route: { type: 'object' },
  max_new_tokens: { type: 'number' },
  temperature: { type: 'number' },
  top_p: { type: 'number' },
  execution_authority: { type: 'string', enum: ['none'] },
  persistence_owner: { type: 'string', enum: ['backend', 'coordinator'] },
  turn_id: { type: 'string' },
  client_message_id: { type: 'string' },
};

function createOscarChatInputSchema({ webSearch = false } = {}) {
  return {
    type: 'object',
    properties: {
      ...OSCAR_CHAT_INPUT_PROPERTIES,
      ...(webSearch ? { web_search: { type: 'boolean' } } : {}),
    },
    required: ['messages'],
    additionalProperties: false,
  };
}

export const oscarManifest: MonarchModuleManifest = {
  id: 'oscar',
  name: 'Monarch Oscar',
  version: '0.1.0',
  kind: 'domain',
  description: 'Monarch-native compatibility surface for porting the Oscar local agent into Monarch.',
  owns: [
    'oscar',
    'chat',
    'local agent',
    'web search',
    'oscar memory',
    'оскар',
    'чат',
    'локальный агент',
    'поиск',
    'память oscar',
  ],
  permissions: ['none', 'read', 'network', 'execute'],
  events: [
    'oscar.activated',
    'oscar.backend.checked',
    'oscar.backend.started',
    'oscar.backend.stopped',
    'oscar.generation.cancelled',
    'oscar.model.unloaded',
    'oscar.chat.completed',
    'oscar.conversations.changed',
    'oscar.memory.changed',
    'oscar.search.completed',
  ],
  capabilities: [
    {
      id: 'oscar.status',
      moduleId: 'oscar',
      title: 'Read Oscar status',
      description: 'Read the configured Oscar project path, bridge endpoint, backend health, model status, and memory stats.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },

    },
    {
      id: 'oscar.backend.start',
      moduleId: 'oscar',
      title: 'Start Oscar backend',
      description: 'Start the managed local Oscar backend and verify health, model status, and memory stats.',
      risk: 'execute',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },

    },
    {
      id: 'oscar.model.unload',
      moduleId: 'oscar',
      title: 'Unload Oscar model',
      description: 'Release loaded Oscar model weights and CUDA/CPU memory from the local backend.',
      risk: 'execute',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },

    },
    {
      id: 'oscar.generation.cancel',
      moduleId: 'oscar',
      title: 'Cancel Oscar generation',
      description: 'Cancel the currently running Oscar model generation without stopping the backend.',
      risk: 'none',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },

    },
    {
      id: 'oscar.backend.stop',
      moduleId: 'oscar',
      title: 'Stop Oscar backend',
      description: 'Stop the local Oscar backend process tree to release Python, CUDA, and model memory completely.',
      risk: 'execute',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },

    },
    {
      id: 'oscar.chat.local',
      moduleId: 'oscar',
      title: 'Run Oscar local chat',
      description: 'Send a chat request to Oscar-compatible local chat without enabling web search.',
      risk: 'read',
      inputSchema: createOscarChatInputSchema(),

    },
    {
      id: 'oscar.chat.route',
      moduleId: 'oscar',
      title: 'Preview Oscar chat route',
      description: 'Preview automatic model and web-search routing without starting generation.',
      risk: 'read',
      inputSchema: createOscarChatInputSchema(),
    },
    {
      id: 'oscar.chat.stream',
      moduleId: 'oscar',
      title: 'Run Oscar chat stream',
      description: 'Send a chat request to Oscar-compatible local chat and stream the response.',
      risk: 'read',
      inputSchema: createOscarChatInputSchema({ webSearch: true }),

    },
    {
      id: 'oscar.chat.web',
      moduleId: 'oscar',
      title: 'Run Oscar chat with web search',
      description: 'Send a chat request to Oscar-compatible local chat with web search enabled.',
      risk: 'network',
      inputSchema: createOscarChatInputSchema(),

    },
    {
      id: 'oscar.conversations.manage',
      moduleId: 'oscar',
      title: 'Manage Oscar conversations',
      description: 'List, create, open, append messages, rename, archive, clear, or delete persistent Oscar conversations.',
      risk: 'none',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'get', 'update', 'edit_message', 'append_message', 'clear', 'delete'] },
          id: { type: 'string' },
          message_id: { type: 'string' },
          content: { type: 'string' },
          role: { type: 'string', enum: ['user', 'assistant'] },
          token_count: { type: 'number' },
          elapsed_ms: { type: 'number' },
          model_tier: { type: 'string' },
          client_message_id: { type: 'string' },
          turn_id: { type: 'string' },
          task_id: { type: 'string' },
          provenance: { type: 'object' },
          outcome: { type: 'string' },
          integrity_warning: { type: 'string' },
          include_archived: { type: 'boolean' },
          limit: { type: 'number', minimum: 1, maximum: 200 },
          message_limit: { type: 'number', minimum: 1, maximum: 200 },
          before: { type: 'number', minimum: 1 },
          title: { type: 'string' },
          archived: { type: 'boolean' },
        },
        required: ['action'],
        additionalProperties: false,
      },

    },
    {
      id: 'oscar.memory.derived.manage',
      moduleId: 'oscar',
      title: 'Manage automatically captured Oscar memory',
      description: 'List or forget the episodes and topic capsules Memory V4 captured on its own from past chat turns.',
      risk: 'none',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'forget_episode', 'forget_capsule', 'forget_all'] },
          id: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },

    },
    {
      id: 'oscar.search.ingest',
      moduleId: 'oscar',
      title: 'Run Oscar web search ingest',
      description: 'Run Oscar web search and ingest fetched pages into Oscar memory through its local backend.',
      risk: 'network',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'number' },
          fetch_pages: { type: 'boolean' },
        },
        required: ['query'],
        additionalProperties: false,
      },

    },
  ],
};
