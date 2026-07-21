import type { MonarchModuleKind, MonarchRisk } from '../../core';

export type ModuleTemplateId = 'empty' | 'reader' | 'workspace-tool';

export interface ModuleCapabilityDraft {
  id: string;
  title: string;
  description?: string;
  risk: MonarchRisk;
}

export interface ModuleDraft {
  id: string;
  name: string;
  description: string;
  kind: MonarchModuleKind;
  template: ModuleTemplateId;
  standalone: boolean;
  owns: string[];
  permissions: MonarchRisk[];
  dependencies: string[];
  capabilities: ModuleCapabilityDraft[];
}

export interface ModuleDraftValidation {
  ok: boolean;
  draft: ModuleDraft;
  errors: string[];
  warnings: string[];
}

export interface ModuleScaffoldFile {
  path: string;
  content: string;
}

const MODULE_KINDS: MonarchModuleKind[] = [
  'suite',
  'system',
  'interface',
  'domain',
  'runtime',
  'tooling',
];
const RISKS: MonarchRisk[] = [
  'none',
  'read',
  'write',
  'delete',
  'execute',
  'network',
  'device-control',
  'money',
  'identity',
  'security-sensitive',
];
const TEMPLATES: ModuleTemplateId[] = ['empty', 'reader', 'workspace-tool'];

export const MODULE_TEMPLATES = [
  {
    id: 'empty' as const,
    title: 'Empty module',
    description: 'Minimal lifecycle and health check. Best for a custom contract.',
    defaultKind: 'domain' as const,
    defaultRisks: [] as MonarchRisk[],
  },
  {
    id: 'reader' as const,
    title: 'Read-only module',
    description: 'One typed read capability with safe default permission behavior.',
    defaultKind: 'domain' as const,
    defaultRisks: ['read'] as MonarchRisk[],
  },
  {
    id: 'workspace-tool' as const,
    title: 'Workspace tool',
    description: 'Read and write capability pair for workspace-scoped operations.',
    defaultKind: 'tooling' as const,
    defaultRisks: ['read', 'write'] as MonarchRisk[],
  },
];

export function validateModuleDraft(input: unknown): ModuleDraftValidation {
  const source = isRecord(input) ? input : {};
  const id = readString(source.id).toLowerCase();
  const requestedTemplate = readString(source.template);
  const template = normalizeTemplate(requestedTemplate);
  const templateDefaults = MODULE_TEMPLATES.find((item) => item.id === template) || MODULE_TEMPLATES[0]!;
  const requestedKind = readString(source.kind);
  const kind = normalizeKind(requestedKind, templateDefaults.defaultKind);
  const standalone = source.standalone === true;
  const owns = readStringArray(source.owns);
  const dependencies = unique(readStringArray(source.dependencies).map((value) => value.toLowerCase()));
  if (!standalone && id !== 'monarch-modules' && !dependencies.includes('monarch-modules')) {
    dependencies.unshift('monarch-modules');
  }

  const capabilityInputs = Array.isArray(source.capabilities) ? source.capabilities : [];
  const explicitCapabilities = capabilityInputs.length > 0
    ? capabilityInputs.map(normalizeCapability).filter((item): item is ModuleCapabilityDraft => Boolean(item))
    : [];
  const capabilities = explicitCapabilities.length > 0
    ? explicitCapabilities
    : defaultCapabilities(id, template);
  const permissions = unique([
    ...readRisks(source.permissions),
    ...templateDefaults.defaultRisks,
    ...capabilities.map((capability) => capability.risk),
  ]);

  const draft: ModuleDraft = {
    id,
    name: readString(source.name),
    description: readString(source.description),
    kind,
    template,
    standalone,
    owns: owns.length > 0 ? owns : [id],
    permissions,
    dependencies,
    capabilities,
  };
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    errors.push('id must be lowercase kebab-case and start with a letter');
  }
  if (draft.name.length < 2 || draft.name.length > 80) {
    errors.push('name must contain 2-80 characters');
  }
  if (draft.description.length < 12 || draft.description.length > 240) {
    errors.push('description must contain 12-240 characters');
  }
  if (requestedKind && !MODULE_KINDS.includes(requestedKind as MonarchModuleKind)) {
    errors.push(`unsupported module kind: ${requestedKind}`);
  }
  if (requestedTemplate && !TEMPLATES.includes(requestedTemplate as ModuleTemplateId)) {
    errors.push(`unsupported module template: ${requestedTemplate}`);
  }
  if (capabilityInputs.length !== explicitCapabilities.length) {
    errors.push('every capability requires a valid id, title, and supported risk');
  }
  const capabilityIds = draft.capabilities.map((capability) => capability.id);
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    errors.push('capability ids must be unique');
  }
  const requestedPermissions = readStringArray(source.permissions);
  const unsupportedPermissions = requestedPermissions.filter((item) => !RISKS.includes(item as MonarchRisk));
  if (unsupportedPermissions.length > 0) {
    errors.push(`unsupported permission risks: ${unsupportedPermissions.join(', ')}`);
  }
  for (const capability of draft.capabilities) {
    if (!capability.id.startsWith(`${id}.`)) {
      errors.push(`capability ${capability.id} must start with ${id}.`);
    }
    if (!capability.title) {
      errors.push(`capability ${capability.id} requires a title`);
    }
    if (!RISKS.includes(capability.risk)) {
      errors.push(`capability ${capability.id} has unsupported risk ${String(capability.risk)}`);
    }
  }
  if (draft.kind === 'suite' && !standalone) {
    errors.push('a suite module must be standalone');
  }
  if (draft.permissions.some((risk) => risk !== 'none' && risk !== 'read')) {
    warnings.push('write or sensitive capabilities will require the normal Monarch permission gate');
  }
  if (!standalone) {
    warnings.push('the generated module will belong to the Monarch Modules suite');
  }

  return { ok: errors.length === 0, draft, errors: unique(errors), warnings: unique(warnings) };
}

