import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { MonarchRuntimePaths } from '../../core/runtime-paths';

export type MonarchComponentPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'failed';

export interface MonarchManagedModelComponent {
  id: string;
  role: 'gemma4-fast' | 'gemma4-balanced' | 'qwen3.8-27b-pro';
  label: string;
  required: boolean;
  phase: MonarchComponentPhase;
  provider: string;
  license: string;
  relativePath: string;
  expectedBytes: number;
  downloadedBytes: number;
  progress: number;
  sha256: string;
  error: string | null;
  errorCode: string | null;
  updatedAt: string;
}

export interface MonarchComponentManagerSnapshot {
  schemaVersion: 1;
  autoRepairEnabled: boolean;
  ready: boolean;
  requiredModel: MonarchManagedModelComponent;
  legacyQuarantine?: {
    detected: boolean;
    action: 'none' | 'manual-review';
  };
}

export interface MonarchModelComponentSpec {
  id: string;
  role: 'gemma4-fast' | 'gemma4-balanced' | 'qwen3.8-27b-pro';
  label: string;
  provider: string;
  license: string;
  revision: string;
  repository: string;
  remoteFile: string;
  relativePath: string;
  expectedBytes: number;
  sha256: string;
  acceptedExistingVariants?: readonly MonarchModelComponentVariant[];
}

export interface MonarchModelComponentVariant {
  revision: string;
  expectedBytes: number;
  sha256: string;
}

export interface MonarchModelComponentManagerOptions {
  spec?: MonarchModelComponentSpec;
  fetchImpl?: typeof fetch;
  systemDownloadImpl?: MonarchSystemModelDownloader | null;
  downloadStallTimeoutMs?: number;
  autoRepairEnabled?: boolean;
  required?: boolean;
  stateFileName?: string;
  retryDelaysMs?: number[];
  now?: () => Date;
}

export interface MonarchSystemModelDownloadRequest {
  url: string;
  offset: number;
  signal: AbortSignal;
  onChunk: (chunk: Uint8Array) => Promise<void>;
}

export type MonarchSystemModelDownloader = (
  request: MonarchSystemModelDownloadRequest,
) => Promise<void>;

export const MONARCH_REQUIRED_FAST_MODEL: MonarchModelComponentSpec = Object.freeze({
  id: 'model.gemma4-fast.text',
  role: 'gemma4-fast',
  label: 'Gemma 4 Fast',
  provider: 'Hugging Face · Unsloth',
  license: 'Apache-2.0',
  revision: '0314792d7f1f7e229411f620751375812bb9faf2',
  repository: 'unsloth/gemma-4-E2B-it-GGUF',
  remoteFile: 'gemma-4-E2B-it-Q5_K_M.gguf',
  relativePath: 'gemma_models/Gemma_E2B/gemma-4-E2B-it-Q5_K_M.gguf',
  expectedBytes: 3_356_037_216,
  sha256: '90293b8cdaf9c973012bf4df8a1e92bde7d74ad66a4fe56cf905ccd563d660c5',
  acceptedExistingVariants: Object.freeze([
    Object.freeze({
      revision: '739965d73654c0ead8020786aa998fc813070087',
      expectedBytes: 3_356_035_200,
      sha256: 'd8fc2ac6fd597481dfd9c5ef9543ea1f0bda8088086da3853ce5e5564ab43bf8',
    }),
  ]),
});

export const MONARCH_OPTIONAL_BALANCED_MODEL: MonarchModelComponentSpec = Object.freeze({
  id: 'model.gemma4-balanced.text',
  role: 'gemma4-balanced',
  label: 'Gemma 4 Balanced',
  provider: 'Hugging Face · Unsloth',
  license: 'Apache-2.0',
  revision: '52268a3069f9ba83031088c5ac10e704d3ab7047',
  repository: 'unsloth/gemma-4-12b-it-GGUF',
  remoteFile: 'gemma-4-12b-it-Q4_K_M.gguf',
  relativePath: 'gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf',
  expectedBytes: 7_662_531_872,
  sha256: 'd333b368be6cd655563fce18aede26027e208fdb13816d35eb06983ce054044b',
});

