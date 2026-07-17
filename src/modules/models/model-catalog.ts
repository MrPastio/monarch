import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { classifyIntentText } from '../../core/intent-classifier';
import { selectModelRouteForText } from '../../core/model-router';
import type { MonarchModelRuntimeReport } from './runtime-adapters';

export type MonarchModelRole =
  | 'router'
  | 'weak'
  | 'medium'
  | 'powerful'
  | 'vision'
  | 'gemma4-fast'
  | 'gemma4-balanced'
  | 'gemma4-deepthinking'
  | 'gemma4-31b'
  | 'qwen3-coder-30b-a3b-instruct'
  | 'deepseek-coder-v2-lite-instruct';

export type MonarchModelStatus =
  | 'available'
  | 'partial'
  | 'missing';

export type MonarchModelAssetKind =
  | 'gguf'
  | 'safetensors'
  | 'tokenizer'
  | 'config'
  | 'template'
  | 'license'
  | 'other';

export interface MonarchModelAsset {
  name: string;
  relativePath: string;
  kind: MonarchModelAssetKind;
  sizeBytes: number;
}

export interface MonarchModelEntry {
  role: MonarchModelRole;
  directoryName: string;
  label: string;
  description: string;
  status: MonarchModelStatus;
  totalSizeBytes: number;
  totalSize: string;
  primaryAsset?: MonarchModelAsset;
  assets: MonarchModelAsset[];
  architecture?: string;
  id: string;
  displayName: string;
  family: string;
  size: string;
  quantization: string;
  backend: string;
  mainModelPath: string;
  modelPath: string;
  mmprojPath?: string | undefined;
  draftModelPath?: string | undefined;
  draftMode?: 'mtp' | undefined;
  speculativeDecoding?: boolean | undefined;
  ctxDefault: number;
  ctxMax: number;
  gpuLayers?: number | undefined;
  ramBudgetMb: number;
  vramBudgetMb: number;
  enabled: boolean;
  experimental: boolean;
}

export interface MonarchModelCatalog {
  root: string;
  exists: boolean;
  models: MonarchModelEntry[];
  updatedAt: string;
}

export interface MonarchSelectedModel {
  role: MonarchModelRole;
  label: string;
  reason: string;
  available: boolean;
}

export interface MonarchRouterPipelineStep {
  id: string;
  label: string;
  status: 'ready' | 'active' | 'pending' | 'blocked';
  detail: string;
}

interface ModelDirectorySpec {
  role: MonarchModelRole;
  directoryName: string;
  label: string;
  description: string;
  id: string;
  displayName: string;
  family: string;
  size: string;
  quantization: string;
  backend: string;
  mainModelPath?: string | undefined;
  modelPath: string;
  modelCandidates?: string[] | undefined;
  mmprojPath?: string | undefined;
  mmprojCandidates?: string[] | undefined;
  draftModelPath?: string | undefined;
  draftCandidates?: string[] | undefined;
  draftMode?: 'mtp' | undefined;
  speculativeDecoding?: boolean | undefined;
  ctxDefault: number;
  ctxMax: number;
  gpuLayers?: number | undefined;
  ramBudgetMb: number;
  vramBudgetMb: number;
  enabled: boolean;
  experimental: boolean;
}

