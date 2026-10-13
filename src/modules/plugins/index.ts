import type {
  MonarchCapability,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchModuleRecord,
} from '../../core';
import { pluginsManifest } from './manifest';

export class PluginsModule implements MonarchModule {
  readonly manifest = pluginsManifest;

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('plugins.activated', this.manifest.id, {
      surface: 'kernel-context',
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: 'Plugins registry module ready.',
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'plugins.catalog.list':
      return this.listCatalog(context);
    case 'plugins.capability.map':
      return this.mapCapabilities(context);
    case 'plugins.contract.describe':
      return this.describeContract();
    default:
      return {
        ok: false,
        summary: `Unsupported plugins capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private listCatalog(context: MonarchKernelContext): MonarchExecutionResult {
    const modules = context.listModules().map((record) => summarizePlugin(record, context));

    return {
      ok: true,
      summary: `Plugins registry listed ${modules.length} extension surfaces.`,
      output: {
        modules,
      },
    };
  }

  private mapCapabilities(context: MonarchKernelContext): MonarchExecutionResult {
    const modules = context.listModules().map((record) => ({
      moduleId: record.manifest.id,
      name: record.manifest.name,
      kind: record.manifest.kind,
      status: record.status,
      capabilities: context.listCapabilities(record.manifest.id).map(summarizeCapability),
    }));

    return {
      ok: true,
      summary: `Plugins registry mapped capabilities for ${modules.length} modules.`,
      output: {
        modules,
      },
    };
  }

  private describeContract(): MonarchExecutionResult {
    return {
      ok: true,
      summary: 'Monarch module package contract described.',
      output: {
        requiredExports: [
          'manifest: MonarchModuleManifest',
          'factory/create function returning MonarchModule',
          'MonarchModulePackage with id, version, moduleId, factory, and optional core compatibility',
        ],
        manifestFields: [
          'id, name, version, kind, description',
          'kind suite for promoted product-level module groups',
          'parentSuiteId for suite membership; the parent suite must also be a dependency',
          'owns: semantic domain labels for catalog discovery, never activation phrases',
          'permissions: declared risks the module is allowed to expose',
          'capabilities: typed actions with risk and schemas; no keyword or phrase activators',
          'dependencies and events when needed',
        ],
        lifecycle: [
          'activate(context)',
          'optional deactivate(context)',
          'optional health(context)',
          'executeCapability(request, context) for executable capabilities',
        ],
        rules: [
          'Every risky action must be a capability.',
          'The module owns domain logic; the kernel owns routing, permissions, execution, and audit.',
          'Write, execute, network, device-control, identity, and delete risks require confirmation by default.',
          'Add focused smoke coverage for catalog exposure, permission behavior, and execution.',
        ],
        docs: [
          'docs/03_MODULE_CONTRACT.md',
          'docs/07_ADDING_MODULE.md',
        ],
      },
    };
  }
}

function summarizePlugin(
  record: MonarchModuleRecord,
  context: MonarchKernelContext
): Record<string, unknown> {
  const capabilities = context.listCapabilities(record.manifest.id);
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    version: record.manifest.version,
    kind: record.manifest.kind,
    status: record.status,
    description: record.manifest.description,
    owns: record.manifest.owns,
    permissions: record.manifest.permissions,
    dependencies: record.manifest.dependencies || [],
    parentSuiteId: record.manifest.parentSuiteId,
    events: record.manifest.events || [],
    capabilities: capabilities.map(summarizeCapability),
  };
}

function summarizeCapability(capability: MonarchCapability): Record<string, unknown> {
  return {
    id: capability.id,
    title: capability.title,
    risk: capability.risk,
    description: capability.description,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    agent: capability.agent,
  };
}

export function createPluginsModule(): MonarchModule {
  return new PluginsModule();
}

export const pluginsModulePackage: MonarchModulePackage = {
  id: pluginsManifest.id,
  moduleId: pluginsManifest.id,
  version: pluginsManifest.version,
  description: pluginsManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createPluginsModule,
};