/**
 * Pinned Pro payloads are deliberately opt-in. Importing or starting Monarch
 * must never trigger this ~21.3 GB download; the owner-facing model manager
 * can install the exact immutable components when Pro is selected.
 */
export const MONARCH_OPTIONAL_PRO_MODEL_COMPONENTS: readonly MonarchModelComponentSpec[] = Object.freeze([
  Object.freeze({
    id: 'model.qwen3.8-27b-pro.text',
    role: 'qwen3.8-27b-pro',
    label: 'Qwen3.8 27B Pro',
    provider: 'Hugging Face · ggml-org',
    license: 'Apache-2.0',
    revision: '0669b98607d47046c7c2b3f801011d54a08cfccf',
    repository: 'ggml-org/Qwen3.8-27B-GGUF',
    remoteFile: 'Qwen3.8-27B-Q4_K_M.gguf',
    relativePath: 'qwen_models/Qwen3.8_27B/Qwen3.8-27B-Q4_K_M.gguf',
    expectedBytes: 18_973_870_432,
    sha256: '31629f53165ab6a7dad8c9847dcfd1fdf55829dac1e6e748f4a68581b0033d34',
  }),
  Object.freeze({
    id: 'model.qwen3.8-27b-pro.mtp',
    role: 'qwen3.8-27b-pro',
    label: 'Qwen3.8 27B Pro MTP',
    provider: 'Hugging Face · ggml-org',
    license: 'Apache-2.0',
    revision: '0669b98607d47046c7c2b3f801011d54a08cfccf',
    repository: 'ggml-org/Qwen3.8-27B-GGUF',
    remoteFile: 'mtp-Qwen3.8-27B-Q4_0.gguf',
    relativePath: 'qwen_models/Qwen3.8_27B/mtp-Qwen3.8-27B-Q4_0.gguf',
    expectedBytes: 1_680_271_648,
    sha256: '051a1764cff8c4f3ee6ae8b00593a0364c7539c67fa50ffc58f3f96509fca38e',
  }),
  Object.freeze({
    id: 'model.qwen3.8-27b-pro.vision',
    role: 'qwen3.8-27b-pro',
    label: 'Qwen3.8 27B Pro Vision',
    provider: 'Hugging Face · ggml-org',
    license: 'Apache-2.0',
    revision: '0669b98607d47046c7c2b3f801011d54a08cfccf',
    repository: 'ggml-org/Qwen3.8-27B-GGUF',
    remoteFile: 'mmproj-Qwen3.8-27B-Q8_0.gguf',
    relativePath: 'qwen_models/Qwen3.8_27B/mmproj-Qwen3.8-27B-Q8_0.gguf',
    expectedBytes: 629_247_008,
    sha256: '2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb',
  }),
]);

export class MonarchModelComponentManager {
  private readonly spec: MonarchModelComponentSpec;
  private readonly fetchImpl: typeof fetch;
  private readonly systemDownloadImpl: MonarchSystemModelDownloader | null;
  private readonly downloadStallTimeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly now: () => Date;
  private readonly modelsRoot: string;
  private readonly targetPath: string;
  private readonly partialPath: string;
  private readonly statePath: string;
  private readonly quarantineRoot: string;
  private readonly quarantinePayloadPath: string;
  private readonly legacyQuarantineRoot: string;
  private readonly autoRepairEnabled: boolean;
  private readonly required: boolean;
  private active: Promise<MonarchComponentManagerSnapshot> | null = null;
  private controller: AbortController | null = null;
  private state: MonarchManagedModelComponent;
  private legacyQuarantineDetected = false;
  private systemTransportPreferred = false;

