import {
  MonarchKernel,
  MonarchModuleLoader,
  normalizeId,
  type MonarchModule,
  type MonarchModuleLoadRecord,
  type MonarchModulePackage,
  type MonarchPermissionProfile,
} from './core';
import { builtInModulePackages } from './modules';
import { createLocalSystemRouter } from './modules/models/system-router';

export interface MonarchBootstrapOptions {
  workspaceRoot?: string;
  packages?: readonly MonarchModulePackage[];
  enabledModules?: readonly string[];
  disabledModules?: readonly string[];
  enableLocalSystemRouter?: boolean;
  permissionProfile?: MonarchPermissionProfile;
}

export interface MonarchRuntime {
  kernel: MonarchKernel;
  modules: MonarchModule[];
  packages: MonarchModulePackage[];
  loadRecords: MonarchModuleLoadRecord[];
}

export function createMonarchKernel(options: MonarchBootstrapOptions = {}): MonarchKernel {
  return createMonarchRuntime(options).kernel;
}

export function createMonarchRuntime(options: MonarchBootstrapOptions = {}): MonarchRuntime {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const kernel = options.enableLocalSystemRouter === false
    ? new MonarchKernel({ workspaceRoot, ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}) })
    : new MonarchKernel({
      workspaceRoot,
      llmRouter: createLocalSystemRouter({ workspaceRoot }),
      ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
    });
  const loader = new MonarchModuleLoader({ workspaceRoot });
  const packages = selectModulePackages(options.packages || builtInModulePackages, options);

  for (const modulePackage of packages) {
    loader.registerPackage(modulePackage);
  }

  const modules = loader.loadInto(kernel);
  return {
    kernel,
    modules,
    packages: loader.listPackages(),
    loadRecords: loader.getLoadRecords(),
  };
}

function selectModulePackages(
  packages: readonly MonarchModulePackage[],
  options: MonarchBootstrapOptions
): MonarchModulePackage[] {
  const enabled = normalizeSelection(options.enabledModules);
  const disabled = normalizeSelection(options.disabledModules);
  const hasExplicitEnabledList = enabled.size > 0;

  return packages.map((modulePackage) => {
    const ids = packageSelectionIds(modulePackage);
    const selected = !hasExplicitEnabledList || ids.some((id) => enabled.has(id));
    const disabledBySelection = ids.some((id) => disabled.has(id));
    const enabledBySelection = selected && !disabledBySelection && modulePackage.enabled !== false;

    return {
      ...modulePackage,
      enabled: enabledBySelection,
    };
  });
}

function normalizeSelection(values: readonly string[] | undefined): Set<string> {
  return new Set((values || []).map(normalizeId).filter(Boolean));
}

function packageSelectionIds(modulePackage: MonarchModulePackage): string[] {
  return [
    normalizeId(modulePackage.id),
    normalizeId(modulePackage.moduleId || ''),
  ].filter(Boolean);
}
