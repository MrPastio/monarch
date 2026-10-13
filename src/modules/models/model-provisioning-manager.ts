import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MonarchRuntimePaths } from '../../core/runtime-paths';
import {
  MONARCH_BALANCED_MODEL_ADDONS,
  MONARCH_CODER_MODEL_COMPONENTS,
  MONARCH_FAST_MODEL_ADDONS,
  MONARCH_MEMORY_SEARCH_COMPONENTS,
  MONARCH_OPTIONAL_BALANCED_MODEL,
  MONARCH_OPTIONAL_PRO_MODEL_COMPONENTS,
  MONARCH_REQUIRED_FAST_MODEL,
  MONARCH_VOICE_RECOGNITION_COMPONENTS,
  MonarchModelComponentManager,
  mapLogicalModelPath,
  type MonarchComponentManagerSnapshot,
  type MonarchManagedModelComponent,
  type MonarchModelComponentManagerOptions,
  type MonarchModelComponentSpec,
} from './component-manager';
import { runInBackground } from '../../core/background-work';

export type MonarchInstallableModelRole =
  | 'gemma4-fast'
  | 'gemma4-balanced'
  | 'qwen3.8-27b-pro';

/** Downloads that are not chat tiers: Coder models and the helper packs features need. */
export type MonarchExtraComponentId =
  | 'coder'
  | 'coder-backup'
  | 'voice-recognition'
  | 'memory-search';

export type MonarchInstallableGroupId = MonarchInstallableModelRole | MonarchExtraComponentId;

export interface MonarchModelHardwareRecommendation {
  ramTotalGb: number;
  ramAvailableGb: number;
  diskFreeBytes: number | null;
  recommendedRole: MonarchInstallableModelRole;
}

export interface MonarchProvisionedModel {
  role: MonarchInstallableGroupId;
  kind: 'chat' | 'extra';
  label: string;
  summary: string;
  /** Plain-language note on what the download enables (extras only). */
  description: string | null;
  beta: boolean;
  /** Memory this model needs to run at its normal speed. */
  recommendedRamGb: number;
  installed: boolean;
  complete: boolean;
  phase: MonarchManagedModelComponent['phase'];
  expectedBytes: number;
  downloadedBytes: number;
  progress: number;
  warning: string | null;
  manualInstall: readonly MonarchManualModelInstallFile[];
  components: MonarchManagedModelComponent[];
}

export interface MonarchManualModelInstallFile {
  fileName: string;
  directory: string;
  url: string;
}

export type MonarchModelOnboardingCompletion =
  | 'pending'
  | 'installed'
  | 'skipped'
  | 'adopted'
  | 'not-applicable';

export interface MonarchModelProvisioningSnapshot {
  schemaVersion: 2;
  autoRepairEnabled: false;
  ready: boolean;
  requiredModel: MonarchManagedModelComponent;
  models: MonarchProvisionedModel[];
  extras: MonarchProvisionedModel[];
  onboarding: {
    required: boolean;
    completed: boolean;
    completion: MonarchModelOnboardingCompletion;
    welcomeRequired: boolean;
    welcomeToken: string | null;
    recommendedRole: MonarchInstallableModelRole;
    selectedRoles: MonarchInstallableModelRole[];
    hardware: MonarchModelHardwareRecommendation;
    error: string | null;
  };
  activeInstall: null | {
    source: 'onboarding' | 'settings';
    roles: MonarchInstallableGroupId[];
  };
}

interface PersistedModelSetupV2 {
  schemaVersion: 2;
  completed: boolean;
  completion: MonarchModelOnboardingCompletion;
  welcomeAcknowledged: boolean;
  selectedRoles: MonarchInstallableModelRole[];
  error: string | null;
  updatedAt: string;
}

export interface ModelGroupDefinition {
  role: MonarchInstallableGroupId;
  /** 'chat' tiers take part in first setup and recommendations; 'extra' only on request. */
  kind?: 'chat' | 'extra';
  description?: string;
  label: string;
  summary: string;
  beta: boolean;
  recommendedRamGb: number;
  components: readonly MonarchModelComponentSpec[];
}

export interface MonarchModelProvisioningManagerOptions {
  groups?: readonly ModelGroupDefinition[];
  extraGroups?: readonly ModelGroupDefinition[];
  extractArchiveImpl?: MonarchModelComponentManagerOptions['extractArchiveImpl'];
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
  now?: () => Date;
  totalMemoryBytes?: number;
  availableMemoryBytes?: number;
}

