import {
  MONARCH_CORE_API_VERSION,
  type MonarchCapability,
  type MonarchModuleRecord,
} from '../core';
import type { MonarchRuntime } from '../bootstrap';

export interface MonarchAgentSystemProfile {
  id: string;
  name: string;
  role: string;
  version: string;
  generatedAt: string;
  workspaceRoot: string;
  purpose: string;
  operatingPrinciples: string[];
  safetyBoundaries: string[];
  accessProfile: ReturnType<MonarchRuntime['kernel']['getPermissionProfile']>;
  runtimeContract: {
    coreApiVersion: string;
    modules: Array<{
      id: string;
      name: string;
      kind: string;
      status: string;
      owns: string[];
      permissions: string[];
      capabilities: number;
    }>;
    capabilities: Array<{
      id: string;
      moduleId: string;
      title: string;
      risk: string;
      description?: string;
    }>;
  };
}

export function createAgentSystemProfile(
  runtime: MonarchRuntime,
  workspaceRoot: string
): MonarchAgentSystemProfile {
  const snapshot = runtime.kernel.getSnapshot();

  return {
    id: 'monarch.system.profile',
    name: 'Monarch Kernel',
    role: 'local AI agent operating system, permission boundary, and capability router',
    version: MONARCH_CORE_API_VERSION,
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    purpose: 'Route agent intent into typed local capabilities, enforce permissions, coordinate modules, expose plugin contracts, and keep execution observable.',
    operatingPrinciples: [
      'The agent speaks in intents; Monarch routes intents into modules and capabilities.',
      'Domain logic lives inside modules. The kernel owns lifecycle, routing, permissions, planning, execution, events, and audit.',
      'Every real action must pass through a declared capability with a risk level and schema.',
      'Modules are plugin-like extension surfaces and must describe themselves through manifests.',
      'Local-first behavior is the default; network and external providers must be explicit capabilities.',
    ],
    safetyBoundaries: [
      'Do not bypass the permission gate.',
      'Do not execute raw generated code as the main control path.',
      'Do not store secrets in tracked files or unredacted audit payloads.',
      'Apply the active Monarch Access sandbox mode and approval policy before every real action.',
      'Treat money and security-sensitive actions as denied unless policy is explicitly changed.',
    ],
    accessProfile: runtime.kernel.getPermissionProfile(),
    runtimeContract: {
      coreApiVersion: MONARCH_CORE_API_VERSION,
      modules: snapshot.modules.map(summarizeModule),
      capabilities: snapshot.capabilities.map(summarizeCapability),
    },
  };
}

function summarizeModule(record: MonarchModuleRecord): MonarchAgentSystemProfile['runtimeContract']['modules'][number] {
  return {
    id: record.manifest.id,
    name: record.manifest.name,
    kind: record.manifest.kind,
    status: record.status,
    owns: record.manifest.owns,
    permissions: record.manifest.permissions,
    capabilities: record.manifest.capabilities.length,
  };
}

function summarizeCapability(
  capability: MonarchCapability
): MonarchAgentSystemProfile['runtimeContract']['capabilities'][number] {
  const summary: MonarchAgentSystemProfile['runtimeContract']['capabilities'][number] = {
    id: capability.id,
    moduleId: capability.moduleId,
    title: capability.title,
    risk: capability.risk,
  };

  if (capability.description) {
    summary.description = capability.description;
  }

  return summary;
}