  constructor(
    runtimePaths: MonarchRuntimePaths,
    options: MonarchModelComponentManagerOptions = {},
  ) {
    this.spec = options.spec || MONARCH_REQUIRED_FAST_MODEL;
    this.fetchImpl = options.fetchImpl || fetch;
    this.systemDownloadImpl = options.systemDownloadImpl !== undefined
      ? options.systemDownloadImpl
      : (!options.fetchImpl && runtimePaths.mode === 'installed' && process.platform === 'win32'
          ? downloadWithWindowsCurl
          : null);
    this.downloadStallTimeoutMs = Math.max(25, options.downloadStallTimeoutMs ?? 30_000);
    this.retryDelaysMs = options.retryDelaysMs || [0, 1_000, 5_000];
    this.now = options.now || (() => new Date());
    this.autoRepairEnabled = options.autoRepairEnabled
      ?? (runtimePaths.mode === 'installed' && process.env.MONARCH_COMPONENT_AUTO_REPAIR !== '0');
    this.required = options.required ?? true;
    this.modelsRoot = path.resolve(runtimePaths.modelsRoot);
    this.targetPath = resolveManagedModelPath(this.modelsRoot, this.spec.relativePath);
    this.partialPath = `${this.targetPath}.monarch-download`;
    const stateFileName = options.stateFileName || 'models.v1.json';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(stateFileName)) {
      throw new Error('model-component-state-file-invalid');
    }
    this.statePath = path.join(runtimePaths.stateRoot, 'components', stateFileName);
    this.quarantineRoot = resolveManagedQuarantineRoot(this.modelsRoot, this.spec.id);
    this.quarantinePayloadPath = path.join(
      this.quarantineRoot,
      quarantinePayloadName(this.spec),
    );
    this.legacyQuarantineRoot = path.resolve(
      runtimePaths.stateRoot,
      'components',
      'quarantine',
    );
    this.state = this.createState('idle');
  }

  snapshot(): MonarchComponentManagerSnapshot {
    return Object.freeze({
      schemaVersion: 1,
      autoRepairEnabled: this.autoRepairEnabled,
      ready: this.state.phase === 'ready',
      requiredModel: Object.freeze({ ...this.state }),
      legacyQuarantine: Object.freeze({
        detected: this.legacyQuarantineDetected,
        action: this.legacyQuarantineDetected ? 'manual-review' : 'none',
      }),
    });
  }

  startAutomaticRepair(): void {
    if (!this.autoRepairEnabled) return;
    void this.ensureRequiredModel();
  }

  ensureRequiredModel(): Promise<MonarchComponentManagerSnapshot> {
    if (this.active) return this.active;
    this.controller = new AbortController();
    this.active = this.ensureWithRetries(this.controller.signal)
      .finally(() => {
        this.active = null;
        this.controller = null;
      });
    return this.active;
  }

  async inspectInstalled(): Promise<MonarchComponentManagerSnapshot> {
    if (this.active) return this.active;
    this.legacyQuarantineDetected = await containsLegacyQuarantineEntries(
      this.legacyQuarantineRoot,
    );
    const present = await hasExpectedGgufEnvelope(this.modelsRoot, this.targetPath, this.spec);
    await this.updateState(present
      ? {
        phase: 'ready',
        downloadedBytes: this.spec.expectedBytes,
        progress: 1,
        error: null,
        errorCode: null,
      }
      : {
        phase: 'idle',
        downloadedBytes: Math.max(0, await managedFileSize(this.modelsRoot, this.partialPath)),
        progress: 0,
        error: null,
        errorCode: null,
      });
    return this.snapshot();
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.controller?.abort();
    if (active) {
      await active.catch(() => undefined);
    }
  }

  private async ensureWithRetries(signal: AbortSignal): Promise<MonarchComponentManagerSnapshot> {
    let lastError: unknown = null;
    for (const delayMs of this.retryDelaysMs) {
      if (delayMs > 0) await delay(delayMs, signal);
      try {
        await this.ensureOnce(signal);
        return this.snapshot();
      } catch (error) {
        lastError = error;
        if (signal.aborted || isDeterministicComponentFailure(error)) break;
      }
    }
    const message = signal.aborted
      ? 'Установка обязательной модели остановлена.'
      : userFacingComponentError(lastError);
    await this.updateState({
      phase: 'failed',
      error: message,
      errorCode: componentErrorCode(lastError),
    });
    return this.snapshot();
  }

  private async ensureOnce(signal: AbortSignal): Promise<void> {
    this.legacyQuarantineDetected = await containsLegacyQuarantineEntries(
      this.legacyQuarantineRoot,
    );
    await this.updateState({ phase: 'checking', error: null, errorCode: null });
    await ensurePhysicalDirectoryInside(
      this.modelsRoot,
      path.dirname(this.targetPath),
      'model-component-target-ancestor-reparse-point',
    );
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.targetPath,
      'model-component-target-reparse-point',
    );
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.partialPath,
      'model-component-partial-reparse-point',
    );

    if (await verifyFile(this.modelsRoot, this.targetPath, this.spec)) {
      await this.updateState({
        phase: 'ready',
        downloadedBytes: this.spec.expectedBytes,
        progress: 1,
        error: null,
      });
      return;
    }

    if (await this.hasQuarantineHold()) {
      throw new Error('model-component-quarantine-hold');
    }
    await this.quarantineInvalidTarget();
    let offset = Math.max(0, await managedFileSize(this.modelsRoot, this.partialPath));
    if (offset > this.spec.expectedBytes) {
      await this.quarantinePath(this.partialPath, 'oversized-partial');
      offset = 0;
    }
    if (offset === this.spec.expectedBytes) {
      await this.updateState({
        phase: 'verifying',
        downloadedBytes: offset,
        progress: 1,
        error: null,
        errorCode: null,
      });
      if (await verifyFile(this.modelsRoot, this.partialPath, this.spec)) {
        await assertPhysicalFileInside(
          this.modelsRoot,
          this.targetPath,
          'model-component-target-reparse-point',
        );
        await rename(this.partialPath, this.targetPath);
        await this.updateState({
          phase: 'ready',
          downloadedBytes: this.spec.expectedBytes,
          progress: 1,
          error: null,
          errorCode: null,
        });
        return;
      }
      await this.quarantinePath(this.partialPath, 'invalid-complete-partial');
      offset = 0;
    }
    await this.assertFreeSpace(offset);
    await this.download(offset, signal);

    await this.updateState({
      phase: 'verifying',
      downloadedBytes: this.spec.expectedBytes,
      progress: 1,
      error: null,
    });
    if (!await verifyFile(this.modelsRoot, this.partialPath, this.spec)) {
      await this.quarantinePath(this.partialPath, 'verification-failed');
      throw new Error('downloaded-model-verification-failed');
    }
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.targetPath,
      'model-component-target-reparse-point',
    );
    await rename(this.partialPath, this.targetPath);
    await this.updateState({
      phase: 'ready',
      downloadedBytes: this.spec.expectedBytes,
      progress: 1,
      error: null,
    });
  }

  private async download(initialOffset: number, signal: AbortSignal): Promise<void> {
    if (this.systemDownloadImpl && this.systemTransportPreferred) {
      await this.downloadWithSystemTransport(initialOffset, signal);
      return;
    }
    try {
      await this.downloadWithFetch(initialOffset, signal);
    } catch (error) {
      if (!this.systemDownloadImpl || !isModelDownloadStall(error) || signal.aborted) throw error;
      this.systemTransportPreferred = true;
      const resumedOffset = Math.max(0, await managedFileSize(this.modelsRoot, this.partialPath));
      if (resumedOffset > this.spec.expectedBytes) throw new Error('model-download-size-overflow');
      await this.downloadWithSystemTransport(resumedOffset, signal);
    }
  }

  private async downloadWithFetch(initialOffset: number, signal: AbortSignal): Promise<void> {
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.partialPath,
      'model-component-partial-reparse-point',
    );
    let offset = initialOffset;
    // Bind the scratch file before network I/O. A directory replaced with a
    // junction while fetch is pending must not redirect the response body to a
    // different volume/path. The second physical check happens after fetch and
    // before the first byte is written; writes themselves use this bound handle.
    const file = await open(this.partialPath, offset > 0 ? 'a' : 'w');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await assertPhysicalFileInside(
        this.modelsRoot,
        this.partialPath,
        'model-component-partial-reparse-point',
      );
      let response = await this.fetchModel(offset, signal);
      if (offset > 0 && response.status === 200) {
        await file.truncate(0);
        offset = 0;
        response = await this.fetchModel(0, signal);
      }
      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`model-download-http-${response.status}`);
      }
      if (offset > 0 && response.status !== 206) {
        throw new Error('model-download-resume-not-supported');
      }
      assertTrustedDownloadUrl(response.url);
      assertDownloadRange(response, offset, this.spec.expectedBytes);
      if (!response.body) throw new Error('model-download-empty-body');
      await assertPhysicalFileInside(
        this.modelsRoot,
        this.partialPath,
        'model-component-partial-reparse-point',
      );

      await this.updateState({
        phase: 'downloading',
        downloadedBytes: offset,
        progress: offset / this.spec.expectedBytes,
        error: null,
      });
      reader = response.body.getReader();
      let downloaded = offset;
      let lastPublished = offset;
      while (true) {
        if (signal.aborted) throw abortError();
        const chunk = await readModelChunk(reader, this.downloadStallTimeoutMs, signal);
        if (chunk.done) break;
        const bytes = Buffer.from(chunk.value);
        downloaded += bytes.length;
        if (downloaded > this.spec.expectedBytes) throw new Error('model-download-size-overflow');
        await file.write(bytes);
        if (downloaded - lastPublished >= 8 * 1024 * 1024 || downloaded === this.spec.expectedBytes) {
          lastPublished = downloaded;
          await this.updateState({
            phase: 'downloading',
            downloadedBytes: downloaded,
            progress: downloaded / this.spec.expectedBytes,
          });
        }
      }
      if (downloaded !== this.spec.expectedBytes) {
        throw new Error(`model-download-size-mismatch:${downloaded}:${this.spec.expectedBytes}`);
      }
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      throw error;
    } finally {
      await file.close();
      reader?.releaseLock();
    }
  }

  private async downloadWithSystemTransport(offset: number, signal: AbortSignal): Promise<void> {
    if (!this.systemDownloadImpl) throw new Error('model-download-system-transport-unavailable');
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.partialPath,
      'model-component-partial-reparse-point',
    );
    const file = await open(this.partialPath, offset > 0 ? 'a' : 'w');
    let downloaded = offset;
    let lastPublished = offset;
    try {
      await assertPhysicalFileInside(
        this.modelsRoot,
        this.partialPath,
        'model-component-partial-reparse-point',
      );
      await this.updateState({
        phase: 'downloading',
        downloadedBytes: offset,
        progress: offset / this.spec.expectedBytes,
        error: null,
      });
      await this.systemDownloadImpl({
        url: this.modelUrl(),
        offset,
        signal,
        onChunk: async (chunk) => {
          if (signal.aborted) throw abortError();
          const bytes = Buffer.from(chunk);
          downloaded += bytes.length;
          if (downloaded > this.spec.expectedBytes) throw new Error('model-download-size-overflow');
          await file.write(bytes);
          if (downloaded - lastPublished >= 8 * 1024 * 1024 || downloaded === this.spec.expectedBytes) {
            lastPublished = downloaded;
            await this.updateState({
              phase: 'downloading',
              downloadedBytes: downloaded,
              progress: downloaded / this.spec.expectedBytes,
            });
          }
        },
      });
      if (downloaded !== this.spec.expectedBytes) {
        throw new Error(`model-download-size-mismatch:${downloaded}:${this.spec.expectedBytes}`);
      }
    } finally {
      await file.close();
    }
  }

  private fetchModel(offset: number, signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.modelUrl(), {
      signal,
      redirect: 'follow',
      headers: {
        Accept: 'application/octet-stream',
        ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
      },
    });
  }

  private modelUrl(): string {
    const repository = this.spec.repository.split('/').map(encodeURIComponent).join('/');
    const file = this.spec.remoteFile.split('/').map(encodeURIComponent).join('/');
    return `https://huggingface.co/${repository}/resolve/${this.spec.revision}/${file}`;
  }

  private async assertFreeSpace(offset: number): Promise<void> {
    await ensurePhysicalDirectoryInside(
      this.modelsRoot,
      path.dirname(this.targetPath),
      'model-component-target-ancestor-reparse-point',
    );
    const disk = await statfs(path.dirname(this.targetPath));
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    const requiredBytes = Math.max(0, this.spec.expectedBytes - offset) + 256 * 1024 * 1024;
    if (Number.isFinite(freeBytes) && freeBytes < requiredBytes) {
      throw new Error(`model-download-insufficient-space:${requiredBytes}:${freeBytes}`);
    }
  }

  private async quarantineInvalidTarget(): Promise<void> {
    if (await managedFileSize(this.modelsRoot, this.targetPath) < 0) return;
    await this.quarantinePath(this.targetPath, 'invalid-installed-model');
  }

  private async quarantinePath(candidate: string, reason: string): Promise<void> {
    const resolvedCandidate = path.resolve(candidate);
    assertPathInside(this.modelsRoot, resolvedCandidate, 'model-component-candidate-outside-models-root');
    if (await managedFileSize(this.modelsRoot, resolvedCandidate) < 0) return;
    await ensurePhysicalDirectoryInside(
      this.modelsRoot,
      this.quarantineRoot,
      'model-quarantine-ancestor-reparse-point',
    );
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.quarantinePayloadPath,
      'model-quarantine-payload-reparse-point',
    );
    if (await managedFileSize(this.modelsRoot, this.quarantinePayloadPath) >= 0) {
      if (resolvedCandidate === path.resolve(this.partialPath)) {
        // This exact path is an application-owned download scratch file. Keep
        // the first forensic payload and discard only the duplicate scratch
        // copy so a bad immutable artifact cannot consume another model-sized
        // allocation in the same repair run.
        await unlink(resolvedCandidate);
      }
      throw new Error(`model-component-quarantine-cap-reached:${reason}`);
    }
    await rename(resolvedCandidate, this.quarantinePayloadPath);
  }

  private async hasQuarantineHold(): Promise<boolean> {
    await ensurePhysicalDirectoryInside(
      this.modelsRoot,
      this.quarantineRoot,
      'model-quarantine-ancestor-reparse-point',
    );
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.quarantinePayloadPath,
      'model-quarantine-payload-reparse-point',
    );
    return await managedFileSize(this.modelsRoot, this.quarantinePayloadPath) >= 0;
  }

  private createState(phase: MonarchComponentPhase): MonarchManagedModelComponent {
    return {
      id: this.spec.id,
      role: this.spec.role,
      label: this.spec.label,
      required: this.required,
      phase,
      provider: this.spec.provider,
      license: this.spec.license,
      relativePath: this.spec.relativePath,
      expectedBytes: this.spec.expectedBytes,
      downloadedBytes: 0,
      progress: 0,
      sha256: this.spec.sha256,
      error: null,
      errorCode: null,
      updatedAt: this.now().toISOString(),
    };
  }

  private async updateState(patch: Partial<MonarchManagedModelComponent>): Promise<void> {
    this.state = {
      ...this.state,
      ...patch,
      progress: clampProgress(patch.progress ?? this.state.progress),
      updatedAt: this.now().toISOString(),
    };
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.snapshot(), null, 2), 'utf8');
  }
}