export interface MonarchModelProvisioningController {
  snapshot(): MonarchModelProvisioningSnapshot | MonarchComponentManagerSnapshot;
  startAutomaticRepair(): void;
  ensureRequiredModel(): Promise<MonarchModelProvisioningSnapshot | MonarchComponentManagerSnapshot>;
  stop(): Promise<void>;
  initialize?(): Promise<MonarchModelProvisioningSnapshot | MonarchComponentManagerSnapshot>;
  startInstallModels?(
    roles: MonarchInstallableGroupId[],
    source: 'onboarding' | 'settings',
  ): MonarchModelProvisioningSnapshot | MonarchComponentManagerSnapshot;
  skipOnboarding?(): Promise<MonarchModelProvisioningSnapshot | MonarchComponentManagerSnapshot>;
  acknowledgeOnboardingWelcome?(): Promise<MonarchModelProvisioningSnapshot | MonarchComponentManagerSnapshot>;
}

export const MONARCH_MODEL_INSTALL_GROUPS: readonly ModelGroupDefinition[] = Object.freeze([
  Object.freeze({
    role: 'gemma4-fast',
    label: 'Basic 2B',
    summary: 'Быстро · базово',
    beta: false,
    recommendedRamGb: 8,
    components: Object.freeze([MONARCH_REQUIRED_FAST_MODEL, ...MONARCH_FAST_MODEL_ADDONS]),
  }),
  Object.freeze({
    role: 'gemma4-balanced',
    label: 'Basic 12B',
    summary: 'Быстро · умнее',
    beta: false,
    recommendedRamGb: 16,
    components: Object.freeze([MONARCH_OPTIONAL_BALANCED_MODEL, ...MONARCH_BALANCED_MODEL_ADDONS]),
  }),
  Object.freeze({
    role: 'qwen3.8-27b-pro',
    label: 'Pro 27B',
    summary: 'Медленно · максимум',
    beta: true,
    recommendedRamGb: 30,
    components: MONARCH_OPTIONAL_PRO_MODEL_COMPONENTS,
  }),
]);

export const MONARCH_EXTRA_COMPONENT_GROUPS: readonly ModelGroupDefinition[] = Object.freeze([
  Object.freeze({
    role: 'voice-recognition',
    kind: 'extra',
    label: 'Распознавание речи',
    summary: 'Голос',
    description: 'Нужно, чтобы Оскар понимал голос: диктовка, голосовой режим и голосовые из Telegram. Работает без интернета.',
    beta: false,
    recommendedRamGb: 0,
    components: MONARCH_VOICE_RECOGNITION_COMPONENTS,
  }),
  Object.freeze({
    role: 'memory-search',
    kind: 'extra',
    label: 'Умный поиск в памяти',
    summary: 'Память',
    description: 'Оскар находит нужные воспоминания по смыслу, а не только по точным словам.',
    beta: false,
    recommendedRamGb: 0,
    components: MONARCH_MEMORY_SEARCH_COMPONENTS,
  }),
  Object.freeze({
    role: 'coder',
    kind: 'extra',
    label: 'Модель Coder',
    summary: 'Coder',
    description: 'Основная модель режима Coder: пишет и правит код в твоих проектах.',
    beta: true,
    recommendedRamGb: 24,
    components: Object.freeze([MONARCH_CODER_MODEL_COMPONENTS[0]!]),
  }),
  Object.freeze({
    role: 'coder-backup',
    kind: 'extra',
    label: 'Запасная модель Coder',
    summary: 'Coder',
    description: 'Запасная модель Coder для компьютеров с меньшим объёмом памяти.',
    beta: true,
    recommendedRamGb: 16,
    components: Object.freeze([MONARCH_CODER_MODEL_COMPONENTS[1]!]),
  }),
]);

export class MonarchModelProvisioningManager implements MonarchModelProvisioningController {
  private readonly runtimePaths: MonarchRuntimePaths;
  private readonly groups: readonly ModelGroupDefinition[];
  private readonly extraGroups: readonly ModelGroupDefinition[];
  private readonly managers = new Map<string, MonarchModelComponentManager>();
  private readonly setupStatePath: string;
  private readonly now: () => Date;
  private readonly totalMemoryBytes: number;
  private readonly availableMemoryBytes: number;
  private persisted: PersistedModelSetupV2;
  private diskFreeBytes: number | null = null;
  private active: Promise<MonarchModelProvisioningSnapshot> | null = null;
  private activeInstall: MonarchModelProvisioningSnapshot['activeInstall'] = null;

