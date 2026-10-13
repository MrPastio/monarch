import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, opendir, realpath, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MonarchRuntimePaths } from '../../core/runtime-paths';
import { runInBackground } from '../../core/background-work';
import { renameWithWindowsRetry } from '../../core/durable-json-file';

export type MonarchComponentPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'failed';

/** Chat and Coder model roles plus the small helper packs Monarch installs itself. */
export type MonarchComponentRole = 'gemma4-fast' | 'gemma4-balanced' | 'qwen3.8-27b-pro'
  | 'qwen3-coder-30b-a3b-instruct' | 'deepseek-coder-v2-lite-instruct'
  | 'voice-recognition' | 'memory-search';

export interface MonarchManagedModelComponent {
  id: string;
  role: MonarchComponentRole;
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
  role: MonarchManagedModelComponent['role'];
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
  /** Exact https download address for files that are not on Hugging Face. */
  sourceUrl?: string;
  /** 'gguf' (default) also checks the GGUF header; 'file' trusts size and SHA-256 only. */
  format?: 'gguf' | 'file';
  /** A verified archive is unpacked here and removed; the payload is ready once the files exist. */
  extract?: MonarchComponentArchiveExtraction;
}

export interface MonarchComponentArchiveExtraction {
  /** Folder (relative to the models root) that the archive's single top folder becomes. */
  targetDirectory: string;
  /** Files (relative to targetDirectory) that must be present and non-empty. */
  requiredFiles: readonly string[];
  /** Pinned hashes of individual files inside the archive, checked after unpacking. */
  fileSha256?: Readonly<Record<string, string>>;
}

export type MonarchArchiveExtractor = (archivePath: string, destination: string, signal: AbortSignal) => Promise<void>;

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
  extractArchiveImpl?: MonarchArchiveExtractor;
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
  revision: 'fc034cfff751157913579611efad8462ac1be606',
  repository: 'unsloth/gemma-4-12b-it-GGUF',
  remoteFile: 'gemma-4-12b-it-Q4_K_M.gguf',
  relativePath: 'gemma_models/Gemma_12B/gemma-4-12B-it-Q4_K_M.gguf',
  expectedBytes: 7_121_861_440,
  sha256: '0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42',
  acceptedExistingVariants: Object.freeze([
    Object.freeze({
      revision: '52268a3069f9ba83031088c5ac10e704d3ab7047',
      expectedBytes: 7_662_531_872,
      sha256: 'd333b368be6cd655563fce18aede26027e208fdb13816d35eb06983ce054044b',
    }),
  ]),
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

/** Vision (image input) and speed-up files for the Basic tiers, fetched with the chat model. */
export const MONARCH_FAST_MODEL_ADDONS: readonly MonarchModelComponentSpec[] = Object.freeze([
  Object.freeze({
    id: 'model.gemma4-fast.vision',
    role: 'gemma4-fast',
    label: 'Gemma 4 Fast Vision',
    provider: 'Hugging Face · Unsloth',
    license: 'Apache-2.0',
    revision: '0314792d7f1f7e229411f620751375812bb9faf2',
    repository: 'unsloth/gemma-4-E2B-it-GGUF',
    remoteFile: 'mmproj-BF16.gguf',
    relativePath: 'gemma_models/vision_other/mmproj-BF16_E2B.gguf',
    expectedBytes: 986_833_728,
    sha256: 'a402f10fb5780bf91d03a10cd89061139f522bee2e679b1291bbfdcd71d9547d',
  }),
  Object.freeze({
    id: 'model.gemma4-fast.mtp',
    role: 'gemma4-fast',
    label: 'Gemma 4 Fast MTP',
    provider: 'Hugging Face · Unsloth',
    license: 'Apache-2.0',
    revision: '0314792d7f1f7e229411f620751375812bb9faf2',
    repository: 'unsloth/gemma-4-E2B-it-GGUF',
    remoteFile: 'mtp-gemma-4-E2B-it.gguf',
    relativePath: 'gemma_models/mtp_model/mtp-gemma-4-E2B-it.gguf',
    expectedBytes: 97_817_664,
    sha256: '9eba819938efccfd6044f8af84e3bbfddc639a2bcf32ebc36420e6a649191919',
  }),
]);

