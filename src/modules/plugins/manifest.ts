import type { MonarchModuleManifest } from '../../core';

export const pluginsManifest: MonarchModuleManifest = {
  id: 'plugins',
  name: 'Monarch Extensions',
  version: '0.1.0',
  kind: 'system',
  description: 'Read-only registry surface for Monarch modules, plugin-like extensions, and capability contracts.',
  owns: ['plugins', 'extensions', 'module packages', 'плагины', 'расширения', 'пакеты модулей'],
  permissions: ['read'],
  events: [
    'plugins.activated',
  ],
  capabilities: [
    {
      id: 'plugins.catalog.list',
      moduleId: 'plugins',
      title: 'List plugin registry',
      description: 'List active Monarch modules as extension surfaces with their capabilities and dependencies.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'plugins.capability.map',
      moduleId: 'plugins',
      title: 'Map plugin capabilities',
      description: 'Return capabilities grouped by module so an agent can decide which extension can serve an intent.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'plugins.contract.describe',
      moduleId: 'plugins',
      title: 'Describe module contract',
      description: 'Describe the minimal contract for adding a new Monarch module package.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
};