function resolveManagedModelPath(modelsRoot: string, relativePath: string): string {
  const normalized = String(relativePath || '').replace(/\\/gu, '/').trim();
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/u.test(normalized)) {
    throw new Error('model-component-relative-path-invalid');
  }
  const candidate = path.resolve(modelsRoot, ...normalized.split('/'));
  assertPathInside(modelsRoot, candidate, 'model-component-path-outside-models-root');
  if (candidate.toLocaleLowerCase('en-US') === path.resolve(modelsRoot).toLocaleLowerCase('en-US')) {
    throw new Error('model-component-target-must-be-a-file');
  }
  return candidate;
}

function resolveManagedQuarantineRoot(modelsRoot: string, componentId: string): string {
  const normalizedId = String(componentId || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(normalizedId)) {
    throw new Error('model-component-id-invalid');
  }
  const quarantineRoot = path.resolve(modelsRoot, '.monarch-quarantine', normalizedId);
  assertPathInside(modelsRoot, quarantineRoot, 'model-quarantine-outside-models-root');
  return quarantineRoot;
}

function quarantinePayloadName(spec: MonarchModelComponentSpec): string {
  const basename = path.basename(spec.remoteFile).replace(/[^a-zA-Z0-9._-]/gu, '_');
  const revision = spec.revision.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 12) || 'unversioned';
  const digest = spec.sha256.toLowerCase().replace(/[^a-f0-9]/gu, '').slice(0, 16) || 'nohash';
  return `${basename}.${revision}.${digest}.quarantined`;
}

