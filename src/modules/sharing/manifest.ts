import type { MonarchModuleManifest } from '../../core';

export const sharingManifest: MonarchModuleManifest = {
  id: 'sharing',
  name: 'Monarch Sharing',
  version: '0.1.0',
  kind: 'runtime',
  description: 'Offline OpenAI-compatible API surface for Monarch-managed local GGUF models.',
  owns: [
    'sharing',
    'local model api',
    'openai compatible api',
    'offline inference service',
    'шаринг',
    'локальный api',
    'api моделей',
  ],
  permissions: ['read'],
  dependencies: ['models', 'oscar'],
  events: ['sharing.activated'],
  capabilities: [
    {
      id: 'sharing.connection.get',
      moduleId: 'sharing',
      title: 'Show Sharing connection',
      description: 'Show the local OpenAI-compatible base URL, endpoints, and redacted authentication contract.',
      risk: 'read',
      routing: {
        aliases: ['sharing endpoint', 'local ai api', 'openai compatible endpoint', 'адрес sharing', 'локальный api моделей'],
        keywords: ['sharing', 'endpoint', 'openai', 'api', 'local', 'шаринг', 'адрес', 'локальный'],
        examples: ['how do I connect an app to Monarch Sharing', 'покажи адрес Monarch Sharing'],
        intentKinds: ['sharing.read', 'sharing.connection'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'sharing.status',
      moduleId: 'sharing',
      title: 'Check Sharing status',
      description: 'Probe the loopback Sharing endpoint and report locally available public model IDs.',
      risk: 'read',
      routing: {
        aliases: ['sharing status', 'sharing health', 'статус sharing', 'статус шаринга'],
        keywords: ['sharing', 'status', 'health', 'connected', 'шаринг', 'статус', 'подключение'],
        examples: ['check Monarch Sharing status', 'проверь статус Sharing'],
        intentKinds: ['sharing.read', 'sharing.status'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'sharing.models.list',
      moduleId: 'sharing',
      title: 'List shared models',
      description: 'List the local model IDs exposed through the OpenAI-compatible Sharing API.',
      risk: 'read',
      routing: {
        aliases: ['sharing models', 'shared models', 'модели sharing', 'расшаренные модели'],
        keywords: ['sharing', 'models', 'api', 'shared', 'шаринг', 'модели', 'доступные'],
        examples: ['list models exposed by Monarch Sharing', 'покажи модели Sharing'],
        intentKinds: ['sharing.read', 'sharing.models'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
};
