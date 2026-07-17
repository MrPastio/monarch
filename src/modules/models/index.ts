import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import {
  createRouterPipeline,
  type MonarchModelRole,
  readModelCatalog,
} from './model-catalog';
import { modelsManifest } from './manifest';
import { createModelRuntimeReport } from './runtime-adapters';
import {
  completeWithModelRole,
  startModelRuntime,
  stopModelRuntime,
  selectModelForInputAsync,
} from './runtime-client';

export class ModelsModule implements MonarchModule {
  readonly manifest = modelsManifest;

  async activate(context: MonarchKernelContext): Promise<void> {
    const catalog = await readModelCatalog(process.cwd());
    await context.emit('models.activated', this.manifest.id, {
      root: catalog.root,
      models: catalog.models.length,
      available: catalog.models.filter((model) => model.status === 'available').length,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    const catalog = await readModelCatalog(process.cwd());
    const runtimeReport = createModelRuntimeReport(catalog);
    const available = catalog.models.filter((model) => model.status === 'available').length;
    const runnable = runtimeReport.entries.filter((entry) => entry.canInfer).length;
    return {
      ok: true,
      summary: catalog.exists
        ? `Model catalog ready: ${available}/${catalog.models.length} model groups available, ${runnable} runners configured.`
        : 'Model catalog folder is not present yet.',
      output: {
        root: catalog.root,
        exists: catalog.exists,
        available,
        runnable,
        total: catalog.models.length,
      },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.toLowerCase();
    if (!mentionsModels(text)) {
      return null;
    }

    if (/(start|launch).{0,24}(model|runtime|runner)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'models.runtime.start',
        confidence: 0.82,
        reason: 'User asks to start a local model runtime.',
        permissionMode: 'confirm',
        input: { role: inferRoleFromText(text) || 'weak' },
      };
    }

    if (/(stop|shutdown).{0,24}(model|runtime|runner)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'models.runtime.stop',
        confidence: 0.82,
        reason: 'User asks to stop a local model runtime.',
        permissionMode: 'confirm',
        input: { role: inferRoleFromText(text) || 'weak' },
      };
    }

    if (/(complete|infer|inference|generate|run).{0,28}(model|llm)|run local model/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'models.chat.complete',
        confidence: 0.8,
        reason: 'User asks to run local model inference.',
        permissionMode: 'confirm',
        input: {
          text: extractCompletionText(intent.text),
          role: inferRoleFromText(text) || 'weak',
        },
      };
    }

    if (/(pipeline|пайплайн|router|роутер|маршрут)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'models.router.pipeline',
        confidence: 0.82,
        reason: 'User asks to inspect the model router pipeline.',
        permissionMode: 'allow',
        input: { text: intent.text },
      };
    }

