import type { MonarchModuleManifest } from '../../core';

export const customToolsManifest: MonarchModuleManifest = {
  id: 'custom-tools',
  name: 'Monarch Tools',
  version: '0.1.0',
  kind: 'domain',
  description: 'Built-in host tools with fixed risk; saved script tools are kept only as disabled records.',
  owns: ['custom tools', 'tools', 'run tool', 'инструменты', 'запусти инструмент'],
  permissions: ['read', 'write', 'execute', 'network'],
  capabilities: [
    {
      id: 'custom-tools.list',
      moduleId: 'custom-tools',
      title: 'List custom tools',
      description: 'List built-in tools and disabled saved tools.',
      risk: 'read'
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
      description: 'Run a built-in tool with inputs; its risk is fixed by the host.',
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