export function buildModuleScaffold(draft: ModuleDraft): ModuleScaffoldFile[] {
  const variable = toCamelCase(draft.id);
  const className = `${toPascalCase(draft.id)}Module`;
  const parentSuite = draft.standalone ? '' : "  parentSuiteId: 'monarch-modules',\n";
  const capabilityEntries = draft.capabilities.map((capability) => `    {
      id: '${escapeTs(capability.id)}',
      moduleId: '${escapeTs(draft.id)}',
      title: '${escapeTs(capability.title)}',
      description: '${escapeTs(capability.description || capability.title)}',
      risk: '${capability.risk}',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    }`).join(',\n');
  const cases = draft.capabilities.map((capability) => `    case '${escapeTs(capability.id)}':
      return {
        ok: true,
        summary: '${escapeTs(capability.title)} is ready for implementation.',
        output: {},
      };`).join('\n');

  const manifest = `import type { MonarchModuleManifest } from '../../core';

export const ${variable}Manifest: MonarchModuleManifest = {
  id: '${escapeTs(draft.id)}',
  name: '${escapeTs(draft.name)}',
  version: '0.1.0',
  kind: '${draft.kind}',
${parentSuite}  description: '${escapeTs(draft.description)}',
  owns: ${JSON.stringify(draft.owns)},
  permissions: ${JSON.stringify(draft.permissions)},
  dependencies: ${JSON.stringify(draft.dependencies)},
  events: ['${escapeTs(draft.id)}.activated'],
  capabilities: [
${capabilityEntries}
  ],
};
`;
  const index = `import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
} from '../../core';
import { ${variable}Manifest } from './manifest';

export class ${className} implements MonarchModule {
  readonly manifest = ${variable}Manifest;

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('${escapeTs(draft.id)}.activated', this.manifest.id);
  }

  async health(): Promise<MonarchExecutionResult> {
    return { ok: true, summary: '${escapeTs(draft.name)} is ready.' };
  }

  async executeCapability(
    request: MonarchExecutionRequest
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
${cases}
    default:
      return {
        ok: false,
        summary: \`Unsupported ${escapeTs(draft.id)} capability: \${request.capabilityId}\`,
        error: 'unsupported-capability',
      };
    }
  }
}

export function create${toPascalCase(draft.id)}Module(): MonarchModule {
  return new ${className}();
}

export const ${variable}ModulePackage: MonarchModulePackage = {
  id: ${variable}Manifest.id,
  moduleId: ${variable}Manifest.id,
  version: ${variable}Manifest.version,
  description: ${variable}Manifest.description,
  core: { minVersion: '0.1.0' },
  factory: create${toPascalCase(draft.id)}Module,
};
`;
  const test = `import { describe, expect, it } from 'vitest';
import { ${className} } from './index';

describe('${escapeTs(draft.name)}', () => {
  it('exposes a valid manifest', () => {
    const module = new ${className}();
    expect(module.manifest.id).toBe('${escapeTs(draft.id)}');
    expect(module.manifest.capabilities).toHaveLength(${draft.capabilities.length});
  });
});
`;
  const readme = `# ${draft.name}

${draft.description}

- Kind: \`${draft.kind}\`
- Template: \`${draft.template}\`
- Suite: ${draft.standalone ? 'standalone' : '`monarch-modules`'}
- Permissions: ${draft.permissions.length > 0 ? draft.permissions.map((item) => `\`${item}\``).join(', ') : 'none'}

The scaffold is intentionally not added to \`src/modules/catalog.ts\` automatically. Review the generated contract and tests first, then register its package explicitly.
`;

  return [
    { path: 'manifest.ts', content: manifest },
    { path: 'index.ts', content: index },
    { path: `${draft.id}.test.ts`, content: test },
    { path: 'README.md', content: readme },
  ];
}

function defaultCapabilities(id: string, template: ModuleTemplateId): ModuleCapabilityDraft[] {
  if (!id || template === 'empty') {
    return [];
  }
  if (template === 'workspace-tool') {
    return [
      { id: `${id}.inspect`, title: 'Inspect workspace state', risk: 'read' },
      { id: `${id}.apply`, title: 'Apply workspace change', risk: 'write' },
    ];
  }
  return [{ id: `${id}.read`, title: `Read ${id} state`, risk: 'read' }];
}

function normalizeCapability(value: unknown): ModuleCapabilityDraft | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id).toLowerCase();
  const title = readString(value.title);
  const risk = readString(value.risk) as MonarchRisk;
  if (!id || !title || !RISKS.includes(risk)) {
    return null;
  }
  return {
    id,
    title,
    description: readString(value.description),
    risk,
  };
}

function normalizeKind(value: string, fallback: MonarchModuleKind): MonarchModuleKind {
  return MODULE_KINDS.includes(value as MonarchModuleKind)
    ? value as MonarchModuleKind
    : fallback;
}

function normalizeTemplate(value: string): ModuleTemplateId {
  return TEMPLATES.includes(value as ModuleTemplateId)
    ? value as ModuleTemplateId
    : 'empty';
}

function readRisks(value: unknown): MonarchRisk[] {
  return readStringArray(value).filter((item): item is MonarchRisk => RISKS.includes(item as MonarchRisk));
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.map(readString).filter(Boolean))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function toCamelCase(value: string): string {
  const pascal = toPascalCase(value);
  return pascal ? `${pascal[0]?.toLowerCase()}${pascal.slice(1)}` : 'module';
}

function toPascalCase(value: string): string {
  return value.split(/[^a-z0-9]+/i).filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join('');
}

function escapeTs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}