  constructor(
    runtimePaths: MonarchRuntimePaths,
    options: MonarchModelProvisioningManagerOptions = {},
  ) {
    this.runtimePaths = runtimePaths;
    this.groups = (options.groups || MONARCH_MODEL_INSTALL_GROUPS).filter((group) => (group.kind || 'chat') === 'chat');
    this.extraGroups = options.extraGroups ?? (options.groups ? [] : MONARCH_EXTRA_COMPONENT_GROUPS);
    this.now = options.now || (() => new Date());
    this.totalMemoryBytes = options.totalMemoryBytes ?? os.totalmem();
    this.availableMemoryBytes = options.availableMemoryBytes ?? os.freemem();
    this.setupStatePath = path.join(runtimePaths.stateRoot, 'components', 'model-setup.v1.json');
    this.persisted = this.defaultPersistedState();

    for (const group of [...this.groups, ...this.extraGroups]) {
      for (const spec of group.components) {
        if (this.managers.has(spec.id)) continue;
        const workerOptions: MonarchModelComponentManagerOptions = {
          spec,
          autoRepairEnabled: false,
          required: false,
          stateFileName: `${spec.id}.v1.json`,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.extractArchiveImpl ? { extractArchiveImpl: options.extractArchiveImpl } : {}),
        };
        this.managers.set(spec.id, new MonarchModelComponentManager(runtimePaths, workerOptions));
      }
    }
  }

  async initialize(): Promise<MonarchModelProvisioningSnapshot> {
    this.persisted = await this.readPersistedState();
    await mkdir(this.runtimePaths.modelsRoot, { recursive: true });
    for (const manager of this.managers.values()) {
      await manager.inspectInstalled();
    }
    this.diskFreeBytes = await readDiskFreeBytes(this.runtimePaths.modelsRoot);

    const hasInstalledTextModel = this.models().some((model) => model.installed);
    if (this.runtimePaths.mode !== 'installed') {
      this.persisted = {
        ...this.persisted,
        completed: true,
        completion: 'not-applicable',
        welcomeAcknowledged: true,
        error: null,
      };
    } else if (!this.persisted.completed && this.persisted.selectedRoles.length === 0 && hasInstalledTextModel) {
      this.persisted = {
        ...this.persisted,
        completed: true,
        completion: 'adopted',
        welcomeAcknowledged: true,
        selectedRoles: this.models().filter((model) => model.installed).map((model) => model.role).filter(isChatRole),
        error: null,
        updatedAt: this.now().toISOString(),
      };
      await this.persistState();
    }

    if (
      this.runtimePaths.mode === 'installed'
      && !this.persisted.completed
      && this.persisted.selectedRoles.length > 0
    ) {
      runInBackground('model-install-resume', this.installModels(this.persisted.selectedRoles, 'onboarding'));
    }
    return this.snapshot();
  }

  snapshot(): MonarchModelProvisioningSnapshot {
    const models = this.models();
    const recommendedRole = this.recommendedRole();
    const requiredModel = (
      models.find((model) => model.role === recommendedRole)?.components[0]
      || models[0]?.components[0]
      || emptyFallbackComponent()
    );
    return Object.freeze({
      schemaVersion: 2,
      autoRepairEnabled: false,
      ready: models.some((model) => model.installed),
      requiredModel: Object.freeze({ ...requiredModel }),
      models: Object.freeze(models.map(freezeProvisionedModel)),
      extras: Object.freeze(this.extras().map(freezeProvisionedModel)),
      onboarding: Object.freeze({
        required: this.runtimePaths.mode === 'installed' && !this.persisted.completed,
        completed: this.persisted.completed,
        completion: this.persisted.completion,
        welcomeRequired: this.runtimePaths.mode === 'installed'
          && this.persisted.completed
          && !this.persisted.welcomeAcknowledged
          && ['installed', 'skipped'].includes(this.persisted.completion),
        welcomeToken: ['installed', 'skipped'].includes(this.persisted.completion)
          ? `${this.persisted.completion}:${this.persisted.updatedAt}`
          : null,
        recommendedRole,
        selectedRoles: Object.freeze([...this.persisted.selectedRoles]),
        hardware: Object.freeze(this.hardwareRecommendation(recommendedRole)),
        error: this.persisted.error,
      }),
      activeInstall: this.activeInstall
        ? Object.freeze({ ...this.activeInstall, roles: Object.freeze([...this.activeInstall.roles]) })
        : null,
    }) as MonarchModelProvisioningSnapshot;
  }

  startAutomaticRepair(): void {
    // First-run download requires an explicit owner selection. Pending, already
    // selected downloads are resumed by initialize().
  }

  ensureRequiredModel(): Promise<MonarchModelProvisioningSnapshot> {
    return this.installModels([this.recommendedRole()], 'onboarding');
  }

  startInstallModels(
    roles: MonarchInstallableGroupId[],
    source: 'onboarding' | 'settings',
  ): MonarchModelProvisioningSnapshot {
    runInBackground('model-install', this.installModels(roles, source));
    return this.snapshot();
  }

  async skipOnboarding(): Promise<MonarchModelProvisioningSnapshot> {
    if (this.runtimePaths.mode !== 'installed' || this.persisted.completed) return this.snapshot();
    if (this.active) throw new Error('model-install-active');
    this.persisted = {
      schemaVersion: 2,
      completed: true,
      completion: 'skipped',
      welcomeAcknowledged: false,
      selectedRoles: [],
      error: null,
      updatedAt: this.now().toISOString(),
    };
    await this.persistState();
    return this.snapshot();
  }

  async acknowledgeOnboardingWelcome(): Promise<MonarchModelProvisioningSnapshot> {
    if (!this.persisted.completed || this.persisted.welcomeAcknowledged) return this.snapshot();
    this.persisted = {
      ...this.persisted,
      welcomeAcknowledged: true,
      updatedAt: this.now().toISOString(),
    };
    await this.persistState();
    return this.snapshot();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.stop()));
    await this.active?.catch(() => undefined);
  }

  private installModels(
    rolesInput: MonarchInstallableGroupId[],
    source: 'onboarding' | 'settings',
  ): Promise<MonarchModelProvisioningSnapshot> {
    // First setup offers chat tiers only; the extras are always a separate, explicit choice.
    const roles = normalizeRoles(rolesInput, source === 'onboarding' ? this.groups : [...this.groups, ...this.extraGroups]);
    if (roles.length === 0) return Promise.resolve(this.snapshot());
    if (this.active) {
      // A download started while another runs joins the queue: runInstall walks
      // this same array, so roles appended here are fetched after the current one.
      if (source === 'settings' && this.activeInstall) {
        for (const role of roles) {
          if (!this.activeInstall.roles.includes(role)) this.activeInstall.roles.push(role);
        }
      }
      return this.active;
    }
    this.activeInstall = { source, roles };
    this.active = this.runInstall(roles, source)
      .finally(() => {
        this.active = null;
        this.activeInstall = null;
      });
    return this.active;
  }

  private async runInstall(
    roles: MonarchInstallableGroupId[],
    source: 'onboarding' | 'settings',
  ): Promise<MonarchModelProvisioningSnapshot> {
    if (source === 'onboarding') {
      this.persisted = {
        schemaVersion: 2,
        completed: false,
        completion: 'pending',
        welcomeAcknowledged: false,
        selectedRoles: normalizeRoles(roles, this.groups) as MonarchInstallableModelRole[],
        error: null,
        updatedAt: this.now().toISOString(),
      };
      await this.persistState();
    } else if (this.persisted.error !== null) {
      this.persisted = {
        ...this.persisted,
        error: null,
        updatedAt: this.now().toISOString(),
      };
      await this.persistState();
    }

    for (const role of roles) {
      const group = [...this.groups, ...this.extraGroups].find((candidate) => candidate.role === role)!;
      for (const spec of group.components) {
        const result = await this.managers.get(spec.id)!.ensureRequiredModel();
        if (result.ready) continue;
        this.persisted = {
          ...this.persisted,
          error: result.requiredModel.error || 'Не удалось скачать модель. Попробуй ещё раз.',
          updatedAt: this.now().toISOString(),
        };
        await this.persistState();
        if (source === 'onboarding') return this.snapshot();
        break; // From Settings the card shows the error and queued downloads still run.
      }
    }

    if (source === 'onboarding') {
      this.persisted = {
        ...this.persisted,
        completed: true,
        completion: 'installed',
        welcomeAcknowledged: false,
        error: null,
        updatedAt: this.now().toISOString(),
      };
      await this.persistState();
    }
    return this.snapshot();
  }

  private models(): MonarchProvisionedModel[] {
    return this.groups.map((group) => this.describeGroup(group));
  }

  private extras(): MonarchProvisionedModel[] {
    return this.extraGroups.map((group) => this.describeGroup(group));
  }

  private describeGroup(group: ModelGroupDefinition): MonarchProvisionedModel {
    const kind = group.kind || 'chat';
    const components = group.components.map((spec) => this.managers.get(spec.id)!.snapshot().requiredModel);
    const expectedBytes = components.reduce((sum, component) => sum + component.expectedBytes, 0);
    const downloadedBytes = components.reduce((sum, component) => sum + component.downloadedBytes, 0);
    const textComponent = components[0]!;
    const complete = components.every((component) => component.phase === 'ready');
    const failed = components.find((component) => component.phase === 'failed');
    const active = components.find((component) => ['checking', 'downloading', 'verifying'].includes(component.phase));
    const warning = this.warningForGroup(group);
    return {
      role: group.role,
      kind,
      label: group.label,
      summary: group.summary,
      description: group.description || null,
      beta: group.beta,
      recommendedRamGb: group.recommendedRamGb,
      // A chat tier answers once its text model is in place; an extra needs every file.
      installed: kind === 'chat' ? textComponent.phase === 'ready' : complete,
      complete,
      phase: failed?.phase || active?.phase || (complete ? 'ready' : 'idle'),
      expectedBytes,
      downloadedBytes,
      progress: expectedBytes > 0 ? downloadedBytes / expectedBytes : 0,
      warning,
      manualInstall: group.components
        .filter((spec) => !spec.extract)
        .map((spec) => manualInstallFile(spec, this.runtimePaths)),
      components,
    };
  }

  private recommendedRole(): MonarchInstallableModelRole {
    const ramGb = bytesToGb(Math.min(this.totalMemoryBytes, this.availableMemoryBytes));
    const preferred = [...this.groups]
      .filter((group) => ramGb >= group.recommendedRamGb)
      .sort((left, right) => right.recommendedRamGb - left.recommendedRamGb);
    for (const group of preferred) {
      if (!isChatRole(group.role)) continue;
      const expectedBytes = group.components.reduce((sum, spec) => sum + spec.expectedBytes, 0);
      if (this.diskFreeBytes === null || this.diskFreeBytes >= expectedBytes + 512 * 1024 * 1024) {
        return group.role as MonarchInstallableModelRole;
      }
    }
    return 'gemma4-fast';
  }

  private hardwareRecommendation(
    recommendedRole: MonarchInstallableModelRole,
  ): MonarchModelHardwareRecommendation {
    return {
      ramTotalGb: roundOne(bytesToGb(this.totalMemoryBytes)),
      ramAvailableGb: roundOne(bytesToGb(this.availableMemoryBytes)),
      diskFreeBytes: this.diskFreeBytes,
      recommendedRole,
    };
  }

  private warningForGroup(group: ModelGroupDefinition): string | null {
    const ramGb = bytesToGb(this.totalMemoryBytes);
    if (ramGb < group.recommendedRamGb) {
      return `На этом компьютере модель может работать медленнее.`;
    }
    if (bytesToGb(this.availableMemoryBytes) < group.recommendedRamGb) {
      return `Сейчас свободно меньше ${group.recommendedRamGb} ГБ памяти. Закрой другие приложения перед запуском.`;
    }
    const expectedBytes = group.components.reduce((sum, spec) => sum + spec.expectedBytes, 0);
    if (this.diskFreeBytes !== null && this.diskFreeBytes < expectedBytes + 512 * 1024 * 1024) {
      return 'Для загрузки нужно освободить место.';
    }
    return null;
  }

  private defaultPersistedState(): PersistedModelSetupV2 {
    const installed = this.runtimePaths.mode === 'installed';
    return {
      schemaVersion: 2,
      completed: !installed,
      completion: installed ? 'pending' : 'not-applicable',
      welcomeAcknowledged: !installed,
      selectedRoles: [],
      error: null,
      updatedAt: this.now().toISOString(),
    };
  }

  private async readPersistedState(): Promise<PersistedModelSetupV2> {
    try {
      const parsed = JSON.parse(await readFile(this.setupStatePath, 'utf8')) as Record<string, unknown>;
      if (parsed.schemaVersion === 1) {
        const completed = parsed.completed === true;
        return {
          schemaVersion: 2,
          completed,
          completion: completed ? 'adopted' : 'pending',
          welcomeAcknowledged: completed,
          selectedRoles: normalizeRoles(Array.isArray(parsed.selectedRoles) ? parsed.selectedRoles : [], this.groups) as MonarchInstallableModelRole[],
          error: typeof parsed.error === 'string' ? parsed.error : null,
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : this.now().toISOString(),
        };
      }
      if (parsed.schemaVersion !== 2) return this.defaultPersistedState();
      const completed = parsed.completed === true;
      const completion = normalizeOnboardingCompletion(parsed.completion, completed);
      return {
        schemaVersion: 2,
        completed,
        completion,
        welcomeAcknowledged: parsed.welcomeAcknowledged === true,
        selectedRoles: normalizeRoles(Array.isArray(parsed.selectedRoles) ? parsed.selectedRoles : [], this.groups) as MonarchInstallableModelRole[],
        error: typeof parsed.error === 'string' ? parsed.error : null,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : this.now().toISOString(),
      };
    } catch {
      return this.defaultPersistedState();
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(path.dirname(this.setupStatePath), { recursive: true });
    await writeFile(this.setupStatePath, JSON.stringify(this.persisted, null, 2), 'utf8');
  }
}

