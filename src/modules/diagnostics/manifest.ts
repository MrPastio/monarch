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
      routing: {
        aliases: ['inspect Monarch system', 'full system check', 'system self check', 'проверь всю систему', 'самопроверка Monarch'],
        keywords: ['diagnostics', 'system', 'inspect', 'health', 'modules', 'self-check', 'диагностика', 'система', 'проверка', 'модули', 'самопроверка'],
        examples: [
          'inspect the whole Monarch system',
          'Oscar, проверь всю систему Monarch',
        ],
        intentKinds: ['diagnostics.read', 'system.inspect', 'kernel.health'],
      },
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
      routing: {
        aliases: ['project diagnostics', 'diagnose project', 'self check project', 'диагностика проекта', 'проверь проект'],
        keywords: ['diagnostics', 'project', 'anomalies', 'tests', 'diff', 'logs', 'runtime', 'diagnostic', 'диагностика', 'проект', 'аномалии', 'тесты', 'дифф', 'логи'],
        examples: [
          'run project diagnostics',
          'diagnose Monarch project state',
          'проведи диагностику проекта',
        ],
        intentKinds: ['diagnostics.read', 'project.diagnostics'],
      },
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
      routing: {
        aliases: ['list modules', 'module status', 'kernel status', 'system status', 'show status', 'покажи модули', 'статус ядра'],
        keywords: ['diagnostics', 'status', 'system', 'health', 'kernel', 'module', 'modules', 'диагностика', 'статус', 'система', 'системы', 'ядро', 'ядра', 'модуль', 'модули'],
        examples: [
          'show kernel modules',
          'list modules',
          'show status',
        ],
        intentKinds: ['diagnostics.read', 'kernel.status', 'module.list'],
      },
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
      routing: {
        aliases: ['list capabilities', 'show capabilities', 'available actions', 'what can you do', 'покажи возможности', 'что ты умеешь', 'какими инструментами ты можешь пользоваться'],
        keywords: ['diagnostics', 'capabilities', 'capability', 'tools', 'actions', 'commands', 'диагностика', 'возможности', 'инструменты', 'умеешь', 'команды', 'действия'],
        examples: [
          'show capabilities',
          'what actions are available',
        ],
        intentKinds: ['diagnostics.read', 'capability.list'],
      },
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
      routing: {
        aliases: ['list events', 'show events', 'event history', 'покажи события'],
        keywords: ['diagnostics', 'events', 'event', 'history', 'kernel', 'module', 'диагностика', 'события', 'событие', 'история'],
        examples: [
          'show recent events',
          'list kernel event history',
        ],
        intentKinds: ['diagnostics.read', 'event.list'],
      },
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
      routing: {
        aliases: ['list audit', 'show audit', 'audit history', 'show logs', 'покажи аудит', 'покажи логи'],
        keywords: ['diagnostics', 'audit', 'logs', 'log', 'history', 'redacted', 'диагностика', 'аудит', 'логи', 'лог', 'история'],
        examples: [
          'show audit history',
          'list recent logs',
        ],
        intentKinds: ['diagnostics.read', 'audit.list'],
      },
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
