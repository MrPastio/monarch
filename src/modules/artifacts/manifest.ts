import type { MonarchModuleManifest } from '../../core';

export const artifactsManifest: MonarchModuleManifest = {
  id: 'artifacts',
  name: 'Monarch Canvas',
  version: '0.1.0',
  kind: 'tooling',
  description: 'Safe generated artifact writer for html, markdown, text, and json outputs.',
  owns: ['artifacts', 'generated files', 'html artifact', 'markdown artifact'],
  permissions: ['read', 'write'],
  events: [
    'artifacts.activated',
    'artifacts.file.written',
  ],
  capabilities: [
    {
      id: 'artifacts.write',
      moduleId: 'artifacts',
      title: 'Write artifact',
      description: 'Write a generated html, markdown, text, or json artifact inside Monarch artifacts.',
      risk: 'write',
      routing: {
        aliases: ['write artifact', 'save artifact', 'create artifact'],
        keywords: ['artifact', 'html', 'markdown', 'json', 'generated', 'save', 'write'],
        examples: ['save markdown artifact', 'write html artifact'],
        intentKinds: ['artifact.write', 'file.generation'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          content: {},
          path: { type: 'string' },
          fileName: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        required: ['type', 'content'],
        additionalProperties: false,
      },
    },
    {
      id: 'artifacts.list',
      moduleId: 'artifacts',
      title: 'List artifacts',
      description: 'List recently generated artifact files.',
      risk: 'read',
      routing: {
        aliases: ['list artifacts', 'show artifacts'],
        keywords: ['artifact', 'artifacts', 'list', 'show', 'generated'],
        examples: ['list artifacts'],
        intentKinds: ['artifact.read'],
      },
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
  ],
};