function normalizeRoles(
  input: readonly unknown[],
  groups: readonly ModelGroupDefinition[],
): MonarchInstallableGroupId[] {
  const allowed = new Set<string>(groups.map((group) => group.role));
  return [...new Set(input.map((value) => String(value).trim()))]
    .filter((value): value is MonarchInstallableGroupId => allowed.has(value));
}

const CHAT_ROLES: ReadonlySet<string> = new Set(['gemma4-fast', 'gemma4-balanced', 'qwen3.8-27b-pro']);

function isChatRole(value: string): value is MonarchInstallableModelRole {
  return CHAT_ROLES.has(value);
}

function freezeProvisionedModel(model: MonarchProvisionedModel): MonarchProvisionedModel {
  return Object.freeze({
    ...model,
    manualInstall: Object.freeze(model.manualInstall.map((file) => Object.freeze({ ...file }))),
    components: Object.freeze(model.components.map((component) => Object.freeze({ ...component }))),
  }) as MonarchProvisionedModel;
}

function normalizeOnboardingCompletion(
  value: unknown,
  completed: boolean,
): MonarchModelOnboardingCompletion {
  const allowed = new Set<MonarchModelOnboardingCompletion>([
    'pending',
    'installed',
    'skipped',
    'adopted',
    'not-applicable',
  ]);
  const normalized = String(value || '') as MonarchModelOnboardingCompletion;
  if (allowed.has(normalized)) return normalized;
  return completed ? 'adopted' : 'pending';
}

