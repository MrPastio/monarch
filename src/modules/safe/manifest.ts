import type { MonarchModuleManifest } from '../../core';

export const safeManifest: MonarchModuleManifest = {
  id: 'safe',
  name: 'Monarch Safe',
  version: '0.2.0',
  kind: 'domain',
  description: 'Desktop-only isolated encrypted file vault with a device-bound PIN. Content access is deliberately absent from the shared Monarch kernel.',
  owns: ['encrypted vault status', 'monarch safe', 'изолированное хранилище'],
  permissions: ['read'],
  events: ['safe.activated'],
  capabilities: [{
    id: 'safe.status',
    moduleId: 'safe',
    title: 'Describe Monarch Safe isolation boundary',
    description: 'Reports only static availability and isolation properties; never returns vault metadata or content.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    routing: {
      aliases: ['monarch safe status', 'статус monarch safe'],
      keywords: ['monarch safe', 'изолированное хранилище'],
      examples: ['Как защищён Monarch Safe?'],
      intentKinds: ['explanation'],
    },
  }],
};