const MODEL_DIRECTORY_SPECS: ModelDirectorySpec[] = [
  {
    role: 'gemma4-fast',
    directoryName: 'gemma_models/Gemma_E2B',
    label: 'Gemma 4 Fast',
    description: 'Fast Gemma 4 model.',
    id: 'gemma4-fast',
    displayName: 'Gemma 4 Fast',
    family: 'gemma',
    size: 'E2B',
    quantization: 'Q5_K_M',
    backend: 'oscar-managed-backend',
    mainModelPath: 'gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf',
    modelPath: 'gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf',
    modelCandidates: [
      'gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf',
      'gemma_models/Gemma_E2B/gemma-4-E2B-it-Q4_K_M.gguf',
    ],
    mmprojPath: 'gemma_models/vision_other/mmproj-BF16_E2B.gguf',
    mmprojCandidates: [
      'gemma_models/vision_other/mmproj-BF16_E2B.gguf',
      'gemma_models/vision_other/mmproj-F16-gemma_4-E2B.gguf',
    ],
    draftModelPath: 'gemma_models/mtp_model/mtp-gemma-4-E2B-it.gguf',
    draftCandidates: ['gemma_models/mtp_model/mtp-gemma-4-E2B-it.gguf'],
    draftMode: 'mtp',
    speculativeDecoding: true,
    ctxDefault: 2048,
    ctxMax: 4096,
    gpuLayers: 16,
    ramBudgetMb: 4096,
    vramBudgetMb: 2048,
    enabled: true,
    experimental: false,
  },
  {
    role: 'gemma4-balanced',
    directoryName: 'gemma_models/Gemma_12B',
    label: 'Gemma 4 Balanced',
    description: 'Balanced Gemma 4 model.',
    id: 'gemma4-balanced',
    displayName: 'Gemma 4 Balanced',
    family: 'gemma',
    size: '12B',
    quantization: 'Q4_K_M',
    backend: 'oscar-managed-backend',
    mainModelPath: 'gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf',
    modelPath: 'gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf',
    modelCandidates: [
      'gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf',
      'gemma_models/Gemma_12B/gemma-4-12b-it-Q4_K_M.gguf',
    ],
    mmprojPath: 'gemma_models/vision_other/mmproj-BF16_12B.gguf',
    mmprojCandidates: [
      'gemma_models/vision_other/mmproj-BF16_12B.gguf',
      'gemma_models/vision_other/mmproj-gemma-4-12B-it-f16.gguf',
    ],
    draftModelPath: 'gemma_models/mtp_model/mtp-gemma-4-12b-it.gguf',
    draftCandidates: ['gemma_models/mtp_model/mtp-gemma-4-12b-it.gguf'],
    draftMode: 'mtp',
    speculativeDecoding: true,
    ctxDefault: 4096,
    ctxMax: 8192,
    gpuLayers: 32,
    ramBudgetMb: 8192,
    vramBudgetMb: 6144,
    enabled: true,
    experimental: false,
  },
  {
    role: 'gemma4-deepthinking',
    directoryName: 'gemma_models/Gemma_26B',
    label: 'Pro',
    description: 'Pro model for complex reasoning and development.',
    id: 'gemma4-deepthinking',
    displayName: 'Pro',
    family: 'gemma',
    size: '26B',
    quantization: 'Q4_K_M',
    backend: 'oscar-managed-backend',
    mainModelPath: 'gemma_models/Gemma_26B/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
    modelPath: 'gemma_models/Gemma_26B/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
    modelCandidates: [
      'gemma_models/Gemma_26B/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
      'gemma_models/Gemma_26B/gemma-4-26B-it-Q4_K_M.gguf',
    ],
    mmprojPath: 'gemma_models/vision_other/mmproj-BF16_26B.gguf',
    mmprojCandidates: ['gemma_models/vision_other/mmproj-BF16_26B.gguf'],
    draftModelPath: 'gemma_models/mtp_model/mtp-gemma-4-26B-A4B-it.gguf',
    draftCandidates: ['gemma_models/mtp_model/mtp-gemma-4-26B-A4B-it.gguf'],
    draftMode: 'mtp',
    speculativeDecoding: true,
    ctxDefault: 8192,
    ctxMax: 16384,
    gpuLayers: 0,
    ramBudgetMb: 24576,
    vramBudgetMb: 1024,
    enabled: true,
    experimental: true,
  },
  {
    role: 'gemma4-31b',
    directoryName: 'gemma_models/Gemma_31B',
    label: 'Extra',
    description: 'Extra model for maximum-depth work.',
    id: 'gemma4-31b',
    displayName: 'Extra',
    family: 'gemma',
    size: '31B',
    quantization: 'Q4_K_M',
    backend: 'oscar-managed-backend',
    mainModelPath: 'gemma_models/Gemma_31B/gemma-4-31B-it-Q4_K_S.gguf',
    modelPath: 'gemma_models/Gemma_31B/gemma-4-31B-it-Q4_K_S.gguf',
    modelCandidates: [
      'gemma_models/Gemma_31B/gemma-4-31B-it-Q4_K_M.gguf',
      'gemma_models/Gemma_31B/gemma-4-31B-it-Q4_K_S.gguf',
    ],
    mmprojPath: 'gemma_models/vision_other/mmproj-BF16_31B.gguf',
    mmprojCandidates: ['gemma_models/vision_other/mmproj-BF16_31B.gguf'],
    draftModelPath: 'gemma_models/mtp_model/mtp-gemma-4-31B-it.gguf',
    draftCandidates: ['gemma_models/mtp_model/mtp-gemma-4-31B-it.gguf'],
    draftMode: 'mtp',
    speculativeDecoding: true,
    ctxDefault: 4096,
    ctxMax: 8192,
    gpuLayers: 0,
    ramBudgetMb: 32768,
    vramBudgetMb: 1024,
    enabled: true,
    experimental: true,
  },
  {
    role: 'qwen3-coder-30b-a3b-instruct',
    directoryName: 'runtime/coder/models/qwen3-coder-30b-a3b-instruct',
    label: 'Qwen3 Coder Primary',
    description: 'Primary agentic coding model for Monarch Coder Mode.',
    id: 'qwen3-coder-30b-a3b-instruct',
    displayName: 'Qwen3 Coder 30B A3B',
    family: 'qwen3-coder',
    size: '30B A3B',
    quantization: 'Q4_K_M',
    backend: 'oscar-managed-backend',
    mainModelPath: 'runtime/coder/models/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
    modelPath: 'runtime/coder/models/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
    modelCandidates: ['runtime/coder/models/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'],
    ctxDefault: 16384,
    ctxMax: 32768,
    gpuLayers: 12,
    ramBudgetMb: 23552,
    vramBudgetMb: 7168,
    enabled: true,
    experimental: true,
  },
  {
    role: 'deepseek-coder-v2-lite-instruct',
    directoryName: 'runtime/coder/models/deepseek-coder-v2-lite-instruct',
    label: 'DeepSeek Coder Secondary',
    description: 'Secondary coding model and local fallback for Monarch Coder Mode.',
    id: 'deepseek-coder-v2-lite-instruct',
    displayName: 'DeepSeek Coder V2 Lite',
    family: 'deepseek-coder-v2',
    size: '16B 2.4B active',
    quantization: 'Q4_K_M',
    backend: 'oscar-managed-backend',
    mainModelPath: 'runtime/coder/models/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    modelPath: 'runtime/coder/models/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    modelCandidates: ['runtime/coder/models/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf'],
    ctxDefault: 16384,
    ctxMax: 32768,
    gpuLayers: 20,
    ramBudgetMb: 14336,
    vramBudgetMb: 7168,
    enabled: true,
    experimental: true,
  },
];

