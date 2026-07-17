import { existsSync } from 'node:fs';
import path from 'node:path';
import { isIPv4, isIPv6 } from 'node:net';
import type {
  MonarchModelCatalog,
  MonarchModelEntry,
  MonarchModelRole,
} from './model-catalog';

export type MonarchModelRunnerStatus =
  | 'ready'
  | 'runner-missing'
  | 'model-missing'
  | 'disabled'
  | 'loading'
  | 'missing'
  | 'unhealthy'
  | 'present'
  | 'experimental';

export interface MonarchModelRuntimeEntry {
  role: MonarchModelRole;
  label: string;
  adapter: string;
  runnerStatus: MonarchModelRunnerStatus;
  canInfer: boolean;
  detail: string;
  modelAsset?: string;
  draftModelAsset?: string;
  draftMode?: string;
  speculativeDecoding?: boolean;
  endpoint?: string;
  runnerPath?: string;
}

export interface MonarchModelRuntimeReport {
  entries: MonarchModelRuntimeEntry[];
  updatedAt: string;
}

export function createModelRuntimeReport(
  catalog: MonarchModelCatalog,
  env: NodeJS.ProcessEnv = process.env
): MonarchModelRuntimeReport {
  return {
    entries: catalog.models.map((model) => createRuntimeEntry(model, env)),
    updatedAt: new Date().toISOString(),
  };
}

export function runtimeEntryForRole(
  report: MonarchModelRuntimeReport,
  role: MonarchModelRole
): MonarchModelRuntimeEntry | undefined {
  return report.entries.find((entry) => entry.role === role);
}

function createRuntimeEntry(
  model: MonarchModelEntry,
  env: NodeJS.ProcessEnv
): MonarchModelRuntimeEntry {
  const endpoint = endpointForRole(model.role, env);
  const runnerPath = runnerPathForRole(model.role, env);
  const adapter = adapterForRole(model.role, model.primaryAsset?.kind);
  const externalModelAsset = modelNameForRole(model.role, env);

  if (endpoint && (isLocalEndpoint(endpoint) || allowsExternalModelEndpoint(env))) {
    const modelAsset = externalModelAsset || model.primaryAsset?.name || '';
    const entry: MonarchModelRuntimeEntry = {
      role: model.role,
      label: model.label,
      adapter,
      runnerStatus: 'ready',
      canInfer: true,
      detail: isLocalEndpoint(endpoint)
        ? 'Local model endpoint is configured.'
        : 'External OpenAI-compatible endpoint is configured for this tier.',
      endpoint,
      modelAsset,
    };
    applyDraftMetadata(entry, model);
    return entry;
  }

  if (model.role.startsWith('gemma4-') || model.role.includes('coder')) {
    let runnerStatus: MonarchModelRunnerStatus = 'ready';
    let canInfer = false;
    let detail = '';

    if (!model.enabled) {
      runnerStatus = 'disabled';
      detail = 'Model profile is disabled.';
    } else {
      const hasCrdownload = model.assets.some((asset) => asset.name.endsWith('.crdownload'));
      if (hasCrdownload) {
        runnerStatus = 'loading';
        detail = 'Model download in progress.';
      } else if (model.status === 'missing' || !model.primaryAsset) {
        runnerStatus = 'missing';
        detail = 'Model weights are missing.';
      } else if (model.primaryAsset.sizeBytes < 100) {
        runnerStatus = 'unhealthy';
        detail = 'Model weights failed health check.';
      } else if (model.experimental) {
        runnerStatus = 'experimental';
        canInfer = true;
        detail = 'Model is ready (experimental).';
      } else {
        runnerStatus = 'present';
        canInfer = true;
        detail = 'Model is present and ready.';
      }
    }

    const entry: MonarchModelRuntimeEntry = {
      role: model.role,
      label: model.label,
      adapter,
      runnerStatus,
      canInfer,
      detail,
    };
    if (model.primaryAsset?.name) {
      entry.modelAsset = model.primaryAsset.name;
    }
    applyDraftMetadata(entry, model);
    return entry;
  }

  if (model.status !== 'available') {
    if (endpoint && allowsExternalModelEndpoint(env)) {
      const entry: MonarchModelRuntimeEntry = {
        role: model.role,
        label: model.label,
        adapter,
        runnerStatus: 'ready',
        canInfer: true,
        detail: 'External OpenAI-compatible endpoint is configured for this tier.',
        endpoint,
      };
      if (externalModelAsset) {
        entry.modelAsset = externalModelAsset;
      }
      return entry;
    }

    return {
      role: model.role,
      label: model.label,
      adapter,
      runnerStatus: 'model-missing',
      canInfer: false,
      detail: 'Model asset is missing or incomplete.',
    };
  }

  if ((endpoint && runnerPath) || (endpoint && allowsExternalModelEndpoint(env)) || runnerPath) {
    const entry: MonarchModelRuntimeEntry = {
      role: model.role,
      label: model.label,
      adapter,
      runnerStatus: 'ready',
      canInfer: true,
      detail: endpoint && runnerPath
        ? 'Monarch-managed local model runtime configured.'
        : endpoint
          ? 'Explicit external model endpoint enabled for development.'
          : 'Local runner command configured.',
    };
    const modelAsset = externalModelAsset || model.primaryAsset?.name || '';
    if (modelAsset) {
      entry.modelAsset = modelAsset;
    }
    if (endpoint) {
      entry.endpoint = endpoint;
    }
    if (runnerPath) {
      entry.runnerPath = runnerPath;
    }
    return entry;
  }

  if (canUseOscarBridge(model.role, env)) {
    const entry: MonarchModelRuntimeEntry = {
      role: model.role,
      label: model.label,
      adapter: 'oscar-managed-backend',
      runnerStatus: 'ready',
      canInfer: true,
      detail: 'Oscar managed backend bridge is available for this tier.',
    };
    if (model.primaryAsset?.name) {
      entry.modelAsset = model.primaryAsset.name;
    }
    applyDraftMetadata(entry, model);
    return entry;
  }

  const entry: MonarchModelRuntimeEntry = {
    role: model.role,
    label: model.label,
    adapter,
    runnerStatus: 'runner-missing',
    canInfer: false,
    detail: runnerHintForRole(model.role),
  };
  if (model.primaryAsset?.name) {
    entry.modelAsset = model.primaryAsset.name;
  }
  return entry;
}