export const MONARCH_BALANCED_MODEL_ADDONS: readonly MonarchModelComponentSpec[] = Object.freeze([
  Object.freeze({
    id: 'model.gemma4-balanced.vision',
    role: 'gemma4-balanced',
    label: 'Gemma 4 Balanced Vision',
    provider: 'Hugging Face · Unsloth',
    license: 'Apache-2.0',
    revision: 'fc034cfff751157913579611efad8462ac1be606',
    repository: 'unsloth/gemma-4-12b-it-GGUF',
    remoteFile: 'mmproj-BF16.gguf',
    relativePath: 'gemma_models/vision_other/mmproj-BF16_12B.gguf',
    expectedBytes: 175_115_840,
    sha256: '2e269f906eb15169ee9ce880ea649bd6d42d4964c21f8ede10d0d0efc738bcbb',
  }),
  Object.freeze({
    id: 'model.gemma4-balanced.mtp',
    role: 'gemma4-balanced',
    label: 'Gemma 4 Balanced MTP',
    provider: 'Hugging Face · Unsloth',
    license: 'Apache-2.0',
    revision: 'fc034cfff751157913579611efad8462ac1be606',
    repository: 'unsloth/gemma-4-12b-it-GGUF',
    remoteFile: 'mtp-gemma-4-12b-it.gguf',
    relativePath: 'gemma_models/mtp_model/mtp-gemma-4-12b-it.gguf',
    expectedBytes: 465_109_248,
    sha256: '145db9094bc0f85f1701e255a2ed216dcc9800fc8bc8631ad00905b456bd451b',
  }),
]);

/**
 * Speech recognition for dictation, Voice and Telegram voice notes: the streaming
 * T-one model, the Vosk model for recordings and the ffmpeg build Vosk decodes with.
 * Same pinned archives as tools/setup-sherpa-t-one-stt.ps1 and setup-vosk-telegram-stt.ps1.
 */
export const MONARCH_VOICE_RECOGNITION_COMPONENTS: readonly MonarchModelComponentSpec[] = Object.freeze([
  Object.freeze({
    id: 'voice.recognition.t-one',
    role: 'voice-recognition',
    label: 'T-one (живое распознавание)',
    provider: 'GitHub · k2-fsa/sherpa-onnx',
    license: 'Apache-2.0',
    revision: '2025-09-08',
    repository: 'k2-fsa/sherpa-onnx',
    remoteFile: 'sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2',
    sourceUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2',
    relativePath: 'runtime/voice/models/.downloads/sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2',
    expectedBytes: 128_468_156,
    sha256: 'b9c907450e99a6e5049e279bf18368a17db0bdc5e63b7fa978943138debbe3ae',
    format: 'file',
    extract: Object.freeze({
      targetDirectory: 'runtime/voice/models/sherpa-onnx-streaming-t-one-russian-2025-09-08',
      requiredFiles: Object.freeze(['model.onnx', 'tokens.txt']),
    }),
  }),
  Object.freeze({
    id: 'voice.recognition.vosk-ru',
    role: 'voice-recognition',
    label: 'Vosk (распознавание записей)',
    provider: 'alphacephei.com',
    license: 'Apache-2.0',
    revision: '0.22',
    repository: 'alphacephei/vosk-models',
    remoteFile: 'vosk-model-small-ru-0.22.zip',
    sourceUrl: 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip',
    relativePath: 'runtime/voice/models/.downloads/vosk-model-small-ru-0.22.zip',
    expectedBytes: 46_236_750,
    sha256: '961d5ff98a17f4aa6de69864d0aa71fa5bac682301d2b5d17a3f24c5c99a46d4',
    format: 'file',
    extract: Object.freeze({
      targetDirectory: 'runtime/voice/models/vosk-model-small-ru-0.22',
      requiredFiles: Object.freeze(['am/final.mdl', 'conf/model.conf']),
    }),
  }),
  Object.freeze({
    id: 'voice.recognition.ffmpeg',
    role: 'voice-recognition',
    label: 'ffmpeg (чтение аудио)',
    provider: 'GitHub · GyanD/codexffmpeg',
    license: 'GPL-3.0',
    revision: '8.1.1',
    repository: 'GyanD/codexffmpeg',
    remoteFile: 'ffmpeg-8.1.1-essentials_build.zip',
    sourceUrl: 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip',
    relativePath: 'runtime/voice/models/.downloads/ffmpeg-8.1.1-essentials_build.zip',
    expectedBytes: 109_282_242,
    sha256: '6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541',
    format: 'file',
    extract: Object.freeze({
      targetDirectory: 'runtime/voice/models/ffmpeg-8.1.1-essentials_build',
      requiredFiles: Object.freeze(['bin/ffmpeg.exe']),
      fileSha256: Object.freeze({ 'bin/ffmpeg.exe': '228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb' }),
    }),
  }),
]);