export async function readModelCatalog(workspaceRoot: string): Promise<MonarchModelCatalog> {
  const root = path.join(workspaceRoot, 'gemma_models');
  const exists = await directoryExists(root);
  const models: MonarchModelEntry[] = [];

  for (const spec of MODEL_DIRECTORY_SPECS) {
    models.push(await readModelEntry(workspaceRoot, spec, exists));
  }

  return {
    root,
    exists,
    models,
    updatedAt: new Date().toISOString(),
  };
}

export function selectModelForInput(
  input: string,
  catalog: MonarchModelCatalog,
  hasImageAttachments: boolean = false
): MonarchSelectedModel {
  const normalized = input.trim();
  const classification = classifyIntentText(normalized);
  const modelRoute = selectModelRouteForText(normalized, classification, hasImageAttachments);
  const role = normalizeSelectableRole(modelRoute.selectedRole);
  const model = catalog.models.find((entry) => entry.role === role);

  return {
    role,
    label: model?.label || role,
    reason: modelRoute.reason,
    available: model?.status === 'available',
  };
}

export function createRouterPipeline(
  input: string,
  catalog: MonarchModelCatalog,
  runtimeReport?: MonarchModelRuntimeReport
): MonarchRouterPipelineStep[] {
  const selectedModel = selectModelForInput(input, catalog);
  const selectedRuntime = runtimeReport?.entries.find((entry) => entry.role === selectedModel.role);
  const selectedReady = selectedModel.available && (!selectedRuntime || selectedRuntime.canInfer);

  return [
    {
      id: 'input-normalizer',
      label: 'Input Normalizer',
      status: input.trim() ? 'ready' : 'pending',
      detail: 'Trim, source=desktop, normalized text.',
    },
    {
      id: 'pre-analysis',
      label: 'Pre-analysis',
      status: input.trim() ? 'ready' : 'pending',
      detail: 'Language, action shape, domain hints.',
    },
    {
      id: 'rule-layer',
      label: 'Rule Layer',
      status: 'ready',
      detail: 'Manifest rules and risk thresholds.',
    },
    {
      id: 'fast-classifier',
      label: 'Fast Classifier',
      status: 'ready',
      detail: 'Deterministic capability scoring.',
    },
    {
      id: 'llm-router',
      label: 'Model Router',
      status: 'ready',
      detail: 'Deterministic classifier routes requests to available Gemma profiles.',
    },
    {
      id: 'decision-validator',
      label: 'Decision Validator',
      status: 'ready',
      detail: 'Confidence, ambiguity, required input.',
    },
    {
      id: 'execution-graph',
      label: 'Execution Graph Builder',
      status: 'ready',
      detail: 'Build MonarchPlan from selected route.',
    },
    {
      id: 'risk-permission',
      label: 'Risk / Permission Layer',
      status: 'ready',
      detail: 'read=allow, device-control=confirm.',
    },
    {
      id: 'resource-scheduler',
      label: 'Resource Scheduler',
      status: selectedReady ? 'ready' : 'blocked',
      detail: selectedRuntime && !selectedRuntime.canInfer
        ? `${selectedModel.label}: ${selectedRuntime.detail}`
        : `${selectedModel.label}: ${selectedModel.reason}`,
    },
    {
      id: 'selected-pipeline',
      label: 'Selected Pipeline',
      status: selectedReady ? 'active' : 'blocked',
      detail: `${selectedModel.role} model selected for response work.`,
    },
    {
      id: 'executor',
      label: 'Executor',
      status: 'pending',
      detail: 'Capability execution through module only.',
    },
    {
      id: 'result-validator',
      label: 'Result Validator',
      status: 'pending',
      detail: 'Validate module result and errors.',
    },
    {
      id: 'response-composer',
      label: 'Response Composer',
      status: 'pending',
      detail: 'Compose concise user response.',
    },
  ];
}

