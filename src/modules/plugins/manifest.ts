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
      routing: {
        aliases: ['list plugins', 'show plugins', 'plugin registry', 'покажи плагины', 'список расширений'],
        keywords: ['plugins', 'plugin', 'extensions', 'extension', 'packages', 'registry', 'плагины', 'расширения', 'пакеты', 'реестр'],
        examples: ['show plugin registry', 'покажи доступные расширения'],
        intentKinds: ['plugins.read', 'plugin.catalog'],
      },
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
      routing: {
        aliases: ['plugin capabilities', 'extension capabilities', 'карта возможностей плагинов'],
        keywords: ['plugins', 'extensions', 'capabilities', 'actions', 'map', 'плагины', 'расширения', 'возможности', 'карта'],
        examples: ['show capabilities by plugin', 'покажи возможности расширений'],
        intentKinds: ['plugins.read', 'capability.map'],
      },
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
      routing: {
        aliases: ['module contract', 'plugin contract', 'how to add module', 'как добавить модуль', 'контракт плагина'],
        keywords: ['contract', 'manifest', 'module package', 'add module', 'plugin', 'контракт', 'манифест', 'модуль', 'добавить'],
        examples: ['how do I add a Monarch module', 'как добавить новый модуль Monarch'],
        intentKinds: ['plugins.read', 'module.contract'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
};