function applyDraftMetadata(entry: MonarchModelRuntimeEntry, model: MonarchModelEntry): void {
  if (!model.draftModelPath) {
    return;
  }
  entry.draftModelAsset = path.basename(model.draftModelPath);
  if (model.draftMode) {
    entry.draftMode = model.draftMode;
  }
  entry.speculativeDecoding = Boolean(model.speculativeDecoding);
}

function endpointForRole(role: MonarchModelRole, env: NodeJS.ProcessEnv): string {
  switch (role) {
  case 'router':
    return normalizeEnv(env.MONARCH_SYSTEM_ROUTER_ENDPOINT);
  case 'vision':
    return normalizeEnv(env.MONARCH_GEMMA_ENDPOINT);
  case 'weak':
  case 'medium':
  case 'powerful':
    return normalizeEnv(env[`MONARCH_${role.toUpperCase()}_MODEL_ENDPOINT`])
      || normalizeEnv(env.MONARCH_CHAT_MODEL_ENDPOINT);
  case 'gemma4-fast':
  case 'gemma4-balanced':
  case 'gemma4-deepthinking':
  case 'gemma4-31b':
  case 'qwen3-coder-30b-a3b-instruct':
  case 'deepseek-coder-v2-lite-instruct':
    return gemmaProfileEnv(env, role, 'ENDPOINT')
      || normalizeEnv(env.MONARCH_CHAT_MODEL_ENDPOINT);
  }
}

function allowsExternalModelEndpoint(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.MONARCH_ALLOW_EXTERNAL_MODEL_ENDPOINTS || ''));
}

function runnerPathForRole(role: MonarchModelRole, env: NodeJS.ProcessEnv): string {
  switch (role) {
  case 'router':
    return normalizeEnv(env.MONARCH_SYSTEM_ROUTER_COMMAND);
  case 'vision':
    return normalizeEnv(env.MONARCH_GEMMA_COMMAND);
  case 'weak':
  case 'medium':
  case 'powerful':
    return normalizeEnv(env[`MONARCH_${role.toUpperCase()}_MODEL_COMMAND`])
      || normalizeEnv(env.MONARCH_LLAMA_CPP_COMMAND);
  case 'gemma4-fast':
  case 'gemma4-balanced':
  case 'gemma4-deepthinking':
  case 'gemma4-31b':
  case 'qwen3-coder-30b-a3b-instruct':
  case 'deepseek-coder-v2-lite-instruct':
    return gemmaProfileEnv(env, role, 'COMMAND');
  }
}

function modelNameForRole(role: MonarchModelRole, env: NodeJS.ProcessEnv): string {
  switch (role) {
  case 'router':
    return normalizeEnv(env.MONARCH_SYSTEM_ROUTER_MODEL)
      || normalizeEnv(env.MONARCH_ROUTER_MODEL)
      || normalizeEnv(env.MONARCH_CHAT_MODEL_NAME);
  case 'vision':
    return normalizeEnv(env.MONARCH_GEMMA_MODEL)
      || normalizeEnv(env.MONARCH_VISION_MODEL)
      || normalizeEnv(env.MONARCH_CHAT_MODEL_NAME);
  case 'weak':
  case 'medium':
  case 'powerful':
    return normalizeEnv(env[`MONARCH_${role.toUpperCase()}_MODEL_NAME`])
      || normalizeEnv(env.MONARCH_CHAT_MODEL_NAME);
  case 'gemma4-fast':
  case 'gemma4-balanced':
  case 'gemma4-deepthinking':
  case 'gemma4-31b':
  case 'qwen3-coder-30b-a3b-instruct':
  case 'deepseek-coder-v2-lite-instruct':
    return gemmaProfileEnv(env, role, 'NAME');
  }
}