async function readModelEntry(
  root: string,
  spec: ModelDirectorySpec,
  rootExists: boolean
): Promise<MonarchModelEntry> {
  const directory = path.join(root, spec.directoryName);

  let enabled = spec.enabled;
  if (spec.role === 'gemma4-31b') {
    const envVal = process.env.MONARCH_ENABLE_GEMMA4_31B?.trim().toLowerCase();
    if (envVal) {
      enabled = envVal === 'true' || envVal === '1' || envVal === 'on' || envVal === 'yes';
    }
  }

  if (!rootExists || !(await directoryExists(directory))) {
    return {
      role: spec.role,
      directoryName: spec.directoryName,
      label: spec.label,
      description: spec.description,
      status: 'missing',
      totalSizeBytes: 0,
      totalSize: formatBytes(0),
      assets: [],
      id: spec.id,
      displayName: spec.displayName,
      family: spec.family,
      size: spec.size,
      quantization: spec.quantization,
      backend: spec.backend,
      mainModelPath: spec.mainModelPath || spec.modelPath,
      modelPath: spec.modelPath,
      mmprojPath: spec.mmprojPath,
      draftModelPath: spec.draftModelPath,
      draftMode: spec.draftMode,
      speculativeDecoding: Boolean(spec.speculativeDecoding && spec.draftModelPath),
      ctxDefault: spec.ctxDefault,
      ctxMax: spec.ctxMax,
      gpuLayers: spec.gpuLayers,
      ramBudgetMb: spec.ramBudgetMb,
      vramBudgetMb: spec.vramBudgetMb,
      enabled,
      experimental: spec.experimental,
    };
  }

  const assets = await listModelAssets(directory, directory);
  const primaryAsset = await pickPrimaryAsset(directory, assets, spec);
  const modelPath = primaryAsset
    ? toWorkspaceRelativePath(spec.directoryName, primaryAsset.relativePath)
    : spec.modelPath;
  const mmprojPath = await resolveFirstValidWorkspaceGguf(root, spec.mmprojCandidates || optionalList(spec.mmprojPath))
    || spec.mmprojPath;
  const draftModelPath = await resolveFirstValidWorkspaceGguf(root, spec.draftCandidates || optionalList(spec.draftModelPath));
  const architecture = await readArchitecture(directory);
  const totalSizeBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);

  const entry: MonarchModelEntry = {
    role: spec.role,
    directoryName: spec.directoryName,
    label: spec.label,
    description: spec.description,
    status: primaryAsset ? 'available' : assets.length > 0 ? 'partial' : 'missing',
    totalSizeBytes,
    totalSize: formatBytes(totalSizeBytes),
    assets,
    id: spec.id,
    displayName: spec.displayName,
    family: spec.family,
    size: spec.size,
    quantization: spec.quantization,
    backend: spec.backend,
    mainModelPath: modelPath,
    modelPath,
    mmprojPath,
    draftModelPath,
    draftMode: spec.draftMode,
    speculativeDecoding: Boolean(spec.speculativeDecoding && draftModelPath),
    ctxDefault: spec.ctxDefault,
    ctxMax: spec.ctxMax,
    gpuLayers: spec.gpuLayers,
    ramBudgetMb: spec.ramBudgetMb,
    vramBudgetMb: spec.vramBudgetMb,
    enabled,
    experimental: spec.experimental,
  };

  if (primaryAsset) {
    entry.primaryAsset = primaryAsset;
  }
  if (architecture) {
    entry.architecture = architecture;
  }

  return entry;
}