function assertPathInside(root: string, candidate: string, errorCode: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(errorCode);
  }
}

async function ensurePhysicalDirectoryInside(
  root: string,
  candidate: string,
  errorCode: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  assertPathInside(resolvedRoot, resolvedCandidate, errorCode);
  await mkdir(resolvedRoot, { recursive: true });
  const physicalRoot = await realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let value;
    try {
      value = await lstat(current);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      await mkdir(current);
      value = await lstat(current);
    }
    if (value.isSymbolicLink() || !value.isDirectory()) throw new Error(errorCode);
    const physicalCurrent = await realpath(current);
    assertPathInside(physicalRoot, physicalCurrent, errorCode);
  }
  assertPathInside(physicalRoot, await realpath(resolvedCandidate), errorCode);
}

async function assertPhysicalFileInside(
  root: string,
  candidate: string,
  errorCode: string,
): Promise<void> {
  const resolvedCandidate = path.resolve(candidate);
  assertPathInside(root, resolvedCandidate, errorCode);
  await ensurePhysicalDirectoryInside(root, path.dirname(resolvedCandidate), errorCode);
  try {
    const value = await lstat(resolvedCandidate);
    if (value.isSymbolicLink() || !value.isFile()) throw new Error(errorCode);
    const physicalRoot = await realpath(path.resolve(root));
    const physicalCandidate = await realpath(resolvedCandidate);
    assertPathInside(physicalRoot, physicalCandidate, errorCode);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

async function verifyFile(
  root: string,
  candidate: string,
  spec: MonarchModelComponentSpec,
): Promise<boolean> {
  const variant = await matchingComponentVariant(root, candidate, spec);
  if (!variant) return false;
  return await sha256File(candidate) === variant.sha256.toLowerCase();
}

async function hasExpectedGgufEnvelope(
  root: string,
  candidate: string,
  spec: MonarchModelComponentSpec,
): Promise<boolean> {
  if (!await matchingComponentVariant(root, candidate, spec)) return false;
  return true;
}

async function matchingComponentVariant(
  root: string,
  candidate: string,
  spec: MonarchModelComponentSpec,
): Promise<MonarchModelComponentVariant | null> {
  const size = await managedFileSize(root, candidate);
  const variant = componentVariants(spec).find((entry) => entry.expectedBytes === size) || null;
  if (!variant) return null;
  const file = await open(candidate, 'r');
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await file.read(magic, 0, 4, 0);
    if (bytesRead !== 4 || magic.toString('ascii') !== 'GGUF') return null;
  } finally {
    await file.close();
  }
  return variant;
}

function componentVariants(spec: MonarchModelComponentSpec): readonly MonarchModelComponentVariant[] {
  return [
    {
      revision: spec.revision,
      expectedBytes: spec.expectedBytes,
      sha256: spec.sha256,
    },
    ...(spec.acceptedExistingVariants || []),
  ];
}

async function sha256File(candidate: string): Promise<string> {
  const hash = createHash('sha256');
  const file = await open(candidate, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

async function managedFileSize(root: string, candidate: string): Promise<number> {
  await assertPhysicalFileInside(root, candidate, 'model-component-file-reparse-point');
  try {
    const value = await lstat(candidate);
    return value.isFile() ? value.size : -1;
  } catch (error) {
    if (isMissingFileError(error)) return -1;
    throw error;
  }
}

async function containsLegacyQuarantineEntries(candidate: string): Promise<boolean> {
  let value;
  try {
    value = await lstat(candidate);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  if (value.isSymbolicLink()) return true;
  if (!value.isDirectory()) return true;
  const directory = await opendir(candidate);
  try {
    return (await directory.read()) !== null;
  } finally {
    await directory.close();
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isDeterministicComponentFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /(?:verification|integrity|sha|size-(?:overflow|mismatch)|content-(?:range|length)-mismatch|untrusted-redirect|insufficient-space|quarantine-(?:hold|cap)|reparse-point|outside-models-root|relative-path-invalid|target-must-be-a-file)/iu.test(message)
    || /^EPERM:/u.test(message)
    || /^model-download-http-(?:40[0-7]|409|41[0-9]|42[0-8]|43[0-9]|44[0-9]|45[0-9]|46[0-9]|47[0-9]|48[0-9]|49[0-9])$/u.test(message);
}

function assertTrustedDownloadUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const trusted = host === 'huggingface.co'
    || host.endsWith('.huggingface.co')
    || host === 'cdn.hf.co'
    || host.endsWith('.cdn.hf.co')
    || host === 'xethub.hf.co'
    || host.endsWith('.xethub.hf.co');
  if (url.protocol !== 'https:' || !trusted) throw new Error('model-download-untrusted-redirect');
}

function assertDownloadRange(response: Response, offset: number, expectedBytes: number): void {
  if (response.status === 206) {
    const range = response.headers.get('content-range') || '';
    const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    if (!match || Number(match[1]) !== offset || Number(match[3]) !== expectedBytes) {
      throw new Error('model-download-content-range-mismatch');
    }
    return;
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (offset === 0 && length > 0 && length !== expectedBytes) {
    throw new Error('model-download-content-length-mismatch');
  }
}

function userFacingComponentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.startsWith('model-download-insufficient-space:')) {
    return 'Недостаточно места для обязательной локальной модели.';
  }
  if (/aborted/i.test(message)) return 'Установка обязательной модели остановлена.';
  if (/quarantine-(?:hold|cap)/i.test(message)) {
    return 'Автоповтор остановлен: одна проверочная копия сохранена рядом с моделями. Требуется ручная проверка.';
  }
  if (/reparse-point/i.test(message)) {
    return 'Установка остановлена: путь модели был небезопасно подменён ссылкой или junction.';
  }
  if (/verification|sha|size|range|redirect/i.test(message)) {
    return 'Загруженная модель не прошла проверку целостности. Monarch сохранил её отдельно и не активировал.';
  }
  return 'Monarch не смог установить обязательную локальную модель. Загрузка будет повторена.';
}

function componentErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'component-install-failed');
  return message.slice(0, 160);
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function abortError(): Error {
  const error = new Error('component-install-aborted');
  error.name = 'AbortError';
  return error;
}

function isModelDownloadStall(error: unknown): boolean {
  return error instanceof Error && error.message === 'model-download-stalled';
}

function readModelChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(
      () => finish(() => reject(new Error('model-download-stalled'))),
      timeoutMs,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (chunk) => finish(() => resolve(chunk)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function downloadWithWindowsCurl(request: MonarchSystemModelDownloadRequest): Promise<void> {
  const systemRoot = path.resolve(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
  const executable = path.join(systemRoot, 'System32', 'curl.exe');
  const args = [
    '--fail',
    '--location',
    '--max-redirs', '5',
    '--proto', '=https',
    '--proto-redir', '=https',
    '--connect-timeout', '20',
    '--speed-limit', '1024',
    '--speed-time', '30',
    '--silent',
    '--show-error',
    '--header', 'Accept: application/octet-stream',
    ...(request.offset > 0 ? ['--range', `${request.offset}-`] : []),
    request.url,
  ];
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.stdout) throw new Error('model-download-system-transport-stdout-unavailable');
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4_096) stderr += chunk.toString('utf8', 0, 4_096 - stderr.length);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const abort = () => child.kill();
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of child.stdout) {
      await request.onChunk(Uint8Array.from(chunk as Buffer));
    }
    const code = await exit;
    if (request.signal.aborted) throw abortError();
    if (code !== 0) {
      const suffix = stderr ? '-stderr' : '';
      throw new Error(`model-download-system-transport-${code ?? 'unknown'}${suffix}`);
    }
  } catch (error) {
    child.kill();
    await exit.catch(() => undefined);
    throw error;
  } finally {
    request.signal.removeEventListener('abort', abort);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}
