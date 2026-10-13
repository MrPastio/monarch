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

      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          content: {},
          path: { type: 'string', description: 'File path, relative to the artifacts folder or absolute. With fileName, a path without an extension is the folder that receives the file.' },
          fileName: { type: 'string', description: 'File name when path is omitted or names a folder.' },
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