    if (/(select|choose|выбери|какую)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'models.chat.select',
        confidence: 0.8,
        reason: 'User asks to select a model for input.',
        permissionMode: 'allow',
        input: { text: intent.text },
      };
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'models.catalog.list',
      confidence: 0.78,
      reason: 'User asks to inspect local model catalog.',
      permissionMode: 'allow',
      input: {},
    };
  }

  async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'models.catalog.list':
      return this.listCatalog();
    case 'models.runtime.status':
      return this.runtimeStatus();
    case 'models.chat.select':
      return this.selectChatModel(request.input);
    case 'models.router.pipeline':
      return this.describeRouterPipeline(request.input);
    case 'models.chat.complete':
      return this.completeChat(request.input);
    case 'models.runtime.start':
      return this.startRuntime(request.input);
    case 'models.runtime.stop':
      return this.stopRuntime(request.input);
    default:
      return {
        ok: false,
        summary: `Unsupported models capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async listCatalog(): Promise<MonarchExecutionResult> {
    const catalog = await readModelCatalog(process.cwd());
    return {
      ok: true,
      summary: `Models catalog listed ${catalog.models.length} model groups.`,
      output: { catalog },
    };
  }

  private async runtimeStatus(): Promise<MonarchExecutionResult> {
    const catalog = await readModelCatalog(process.cwd());
    const runtimeReport = createModelRuntimeReport(catalog);
    const runnable = runtimeReport.entries.filter((entry) => entry.canInfer).length;
    return {
      ok: true,
      summary: `Model runtime status: ${runnable}/${runtimeReport.entries.length} runners configured.`,
      output: { runtimeReport },
    };
  }

  private async selectChatModel(input: unknown): Promise<MonarchExecutionResult> {
    const text = readStringInput(input, 'text');
    const catalog = await readModelCatalog(process.cwd());
    const selectedModel = await selectModelForInputAsync(text, catalog);

    let loadDetail = 'No automatic loading was triggered.';
    let loadOk = true;
    if (selectedModel.available) {
      try {
        const startResult = await startModelRuntime(catalog, selectedModel.role, process.env, 3000);
        loadDetail = startResult.detail;
        loadOk = startResult.ok;
      } catch (err) {
        loadDetail = `Automatic loading failed: ${err instanceof Error ? err.message : String(err)}`;
        loadOk = false;
      }
    }

    return {
      ok: true,
      summary: `${selectedModel.label} selected: ${selectedModel.reason}. Loader status: ${loadDetail}`,
      output: {
        selectedModel,
        loader: {
          ok: loadOk,
          detail: loadDetail
        }
      },
    };
  }

  private async describeRouterPipeline(input: unknown): Promise<MonarchExecutionResult> {
    const text = readStringInput(input, 'text');
    const catalog = await readModelCatalog(process.cwd());
    const runtimeReport = createModelRuntimeReport(catalog);
    const pipeline = createRouterPipeline(text, catalog, runtimeReport);
    return {
      ok: true,
      summary: `Router pipeline has ${pipeline.length} stages.`,
      output: { pipeline },
    };
  }

  private async completeChat(input: unknown): Promise<MonarchExecutionResult> {
    const text = readStringInput(input, 'text');
    if (!text) {
      return {
        ok: false,
        summary: 'Completion text is empty.',
        error: 'empty-completion-input',
      };
    }

    const catalog = await readModelCatalog(process.cwd());
    const requestedRole = readModelRole(input, 'role') || (await selectModelForInputAsync(text, catalog)).role;
    const system = readStringInput(input, 'system');
    const messages = [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      { role: 'user' as const, content: text },
    ];
    const completionRequest = {
      role: requestedRole,
      messages,
    } as Parameters<typeof completeWithModelRole>[1];
    const temperature = readOptionalNumberInput(input, 'temperature');
    const maxTokens = readOptionalNumberInput(input, 'maxTokens');
    const responseFormat = readResponseFormat(input);
    const timeoutMs = readOptionalNumberInput(input, 'timeoutMs');
    if (temperature !== undefined) {
      completionRequest.temperature = temperature;
    }
    if (maxTokens !== undefined) {
      completionRequest.maxTokens = maxTokens;
    }
    if (responseFormat !== undefined) {
      completionRequest.responseFormat = responseFormat;
    }
    if (timeoutMs !== undefined) {
      completionRequest.timeoutMs = timeoutMs;
    }

    const result = await completeWithModelRole(catalog, completionRequest);

    if (!result.ok) {
      return {
        ok: false,
        summary: `Local model completion failed: ${result.error || 'unknown error'}`,
        output: result,
        error: 'model-completion-failed',
      };
    }

    return {
      ok: true,
      summary: `Local model ${result.role} completed through ${result.adapter}.`,
      output: result,
    };
  }

  private async startRuntime(input: unknown): Promise<MonarchExecutionResult> {
    const role = readModelRole(input, 'role');
    if (!role) {
      return {
        ok: false,
        summary: 'Model role is required.',
        error: 'missing-model-role',
      };
    }

    const catalog = await readModelCatalog(process.cwd());
    const result = await startModelRuntime(
      catalog,
      role,
      process.env,
      readOptionalNumberInput(input, 'timeoutMs') || 5000
    );

    if (!result.ok) {
      return {
        ok: false,
        summary: result.detail,
        output: result,
        error: 'model-runtime-start-failed',
      };
    }

    return {
      ok: true,
      summary: result.detail,
      output: result,
    };
  }

  private stopRuntime(input: unknown): MonarchExecutionResult {
    const role = readModelRole(input, 'role');
    if (!role) {
      return {
        ok: false,
        summary: 'Model role is required.',
        error: 'missing-model-role',
      };
    }

    const result = stopModelRuntime(role);
    return {
      ok: result.ok,
      summary: result.detail,
      output: result,
    };
  }
}

function mentionsModels(text: string): boolean {
  return /(model|models|llm|gemma|router model|systemrouter|модел|роутер|изображ)/i.test(text);
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalNumberInput(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readModelRole(input: unknown, key: string): MonarchModelRole | undefined {
  const role = readStringInput(input, key).toLowerCase();
  return role === 'router'
    || role === 'weak'
    || role === 'medium'
    || role === 'powerful'
    || role === 'vision'
    || role === 'gemma4-fast'
    || role === 'gemma4-balanced'
    || role === 'gemma4-deepthinking'
    || role === 'gemma4-31b'
    || role === 'qwen3-coder-30b-a3b-instruct'
    || role === 'deepseek-coder-v2-lite-instruct'
    ? role as MonarchModelRole
    : undefined;
}

function readResponseFormat(input: unknown): 'text' | 'json' | undefined {
  const format = readStringInput(input, 'responseFormat').toLowerCase();
  return format === 'json' || format === 'text' ? format : undefined;
}

function inferRoleFromText(text: string): MonarchModelRole | undefined {
  if (/\b(router|systemrouter)\b/i.test(text)) {
    return 'router';
  }
  if (/\bweak\b/i.test(text)) {
    return 'weak';
  }
  if (/\bmedium\b/i.test(text)) {
    return 'medium';
  }
  if (/\b(powerful|strong|large)\b/i.test(text)) {
    return 'powerful';
  }
  if (/\b(vision|gemma|image)\b/i.test(text)) {
    return 'vision';
  }
  return undefined;
}

function extractCompletionText(text: string): string {
  const quoted = text.match(/["'`](.+?)["'`]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  return text
    .replace(/^(complete|infer|run|generate).{0,28}(model|llm|inference)\s*/i, '')
    .trim() || text;
}

export function createModelsModule(): MonarchModule {
  return new ModelsModule();
}

export const modelsModulePackage: MonarchModulePackage = {
  id: modelsManifest.id,
  moduleId: modelsManifest.id,
  version: modelsManifest.version,
  description: modelsManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createModelsModule,
};