async function listModelAssets(directory: string, baseDirectory: string): Promise<MonarchModelAsset[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets: MonarchModelAsset[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...await listModelAssets(fullPath, baseDirectory));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const fileStat = await stat(fullPath);
    const relativePath = path.relative(baseDirectory, fullPath).replaceAll(path.sep, '/');
    assets.push({
      name: entry.name,
      relativePath,
      kind: detectAssetKind(entry.name),
      sizeBytes: fileStat.size,
    });
  }

  return assets.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readArchitecture(directory: string): Promise<string> {
  const configPath = path.join(directory, 'config.json');
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const architectures = config.architectures;
    if (Array.isArray(architectures) && typeof architectures[0] === 'string') {
      return architectures[0];
    }
    const modelType = config.model_type;
    return typeof modelType === 'string' ? modelType : '';
  } catch {
    return '';
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const directoryStat = await stat(directory);
    return directoryStat.isDirectory();
  } catch {
    return false;
  }
}

function detectAssetKind(fileName: string): MonarchModelAssetKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.gguf')) {
    return 'gguf';
  }
  if (lower.endsWith('.safetensors')) {
    return 'safetensors';
  }
  if (lower.includes('tokenizer') || lower === 'vocab.json' || lower === 'merges.txt') {
    return 'tokenizer';
  }
  if (lower.endsWith('.json')) {
    return 'config';
  }
  if (lower.endsWith('.jinja')) {
    return 'template';
  }
  if (lower === 'license') {
    return 'license';
  }
  return 'other';
}