/** Small multilingual model that ranks memories by meaning instead of exact words. */
export const MONARCH_MEMORY_SEARCH_COMPONENTS: readonly MonarchModelComponentSpec[] = Object.freeze([
  Object.freeze({
    id: 'memory.e5-small.onnx',
    role: 'memory-search',
    label: 'multilingual-e5-small',
    provider: 'Hugging Face · Xenova',
    license: 'MIT',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    repository: 'Xenova/multilingual-e5-small',
    remoteFile: 'onnx/model_quantized.onnx',
    relativePath: 'memory/multilingual-e5-small/onnx/model_quantized.onnx',
    expectedBytes: 118_308_185,
    sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    format: 'file',
  }),
  Object.freeze({
    id: 'memory.e5-small.tokenizer',
    role: 'memory-search',
    label: 'multilingual-e5-small tokenizer',
    provider: 'Hugging Face · Xenova',
    license: 'MIT',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    repository: 'Xenova/multilingual-e5-small',
    remoteFile: 'sentencepiece.bpe.model',
    relativePath: 'memory/multilingual-e5-small/sentencepiece.bpe.model',
    expectedBytes: 5_069_051,
    sha256: 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865',
    format: 'file',
  }),
]);

/** Exact Coder assets: the same-owner Astra V3 prepared host pins them, and the
 * Models page downloads them only when the user asks for Coder. */
