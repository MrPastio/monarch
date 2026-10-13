import type { MonarchModuleManifest } from '../../core';

export const MAX_AGENT_RESPONSE_TOKENS = 8_192;

export const modelsManifest: MonarchModuleManifest = {
  id: 'models',
  name: 'Monarch Models',
  version: '0.1.0',
  kind: 'runtime',
  description: 'Local model catalog and routing policy surface for Monarch LLM runtimes.',
  owns: ['models', 'llm', 'router model', 'gemma', 'модели', 'роутер', 'изображения'],
  permissions: ['none', 'read', 'network', 'execute'],
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

      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'models.agent.respond',
      moduleId: 'models',
      title: 'Compose a local conversational answer',
      description: 'Generate a local answer only when the user request needs no file, application, device, browser, network, or other real-world action.',
      risk: 'none',
      agent: {
        tags: ['answer', 'conversation', 'local-model', 'no-side-effect'],
        preconditions: [{
          kind: 'no-real-world-effect-required',
          description: 'Use only when the requested outcome is an answer rather than an action.',
        }],
        effects: [{
          kind: 'answer-observation',
          description: 'Returns model-generated answer text with no authority to prove a local fact or real-world effect.',
          targetScope: 'agent-state',
        }],
        idempotency: 'idempotent',
        reversibility: 'automatic',
        effectProfile: {
          mutation: 'none',
          targetScope: 'agent-state',
          reversibility: 'automatic',
          privilege: 'normal',
          dataSensitivity: 'private',
          communication: 'loopback',
          financialImpact: false,
          identityImpact: false,
          securityImpact: false,
        },
        supportedSources: ['desktop', 'coder', 'voice', 'telegram', 'api', 'system'],
        estimatedLatency: 'long',
        computeClass: 'medium',
        cancellation: 'supported',
        verification: [{
          kind: 'schema',
          description: 'The result must contain non-empty local model output.',
          required: true,
        }],
        examples: [{ goal: 'Explain a concept without changing the computer.' }],
      },
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 16000 },
          role: { type: 'string' },
          system: { type: 'string', maxLength: 4000 },
          maxTokens: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_AGENT_RESPONSE_TOKENS,
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          rawText: { type: 'string' },
          role: { type: 'string' },
          adapter: { type: 'string' },
        },
        required: ['rawText'],
        additionalProperties: true,
      },

    },
    {
      id: 'models.agent.synthesize',
      moduleId: 'models',
      title: 'Synthesize a grounded Agent answer',
      description: 'Compose a user-facing answer from explicit successful Kernel observations in the current Agent Task.',
      risk: 'none',
      agent: {
        tags: ['answer', 'synthesis', 'grounded', 'kernel-observation', 'no-side-effect'],
        preconditions: [{
          kind: 'kernel-observations-required',
          description: 'Every observation id is resolved by Agent Runtime from the current task before dispatch.',
        }],
        effects: [{
          kind: 'answer-observation',
          description: 'Returns model-generated prose bound to current-task Kernel observation ids.',
          targetScope: 'agent-state',
        }],
        idempotency: 'idempotent',
        reversibility: 'automatic',
        effectProfile: {
          mutation: 'none',
          targetScope: 'agent-state',
          reversibility: 'automatic',
          privilege: 'normal',
          dataSensitivity: 'private',
          communication: 'loopback',
          financialImpact: false,
          identityImpact: false,
          securityImpact: false,
        },
        supportedSources: ['desktop', 'coder', 'voice', 'telegram', 'api', 'system'],
        estimatedLatency: 'long',
        computeClass: 'medium',
        cancellation: 'supported',
        verification: [{
          kind: 'schema',
          description: 'The synthesis must retain source observation ids; complete file batches also require exactly one validated summary and an exact observed excerpt per readable file.',
          required: true,
        }],
        examples: [{ goal: 'Summarize files after workspace inspection.' }],
      },
      inputSchema: {
        type: 'object',
        properties: {
          observationIds: {
            type: 'array',
            minItems: 1,
            maxItems: 128,
            items: { type: 'string' },
          },
          request: { type: 'string', minLength: 1, maxLength: 16000 },
          modelPolicy: {
            type: 'object', additionalProperties: false,
            properties: {
              requestedRole: { type: 'string' },
              selectionSource: { const: 'user-explicit' },
              fallback: { const: 'exact' },
            },
            required: ['requestedRole', 'selectionSource', 'fallback'],
          },
          observations: {
            type: 'array',
            minItems: 1,
            maxItems: 128,
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['observationIds'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          rawText: { type: 'string' },
          role: { type: 'string' },
          adapter: { type: 'string' },
          sourceObservationIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['rawText', 'sourceObservationIds'],
        additionalProperties: true,
      },

    },
    {
      id: 'models.chat.complete',
      moduleId: 'models',
      title: 'Complete with local model',
      description: 'Call a configured self-hosted local model runtime and normalize its output.',
      risk: 'network',

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
