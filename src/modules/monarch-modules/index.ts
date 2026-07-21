import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { evaluateFilesystemAccess } from '../../core';
import { monarchModulesManifest } from './manifest';
import { buildModuleScaffold, MODULE_TEMPLATES, validateModuleDraft } from './scaffold';

export interface MonarchModulesOptions {
  workspaceRoot?: string;
  modulesRoot?: string;
}

export class MonarchModulesModule implements MonarchModule {
  readonly manifest = monarchModulesManifest;
  private readonly workspaceRoot: string;
  private readonly modulesRoot: string;

  constructor(options: MonarchModulesOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.modulesRoot = path.resolve(options.modulesRoot || path.join(this.workspaceRoot, 'src', 'modules'));
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('monarch-modules.activated', this.manifest.id, {
      modulesRoot: this.modulesRoot,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: 'Monarch Modules suite and guided builder are ready.',
      output: {
        modulesRoot: this.modulesRoot,
        templates: MODULE_TEMPLATES.map((template) => template.id),
      },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.toLowerCase();
    if (!/(monarch modules|module builder|create module|new module|созда(?:й|ть) модул|конструктор модул)/i.test(text)) {
      return null;
    }

    if (/(template|recipe|шаблон)/i.test(text)) {
      return readRoute(intent, 'monarch-modules.templates.list', 'User asks for module builder templates.');
    }
    if (/(create|new|созда(?:й|ть)|нов(?:ый|ого))/i.test(text)) {
      return readRoute(
        intent,
        'monarch-modules.scaffold.preview',
        'A module creation request starts with a safe scaffold preview.'
      );
    }
    return readRoute(intent, 'monarch-modules.catalog.list', 'User asks for the Monarch Modules suite.');
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'monarch-modules.catalog.list':
      return this.listSuite(context);
    case 'monarch-modules.templates.list':
      return this.listTemplates();
    case 'monarch-modules.draft.validate':
      return this.validateDraft(request.input);
    case 'monarch-modules.scaffold.preview':
      return this.previewScaffold(request.input);
    case 'monarch-modules.scaffold.create':
      return this.createScaffold(request.input, context);
    default:
      return {
        ok: false,
        summary: `Unsupported Monarch Modules capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private listSuite(context: MonarchKernelContext): MonarchExecutionResult {
    const modules = context.listModules()
      .filter((record) => record.manifest.parentSuiteId === this.manifest.id)
      .map((record) => ({
        id: record.manifest.id,
        name: record.manifest.name,
        description: record.manifest.description,
        kind: record.manifest.kind,
        stage: record.manifest.stage ?? null,
        status: record.status,
        capabilities: record.manifest.capabilities.length,
      }));
    return {
      ok: true,
      summary: `Monarch Modules contains ${modules.length} member modules.`,
      output: { suite: this.manifest.id, modules },
    };
  }

  private listTemplates(): MonarchExecutionResult {
    return {
      ok: true,
      summary: `Listed ${MODULE_TEMPLATES.length} guided module templates.`,
      output: { templates: MODULE_TEMPLATES },
    };
  }

  private validateDraft(input: unknown): MonarchExecutionResult {
    const validation = validateModuleDraft(input);
    return validation.ok
      ? {
        ok: true,
        summary: `Module draft ${validation.draft.id} is valid.`,
        output: validation,
      }
      : {
        ok: false,
        summary: `Module draft has ${validation.errors.length} validation errors.`,
        output: validation,
        error: 'invalid-module-draft',
      };
  }

  private previewScaffold(input: unknown): MonarchExecutionResult {
    const validation = validateModuleDraft(input);
    if (!validation.ok) {
      return this.validateDraft(input);
    }
    const files = buildModuleScaffold(validation.draft);
    return {
      ok: true,
      summary: `Previewed ${files.length} files for ${validation.draft.id}.`,
      output: {
        draft: validation.draft,
        warnings: validation.warnings,
        target: path.join(this.modulesRoot, validation.draft.id),
        files,
        catalogRegistration: catalogRegistrationFor(validation.draft.id),
      },
    };
  }

  private async createScaffold(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const validation = validateModuleDraft(input);
    if (!validation.ok) {
      return this.validateDraft(input);
    }

    const target = path.join(this.modulesRoot, validation.draft.id);
    const evaluation = evaluateFilesystemAccess(target, 'create', {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.modulesRoot,
    });
    if (!evaluation.allowed) {
      return {
        ok: false,
        summary: evaluation.message,
        error: 'filesystem-policy-blocked',
        metadata: { evaluation },
      };
    }
    if (await stat(target).then(() => true).catch(() => false)) {
      return {
        ok: false,
        summary: `Module folder already exists: ${target}`,
        error: 'module-folder-exists',
      };
    }

    const temporary = path.join(this.modulesRoot, `.${validation.draft.id}.tmp-${randomUUID()}`);
    const files = buildModuleScaffold(validation.draft);
    try {
      await mkdir(this.modulesRoot, { recursive: true });
      await mkdir(temporary, { recursive: false });
      for (const file of files) {
        await writeFile(path.join(temporary, file.path), file.content, { encoding: 'utf8', flag: 'wx' });
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      return {
        ok: false,
        summary: `Module scaffold could not be created: ${error instanceof Error ? error.message : String(error)}`,
        error: 'module-scaffold-write-failed',
      };
    }

    await context.emit('monarch-modules.scaffold.created', this.manifest.id, {
      moduleId: validation.draft.id,
      target,
      files: files.map((file) => file.path),
    });
    return {
      ok: true,
      summary: `Created module scaffold ${validation.draft.id} without modifying the catalog.`,
      output: {
        target,
        files: files.map((file) => path.join(target, file.path)),
        warnings: validation.warnings,
        catalogRegistration: catalogRegistrationFor(validation.draft.id),
      },
    };
  }
}

function readRoute(
  intent: MonarchIntent,
  capabilityId: string,
  reason: string
): MonarchRouteDecision {
  return {
    intentId: intent.id,
    targetModuleId: 'monarch-modules',
    capabilityId,
    confidence: 0.9,
    reason,
    permissionMode: 'allow',
    input: {},
  };
}

function catalogRegistrationFor(moduleId: string): Record<string, string> {
  const variable = `${toCamelCase(moduleId)}ModulePackage`;
  return {
    import: `import { ${variable} } from './${moduleId}';`,
    entry: `${variable},`,
  };
}

function toCamelCase(value: string): string {
  const parts = value.split('-');
  return parts.map((part, index) => index === 0
    ? part
    : `${part[0]?.toUpperCase()}${part.slice(1)}`).join('');
}

export function createMonarchModulesModule(
  options: MonarchModulesOptions = {}
): MonarchModule {
  return new MonarchModulesModule(options);
}

export const monarchModulesModulePackage: MonarchModulePackage = {
  id: monarchModulesManifest.id,
  moduleId: monarchModulesManifest.id,
  version: monarchModulesManifest.version,
  description: monarchModulesManifest.description,
  core: { minVersion: '0.1.0' },
  factory: createMonarchModulesModule,
};