function gemmaProfileEnv(
  env: NodeJS.ProcessEnv,
  role: MonarchModelRole,
  suffix: 'ENDPOINT' | 'COMMAND' | 'NAME'
): string {
  const normalizedRole = role.toUpperCase().replaceAll('-', '_');
  return normalizeEnv(env[`MONARCH_${normalizedRole}_MODEL_${suffix}`])
    || normalizeEnv(env[`MONARCH_${role.toUpperCase()}_MODEL_${suffix}`]);
}

function adapterForRole(
  role: MonarchModelRole,
  assetKind: string | undefined
): string {
  if (role === 'router') {
    return 'systemrouter-local';
  }
  if (role === 'vision') {
    return 'gemma-vision-local';
  }
  if (assetKind === 'gguf') {
    return 'llama.cpp-compatible';
  }
  return 'transformers-compatible';
}

function runnerHintForRole(role: MonarchModelRole): string {
  switch (role) {
  case 'router':
    return 'Configure a Monarch-managed router command and local readiness endpoint.';
  case 'vision':
    return 'Configure a Monarch-managed Gemma command and local readiness endpoint.';
  case 'weak':
  case 'medium':
  case 'powerful':
    return `Configure MONARCH_${role.toUpperCase()}_MODEL_COMMAND with a local runtime owned by this project.`;
  case 'gemma4-fast':
  case 'gemma4-balanced':
  case 'gemma4-deepthinking':
  case 'gemma4-31b':
  case 'qwen3-coder-30b-a3b-instruct':
  case 'deepseek-coder-v2-lite-instruct':
    return `Configure MONARCH_${role.toUpperCase()}_MODEL_COMMAND with a local runtime owned by this project.`;
  }
}

function normalizeEnv(value: string | undefined): string {
  return String(value || '').trim();
}

function isLoopbackHost(h: string): boolean {
  const clean = h.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    clean === 'localhost' ||
    clean === '127.0.0.1' ||
    clean === '::1' ||
    clean === '0.0.0.0' ||
    clean === '::' ||
    clean.startsWith('127.')
  );
}

export function isLocalEndpoint(endpoint: string): boolean {
  if (!endpoint) return false;

  let stripped = endpoint.trim();

  // Strip scheme if present (e.g. http://, https://, ws://, etc.)
  const schemeMatch = stripped.match(/^([a-zA-Z0-9+-.]+)?:?\/\//);
  if (schemeMatch) {
    stripped = stripped.substring(schemeMatch[0].length);
  }

  // Strip path, query, hash
  const slashIndex = stripped.indexOf('/');
  if (slashIndex !== -1) {
    stripped = stripped.substring(0, slashIndex);
  }
  const questionIndex = stripped.indexOf('?');
  if (questionIndex !== -1) {
    stripped = stripped.substring(0, questionIndex);
  }
  const hashIndex = stripped.indexOf('#');
  if (hashIndex !== -1) {
    stripped = stripped.substring(0, hashIndex);
  }

  let host = stripped;

  // Check if bracketed IPv6 (e.g., [::1], [::1]:8080)
  if (host.includes('[') && host.includes(']')) {
    const start = host.indexOf('[');
    const end = host.indexOf(']');
    if (end > start) {
      host = host.substring(start + 1, end);
    }
  } else {
    // Not bracketed. Could be raw IPv6 (e.g. ::1) or host:port (e.g. ::1:8080, localhost:3000)
    // If the entire host is a loopback host directly, we don't need to split port
    if (isLoopbackHost(host)) {
      return true;
    }

    // Try to split port
    const lastColon = host.lastIndexOf(':');
    if (lastColon !== -1) {
      const potentialHost = host.substring(0, lastColon);
      const potentialPort = host.substring(lastColon + 1);
      if (/^\d+$/.test(potentialPort)) {
        if (isLoopbackHost(potentialHost) || isIPv6(potentialHost) || isIPv4(potentialHost) || !potentialHost.includes(':')) {
          host = potentialHost;
        }
      }
    }
  }

  return isLoopbackHost(host);
}

function canUseOscarBridge(_role: MonarchModelRole, env: NodeJS.ProcessEnv): boolean {
  if (/^(1|true|yes|on)$/i.test(String(env.MONARCH_DISABLE_OSCAR_MODEL_BRIDGE || ''))) {
    return false;
  }
  const projectRoot = path.resolve(env.OSCAR_PROJECT_ROOT || path.join(process.cwd(), 'oscar'));
  const backendMain = path.join(projectRoot, 'backend', 'oscar_agent', 'main.py');
  const venvPython = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  return existsSync(backendMain) && existsSync(venvPython);
}
