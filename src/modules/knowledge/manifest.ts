import type { MonarchModuleManifest } from '../../core';

export const knowledgeManifest: MonarchModuleManifest = {
  id: 'knowledge',
  name: 'Monarch Knowledge',
  version: '0.1.0',
  kind: 'tooling',
  description: 'Local-first knowledge policy that decides when web search is required or optional.',
  owns: ['knowledge', 'web policy', 'search policy', 'freshness'],
  permissions: ['read'],
  capabilities: [
    {
      id: 'knowledge.policy.evaluate',
      moduleId: 'knowledge',
      title: 'Evaluate knowledge policy',
      description: 'Classify a request as local-only, web-optional, or web-required.',
      risk: 'read',
      routing: {
        aliases: ['knowledge policy', 'web policy', 'need web', 'should search web'],
        keywords: ['knowledge', 'policy', 'web', 'internet', 'search', 'fresh', 'latest'],
        examples: ['should this request use web search', 'evaluate knowledge policy for latest news'],
        intentKinds: ['knowledge.policy', 'search.policy'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          webEnabled: { type: 'boolean' },
          internetAvailable: { type: 'boolean' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ],
};
