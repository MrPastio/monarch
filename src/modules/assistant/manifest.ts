import type { MonarchModuleManifest } from '../../core';

export const assistantManifest: MonarchModuleManifest = {
  id: 'assistant',
  name: 'Monarch Agent',
  version: '0.1.0',
  kind: 'runtime',
  description: 'Direct assistant reply lane backed by Monarch routing and local model selection.',
  owns: ['assistant', 'chat', 'conversation', 'direct reply'],
  permissions: ['none', 'read', 'write'],
  capabilities: [
    {
      id: 'assistant.reply',
      moduleId: 'assistant',
      title: 'Prepare assistant reply',
      description: 'Prepare a direct conversational response route and select the local model tier for it.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          timeoutMs: { type: 'number' },
          jobId: { type: 'string' },
          clientConversationId: { type: 'string' },
          clientSessionId: { type: 'string' },
          image_attachments: { type: 'array' },
          model_override: {
            type: 'string',
            enum: ['gemma', 'gemma_low', 'gemma_high', 'weak', 'medium', 'powerful', 'reasoning', 'gemma4-fast', 'gemma4-balanced', 'gemma4-deepthinking', 'gemma4-31b'],
          },
          route: { type: 'object' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      id: 'assistant.cancel',
      moduleId: 'assistant',
      title: 'Cancel assistant reply',
      description: 'Cancel an active streaming assistant response.',
      risk: 'none',
      inputSchema: {
        type: 'object',
        properties: {
          intentId: { type: 'string' },
        },
        required: ['intentId'],
        additionalProperties: false,
      },
    },
  ],
};