async function pickPrimaryAsset(
  directory: string,
  assets: MonarchModelAsset[],
  spec: ModelDirectorySpec
): Promise<MonarchModelAsset | undefined> {
  const candidateNames = (spec.modelCandidates || [spec.modelPath])
    .map((candidate) => path.basename(candidate).toLowerCase());
  const candidatePriority = new Map(candidateNames.map((name, index) => [name, index]));
  const ggufAssets = assets.filter((candidate) => candidate.kind === 'gguf');
  const preferredAssets = ggufAssets
    .filter((asset) => candidatePriority.has(asset.name.toLowerCase()))
    .sort((left, right) => {
      const leftPriority = candidatePriority.get(left.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = candidatePriority.get(right.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority;
    });
  const orderedAssets = [
    ...preferredAssets,
    ...ggufAssets.filter((asset) => !candidatePriority.has(asset.name.toLowerCase()) && !asset.name.toLowerCase().startsWith('mtp-')),
  ];

  for (const asset of orderedAssets) {
    if (await hasGgufMagic(path.join(directory, asset.relativePath))) {
      return asset;
    }
  }
  return assets.find((asset) => asset.kind === 'safetensors');
}

function optionalList(value: string | undefined): string[] {
  return value ? [value] : [];
}

function toWorkspaceRelativePath(directoryName: string, relativePath: string): string {
  return `${directoryName.replaceAll('\\', '/')}/${relativePath.replaceAll('\\', '/')}`;
}

async function resolveFirstValidWorkspaceGguf(root: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const fullPath = path.join(root, candidate);
    if (await hasGgufMagic(fullPath)) {
      return candidate.replaceAll('\\', '/');
    }
  }
  return undefined;
}

async function hasGgufMagic(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'r');
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    return bytesRead === magic.length && magic.toString('ascii') === 'GGUF';
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function normalizeSelectableRole(role: string): MonarchModelRole {
  const target = role === 'router' ? 'weak' : role;
  if (target === 'weak') return 'gemma4-fast';
  if (target === 'medium') return 'gemma4-balanced';
  if (target === 'powerful') return 'gemma4-deepthinking';
  if (target === 'vision') return 'gemma4-balanced';
  return target as MonarchModelRole;
}

export function selectModelRole(normalizedInput: string): MonarchModelRole {
  if (/(image|vision|picture|photo|изображ|картин|фото|скриншот|визуал)/i.test(normalizedInput)) {
    return 'vision';
  }

  const complexitySignals = [
    /(architecture|refactor|security|debug|implement|pipeline|router|planner|executor)/i,
    /(архитект|рефактор|безопасн|отлад|реализ|пайплайн|роутер|планиров|исполнитель)/i,
    /(многошаг|сложн|подробн|сравни|проанализируй|создай ui|сгенерируй)/i,
  ];

  if (normalizedInput.length > 180 || complexitySignals.some((pattern) => pattern.test(normalizedInput))) {
    return 'powerful';
  }

  if (normalizedInput.length > 80 || /(почему|как|объясни|plan|design|код|code)/i.test(normalizedInput)) {
    return 'medium';
  }

  return 'weak';
}

export function selectionReason(role: MonarchModelRole, normalizedInput: string): string {
  switch (role) {
  case 'vision':
    return 'image-processing request';
  case 'powerful':
    return normalizedInput.length > 180 ? 'long or complex request' : 'complexity signals detected';
  case 'medium':
    return 'normal reasoning request';
  case 'weak':
    return 'short lightweight request';
  case 'router':
    return 'route decision only';
  case 'gemma4-fast':
  case 'gemma4-balanced':
  case 'gemma4-deepthinking':
  case 'gemma4-31b':
    return `Gemma 4 model for ${role} request`;
  case 'qwen3-coder-30b-a3b-instruct':
  case 'deepseek-coder-v2-lite-instruct':
    return `Dedicated Coder Mode model for ${role} request`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = units[unitIndex] || 'B';
  return `${value >= 10 || unit === 'B' ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
