import type { MonarchModuleManifest } from '../../core';

export const monarchModulesManifest: MonarchModuleManifest = {
  id: 'monarch-modules',
  name: 'Monarch Modules',
  version: '0.1.0',
  stage: 'alpha',
  kind: 'suite',
  description: 'Promoted suite and guided module builder for creating safe Monarch modules quickly.',
  owns: [
    'monarch modules',
    'module builder',
    'module studio',
    'create module',
    'создание модулей',
    'конструктор модулей',
  ],
  permissions: ['read', 'write'],
  events: [
    'monarch-modules.activated',
    'monarch-modules.scaffold.created',
  ],
  capabilities: [
    {
      id: 'monarch-modules.catalog.list',
      moduleId: 'monarch-modules',
      title: 'List Monarch Modules suite',
      description: 'List modules that belong to the promoted Monarch Modules suite.',
      risk: 'read',
      routing: {
        aliases: ['monarch modules', 'open monarch modules', 'покажи monarch modules'],
        keywords: ['monarch modules', 'suite', 'модули', 'набор модулей'],
        examples: ['show Monarch Modules', 'покажи модули из Monarch Modules'],
        intentKinds: ['modules.catalog'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'monarch-modules.templates.list',
      moduleId: 'monarch-modules',
      title: 'List module templates',
      description: 'List beginner-friendly module recipes and their intended use.',
      risk: 'read',
      routing: {
        aliases: ['module templates', 'шаблоны модулей'],
        keywords: ['module', 'template', 'recipe', 'модуль', 'шаблон'],
        examples: ['show module templates', 'покажи шаблоны модулей'],
        intentKinds: ['modules.templates'],
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'monarch-modules.draft.validate',
      moduleId: 'monarch-modules',
      title: 'Validate module draft',
      description: 'Validate a guided module draft without writing files.',
      risk: 'read',
      inputSchema: moduleDraftSchema(),
    },
    {
      id: 'monarch-modules.scaffold.preview',
      moduleId: 'monarch-modules',
      title: 'Preview module scaffold',
      description: 'Generate a file-by-file preview of a safe module scaffold without writing it.',
      risk: 'read',
      routing: {
        aliases: ['preview module', 'предпросмотр модуля'],
        keywords: ['module', 'preview', 'scaffold', 'модуль', 'предпросмотр'],
        examples: ['preview a new Monarch module', 'покажи файлы нового модуля'],
        intentKinds: ['modules.scaffold.preview'],
      },
      inputSchema: moduleDraftSchema(),
    },
    {
      id: 'monarch-modules.scaffold.create',
      moduleId: 'monarch-modules',
      title: 'Create module scaffold',
      description: 'Create a validated module folder without overwriting existing files or editing the catalog.',
      risk: 'write',
      routing: {
        aliases: ['create monarch module', 'создай модуль monarch'],
        keywords: ['module', 'create', 'scaffold', 'модуль', 'создать'],
        examples: ['create a new Monarch module', 'создай новый модуль Monarch'],
        intentKinds: ['modules.scaffold.create'],
      },
      inputSchema: moduleDraftSchema(),
    },
  ],
};

function moduleDraftSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      kind: { type: 'string' },
      template: { type: 'string' },
      standalone: { type: 'boolean' },
      owns: { type: 'array', items: { type: 'string' } },
      permissions: { type: 'array', items: { type: 'string' } },
      dependencies: { type: 'array', items: { type: 'string' } },
      capabilities: { type: 'array', items: { type: 'object' } },
    },
    required: ['id', 'name', 'description'],
    additionalProperties: false,
  };
}