function manualInstallFile(spec: MonarchModelComponentSpec, runtimePaths: MonarchRuntimePaths): MonarchManualModelInstallFile {
  const repository = spec.repository.split('/').map(encodeURIComponent).join('/');
  const remoteFile = spec.remoteFile.split('/').map(encodeURIComponent).join('/');
  const relativePath = mapLogicalModelPath(runtimePaths, spec.relativePath);
  return {
    fileName: path.posix.basename(relativePath),
    directory: path.posix.dirname(relativePath),
    url: spec.sourceUrl || `https://huggingface.co/${repository}/resolve/${spec.revision}/${remoteFile}`,
  };
}

async function readDiskFreeBytes(modelsRoot: string): Promise<number | null> {
  try {
    const disk = await statfs(modelsRoot);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    return Number.isFinite(freeBytes) ? freeBytes : null;
  } catch {
    return null;
  }
}

function bytesToGb(value: number): number {
  return Math.max(0, value) / (1024 ** 3);
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function emptyFallbackComponent(): MonarchManagedModelComponent {
  return {
    id: 'model.unavailable',
    role: 'gemma4-fast',
    label: 'Basic 2B',
    required: false,
    phase: 'idle',
    provider: '',
    license: '',
    relativePath: '',
    expectedBytes: 0,
    downloadedBytes: 0,
    progress: 0,
    sha256: '',
    error: null,
    errorCode: null,
    updatedAt: new Date(0).toISOString(),
  };
}
