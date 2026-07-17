import type { MonarchModuleManifest } from '../../core';

export const modelsManifest: MonarchModuleManifest = {
  id: 'models',
  name: 'Monarch Models',
  version: '0.1.0',
  kind: 'runtime',
  description: 'Local model catalog and routing policy surface for Monarch LLM runtimes.',
  owns: ['models', 'llm', 'router model', 'gemma', 'модели', 'роутер', 'изображения'],
  permissions: ['read', 'network', 'execute'],
  events: [
    'models.activated',
  ],
  capabilities: [
    {
      id: 'models.catalog.list',
      moduleId: 'models',
      title: 'List local models',
      description: 'Read the local Gemma model folder and summarize available text and vision profiles.',
      risk: 'read',
      routing: {
        aliases: ['list models', 'show models', 'покажи модели', 'список моделей'],
        keywords: ['models', 'llm', 'catalog', 'модели', 'каталог', 'локальные модели'],
        examples: ['show local models', 'покажи доступные LLM модели'],
        intentKinds: ['models.read', 'models.catalog'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'models.runtime.status',
      moduleId: 'models',
      title: 'Show model runtime status',
      description: 'Show which local model files are present and which Monarch-managed inference runners are configured.',
      risk: 'read',
      routing: {
        aliases: ['model runtime status', 'runner status', 'статус раннеров'],
        keywords: ['runtime', 'runner', 'adapter', 'раннер', 'адаптер'],
        examples: ['show model runtime status', 'покажи статус раннеров моделей'],
        intentKinds: ['models.read', 'models.runtime'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'models.chat.select',
      moduleId: 'models',
      title: 'Select chat model',
      description: 'Select the Fast, Medium, or Pro Gemma profile for a user input.',
      risk: 'read',
      routing: {
        aliases: ['select model', 'choose model', 'выбери модель'],
        keywords: ['select', 'choose', 'fast', 'balanced', 'deepthinking', 'gemma', 'модель', 'выбери'],
        examples: ['choose a model for this request', 'какую модель использовать'],
        intentKinds: ['models.read', 'model.select'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      id: 'models.router.pipeline',
      moduleId: 'models',
      title: 'Describe router pipeline',
      description: 'Describe the Monarch routing pipeline and deterministic Gemma profile selection.',
      risk: 'read',
      routing: {
        aliases: ['router pipeline', 'routing pipeline', 'пайплайн роутера'],
        keywords: ['router', 'pipeline', 'gemma', 'роутер', 'маршрут', 'пайплайн'],
        examples: ['show router pipeline', 'покажи пайплайн роутера'],
        intentKinds: ['models.read', 'router.pipeline'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'models.chat.complete',
      moduleId: 'models',
      title: 'Complete with local model',
      description: 'Call a configured self-hosted local model runtime and normalize its output.',
      risk: 'network',
      routing: {
        aliases: ['complete with model', 'run local model', 'model inference'],
        keywords: ['complete', 'inference', 'generate', 'local model', 'llm'],
        examples: ['complete with weak model', 'run local model inference'],
        intentKinds: ['models.infer', 'model.complete'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          role: { type: 'string' },
          system: { type: 'string' },
          temperature: { type: 'number' },
          maxTokens: { type: 'number' },
          responseFormat: { type: 'string' },
          timeoutMs: { type: 'number' },
          imageAttachments: { type: 'array' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      id: 'models.runtime.start',
      moduleId: 'models',
      title: 'Start model runtime',
      description: 'Start a configured Monarch-owned local model runner command and wait for readiness.',
      risk: 'execute',
      routing: {
        aliases: ['start model runtime', 'start local model runner'],
        keywords: ['start', 'runtime', 'runner', 'model', 'llama'],
        examples: ['start weak model runtime'],
        intentKinds: ['models.runtime.start'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['role'],
        additionalProperties: false,
      },
    },
    {
      id: 'models.runtime.stop',
      moduleId: 'models',
      title: 'Stop model runtime',
      description: 'Stop a model runtime process started by Monarch.',
      risk: 'execute',
      routing: {
        aliases: ['stop model runtime', 'stop local model runner'],
        keywords: ['stop', 'runtime', 'runner', 'model', 'llama'],
        examples: ['stop weak model runtime'],
        intentKinds: ['models.runtime.stop'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
        },
        required: ['role'],
        additionalProperties: false,
      },
    },
  ],
};
