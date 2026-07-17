import type { MonarchModuleManifest } from '../../core';

export const customToolsManifest: MonarchModuleManifest = {
  id: 'custom-tools',
  name: 'Monarch Tools',
  version: '0.1.0',
  kind: 'domain',
  description: 'Dynamic custom tools engine and auto-creation registry.',
  owns: ['custom tools', 'tools', 'create tool', 'run tool', 'auto create tool', 'инструменты', 'создай инструмент', 'запусти инструмент'],
  permissions: ['read', 'write', 'execute', 'network'],
  capabilities: [
    {
      id: 'custom-tools.list',
      moduleId: 'custom-tools',
      title: 'List custom tools',
      description: 'List all dynamically created custom tools.',
      risk: 'read'
    },
    {
      id: 'custom-tools.create',
      moduleId: 'custom-tools',
      title: 'Create custom tool',
      description: 'Create and register a new custom tool with explicit manifest and script.',
      risk: 'execute',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          risk: { type: 'string', enum: ['none', 'read', 'write', 'execute', 'network'] },
          script: { type: 'string' },
          inputSchema: { type: 'object' }
        },
        required: ['id', 'title', 'description', 'script']
      }
    },
    {
      id: 'custom-tools.auto-create',
      moduleId: 'custom-tools',
      title: 'Auto-create custom tool',
      description: 'Automatically generate and register a new custom tool from natural language prompt.',
      risk: 'execute',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' }
        },
        required: ['prompt']
      }
    },
    {
      id: 'custom-tools.delete',
      moduleId: 'custom-tools',
      title: 'Delete custom tool',
      description: 'Delete a registered custom tool by its id.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      }
    },
    {
      id: 'custom-tools.execute',
      moduleId: 'custom-tools',
      title: 'Execute custom tool',
      description: 'Execute a dynamically registered custom tool with inputs.',
      risk: 'execute',
      inputSchema: {
        type: 'object',
        properties: {
          toolId: { type: 'string' },
          input: { type: 'object' }
        },
        required: ['toolId']
      }
    }
  ]
};
