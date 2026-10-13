import type { MonarchModuleManifest } from '../../core';

export const diagnosticsManifest: MonarchModuleManifest = {
  id: 'diagnostics',
  name: 'Monarch Diagnostics',
  version: '0.1.0',
  kind: 'system',
  description: 'Read-only kernel diagnostics for modules, capabilities, events, and audit history.',
  owns: ['diagnostics', 'status', 'kernel', 'modules', 'capabilities', 'events', 'audit'],
  permissions: ['read'],
  events: [
    'diagnostics.activated',
  ],
  capabilities: [
    {
      id: 'diagnostics.system.inspect',
      moduleId: 'diagnostics',
      title: 'Inspect live Monarch system',
      description: 'Adaptively inspect the current Kernel module registry and run safe read-only status probes for the whole system or relevant modules.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          moduleIds: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'diagnostics.project.report',
      moduleId: 'diagnostics',
      title: 'Project diagnostic report',
      description: 'Build a read-only structured project diagnostic report from kernel state and provided source summaries.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          sources: { type: 'object' },
          notes: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'diagnostics.modules.list',
      moduleId: 'diagnostics',
      title: 'List modules',
      description: 'List registered modules and lifecycle status.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'diagnostics.capabilities.list',
      moduleId: 'diagnostics',
      title: 'List capabilities',
      description: 'List registered capabilities, optionally scoped to one module.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          moduleId: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'diagnostics.events.list',
      moduleId: 'diagnostics',
      title: 'List events',
      description: 'List recent kernel and module events.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'diagnostics.audit.list',
      moduleId: 'diagnostics',
      title: 'List audit entries',
      description: 'List recent redacted audit entries.',
      risk: 'read',

      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
  ],
};