export const MONARCH_CODER_MODEL_COMPONENTS: readonly MonarchModelComponentSpec[] = Object.freeze([
  Object.freeze({
    id: 'model.qwen3-coder-30b-a3b-instruct.text',
    role: 'qwen3-coder-30b-a3b-instruct',
    label: 'Qwen3 Coder Primary',
    provider: 'Hugging Face · Unsloth',
    license: 'Apache-2.0',
    revision: 'b17cb02dd882d5b6ab62fc777ad2995f19668350',
    repository: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    remoteFile: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
    relativePath: 'runtime/coder/models/qwen3-coder-30b-a3b-instruct/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
    expectedBytes: 18_556_689_568,
    sha256: 'fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad',
  }),
  Object.freeze({
    id: 'model.deepseek-coder-v2-lite-instruct.text',
    role: 'deepseek-coder-v2-lite-instruct',
    label: 'DeepSeek Coder Secondary',
    provider: 'Hugging Face · bartowski',
    license: 'DeepSeek Model License',
    revision: '8f248fa2072348f77a8bc37754e470de1f61866e',
    repository: 'bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF',
    remoteFile: 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    relativePath: 'runtime/coder/models/deepseek-coder-v2-lite-instruct/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    expectedBytes: 10_364_416_768,
    sha256: '603bd3f8a0281d16571da7c08bd661ee17ff0d1be6fcbd1b42242da257ef0bb8',
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
  private readonly extractArchiveImpl: MonarchArchiveExtractor;
  private readonly extractTargetPath: string | null;
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
    this.targetPath = resolveManagedModelPath(this.modelsRoot, mapLogicalModelPath(runtimePaths, this.spec.relativePath));
    this.extractArchiveImpl = options.extractArchiveImpl || extractArchiveWithSystemTar;
    this.extractTargetPath = this.spec.extract
      ? resolveManagedModelPath(this.modelsRoot, mapLogicalModelPath(runtimePaths, this.spec.extract.targetDirectory))
      : null;
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
    runInBackground('model-auto-repair', this.ensureRequiredModel());
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
    const present = this.spec.extract
      ? await this.extractedPayloadReady()
      : await hasExpectedGgufEnvelope(this.modelsRoot, this.targetPath, this.spec);
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
      ? 'Загрузка остановлена.'
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

    if (this.spec.extract && await this.extractedPayloadReady()) {
      await this.markReady();
      return;
    }
    if (await verifyFile(this.modelsRoot, this.targetPath, this.spec)) {
      if (this.spec.extract) {
        await this.installVerifiedArchive(this.targetPath, signal);
        return;
      }
      await this.markReady();
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
        await this.activateVerifiedDownload(signal);
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
    await this.activateVerifiedDownload(signal);
  }

  private async activateVerifiedDownload(signal: AbortSignal): Promise<void> {
    await assertPhysicalFileInside(
      this.modelsRoot,
      this.targetPath,
      'model-component-target-reparse-point',
    );
    await renameWithWindowsRetry(this.partialPath, this.targetPath);
    if (this.spec.extract) {
      await this.installVerifiedArchive(this.targetPath, signal);
      return;
    }
    await this.markReady();
  }

  private async markReady(): Promise<void> {
    await this.updateState({
      phase: 'ready',
      downloadedBytes: this.spec.expectedBytes,
      progress: 1,
      error: null,
      errorCode: null,
    });
  }

  /** True when every required file of an unpacked archive is present and non-empty. */
  private async extractedPayloadReady(): Promise<boolean> {
    const extract = this.spec.extract;
    const target = this.extractTargetPath;
    if (!extract || !target) return false;
    for (const relative of extract.requiredFiles) {
      if (!await isNonEmptyRegularFile(resolveManagedModelPath(target, relative))) return false;
    }
    return true;
  }

  /**
   * Unpack a SHA-256 verified archive next to its final folder, check the expected
   * files, then move the single top folder into place. The archive is removed after.
   */
  private async installVerifiedArchive(archivePath: string, signal: AbortSignal): Promise<void> {
    const extract = this.spec.extract!;
    const target = this.extractTargetPath!;
    await this.updateState({ phase: 'verifying', downloadedBytes: this.spec.expectedBytes, progress: 1, error: null });
    const parent = path.dirname(target);
    await ensurePhysicalDirectoryInside(this.modelsRoot, parent, 'model-component-target-ancestor-reparse-point');
    const staging = path.join(parent, `.monarch-unpack-${this.spec.id}`);
    assertPathInside(this.modelsRoot, staging, 'model-component-path-outside-models-root');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await this.extractArchiveImpl(archivePath, staging, signal);
      const unpacked = path.join(staging, path.basename(target));
      for (const relative of extract.requiredFiles) {
        if (!await isNonEmptyRegularFile(resolveManagedModelPath(unpacked, relative))) {
          throw new Error(`model-component-archive-incomplete:${relative}`);
        }
      }
      for (const [relative, sha256] of Object.entries(extract.fileSha256 || {})) {
        const candidate = resolveManagedModelPath(unpacked, relative);
        if (await sha256File(candidate) !== sha256.toLowerCase()) {
          throw new Error(`model-component-archive-file-sha-mismatch:${relative}`);
        }
      }
      if (await pathExists(target)) {
        // An earlier, incomplete copy is kept aside instead of being merged with the fresh one.
        await ensurePhysicalDirectoryInside(this.modelsRoot, this.quarantineRoot, 'model-quarantine-ancestor-reparse-point');
        await rename(target, path.join(this.quarantineRoot, `incomplete-${Date.now()}`));
      }
      await rename(unpacked, target);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    await unlink(archivePath).catch(() => undefined);
    if (!await this.extractedPayloadReady()) throw new Error('model-component-archive-incomplete');
    await this.markReady();
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
      assertTrustedComponentUrl(response.url, this.spec);
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
    if (this.spec.sourceUrl) return this.spec.sourceUrl;
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
    await renameWithWindowsRetry(resolvedCandidate, this.quarantinePayloadPath);
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

/**
 * Coder and Voice files have historical workspace paths (runtime/coder/models,
 * runtime/voice/models). With a separate models root they live in coder/ and voice/,
 * the same mapping the model catalog and the Voice workers use.
 */
export function mapLogicalModelPath(
  runtimePaths: Pick<MonarchRuntimePaths, 'mode' | 'modelsRoot' | 'workspaceRoot'>,
  relativePath: string,
): string {
  const normalized = String(relativePath || '').replace(/\\/gu, '/').replace(/^\/+/u, '');
  const externalModelsRoot = path.resolve(runtimePaths.modelsRoot) !== path.resolve(runtimePaths.workspaceRoot);
  if (runtimePaths.mode !== 'installed' && !externalModelsRoot) return normalized;
  for (const [prefix, replacement] of [['runtime/coder/models', 'coder'], ['runtime/voice/models', 'voice']] as const) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return `${replacement}${normalized.slice(prefix.length)}`;
    }
  }
  return normalized;
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
  if (spec.format === 'file' || spec.extract) return variant;
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

/** Hosts that serve the pinned non-Hugging-Face components (GitHub releases, Vosk models). */
const DIRECT_COMPONENT_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'alphacephei.com',
]);

function assertTrustedComponentUrl(value: string, spec: MonarchModelComponentSpec): void {
  if (!spec.sourceUrl) {
    assertTrustedDownloadUrl(value);
    return;
  }
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !DIRECT_COMPONENT_HOSTS.includes(host)) {
    throw new Error('model-download-untrusted-redirect');
  }
}

export function assertTrustedDownloadUrl(value: string): void {
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
    return 'Недостаточно места на диске для этой загрузки.';
  }
  if (/aborted/i.test(message)) return 'Загрузка остановлена.';
  if (/archive-incomplete|archive-file-sha|archive-extract/i.test(message)) {
    return 'Архив скачался, но распаковать его не получилось. Попробуй ещё раз.';
  }
  if (/quarantine-(?:hold|cap)/i.test(message)) {
    return 'Автоповтор остановлен: одна проверочная копия сохранена рядом с моделями. Требуется ручная проверка.';
  }
  if (/reparse-point/i.test(message)) {
    return 'Установка остановлена: путь модели был небезопасно подменён ссылкой или junction.';
  }
  if (/verification|sha|size|range|redirect/i.test(message)) {
    return 'Загруженная модель не прошла проверку целостности. Monarch сохранил её отдельно и не активировал.';
  }
  return 'Не получилось скачать. Проверь интернет и попробуй ещё раз.';
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

/** Read-only check: a regular, non-empty file that is not a link. */
async function isNonEmptyRegularFile(candidate: string): Promise<boolean> {
  try {
    const value = await lstat(candidate);
    return value.isFile() && !value.isSymbolicLink() && value.size > 0;
  } catch (error) {
    if (isMissingFileError(error) || (error && typeof error === 'object' && 'code' in error && error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

/** Windows 10+ ships bsdtar, which unpacks both .zip and .tar.bz2 and refuses absolute or ../ paths. */
async function extractArchiveWithSystemTar(archivePath: string, destination: string, signal: AbortSignal): Promise<void> {
  const executable = process.platform === 'win32'
    ? path.join(path.resolve(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'), 'System32', 'tar.exe')
    : 'tar';
  const child = spawn(executable, ['-xf', archivePath, '-C', destination], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 2_048) stderr += chunk.toString('utf8', 0, 2_048 - stderr.length);
  });
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (signal.aborted) throw abortError();
    if (code !== 0) throw new Error(`model-component-archive-extract-${code ?? 'unknown'}${stderr ? '-stderr' : ''}`);
  } finally {
    signal.removeEventListener('abort', abort);
  }
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
