import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MonarchRuntimePaths } from '../../core/runtime-paths';
import { assertTrustedDownloadUrl } from './component-manager';

import { isCustomModelRole } from './custom-model-contract';
import { assertChatGguf, GgufChatError } from './gguf-chat';
import { runInBackground } from '../../core/background-work';
import { renameWithWindowsRetry } from '../../core/durable-json-file';

export { CUSTOM_MODEL_ROLE_PATTERN, isCustomModelRole } from './custom-model-contract';
export const CUSTOM_MODELS_DIRECTORY = 'custom_models';
const REGISTRY_FILE = 'registry.v1.json';
const MIN_MODEL_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 24;
const DEFAULT_CONTEXT_TOKENS = 8192;

export type CustomModelStatus = 'ready' | 'downloading' | 'failed' | 'missing';

export interface CustomModelRecord {
  id: string;
  label: string;
  source: 'file' | 'download';
  path: string;
  sizeBytes: number;
  contextTokens: number;
  addedAt: string;
  origin: string | null;
  status: CustomModelStatus;
  downloadedBytes: number;
  error: string | null;
}

export interface CustomModelHubFile {
  file: string;
  sizeBytes: number;
  quantization: string | null;
  recommended: boolean;
}

export interface CustomModelHubInspection {
  repository: string;
  revision: string;
  files: CustomModelHubFile[];
  suggestedLabel: string;
}

interface StoredRegistry {
  schemaVersion: 1;
  models: CustomModelRecord[];
}

export class CustomModelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CustomModelError';
  }
}

export class LocalCustomModelStore {
  readonly root: string;
  private readonly registryPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly downloads = new Map<string, AbortController>();
  private readonly progress = new Map<string, number>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly validation = new Map<string, { stamp: string; result: Promise<string | null> }>();

  constructor(runtimePaths: Pick<MonarchRuntimePaths, 'modelsRoot'>, options: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
    this.root = path.join(runtimePaths.modelsRoot, CUSTOM_MODELS_DIRECTORY);
    this.registryPath = path.join(this.root, REGISTRY_FILE);
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || (() => new Date());
  }

  async list(): Promise<CustomModelRecord[]> {
    const registry = await this.read();
    return Promise.all(registry.models.map(async (model) => {
      const downloaded = this.progress.get(model.id);
      if (model.status === 'downloading') {
        // A download that is not running in this process was interrupted.
        return this.downloads.has(model.id)
          ? { ...model, downloadedBytes: downloaded ?? model.downloadedBytes }
          : { ...model, status: 'failed' as const, error: model.error || 'Загрузка прервалась. Удали модель и начни снова.' };
      }
      if (model.status === 'ready' && !existsSync(model.path)) {
        return { ...model, status: 'missing' as const, error: 'Файл модели не найден. Возможно, его переместили или удалили.' };
      }
      if (model.status === 'ready') {
        const info = await stat(model.path).catch(() => null);
        if (!info) return { ...model, status: 'missing' as const, error: 'Файл модели не найден.' };
        const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
        let cached = this.validation.get(model.path);
        if (!cached || cached.stamp !== stamp) {
          const result = verifyGgufFile(model.path).then(() => null, error => error instanceof CustomModelError
            ? error.message : 'Не получилось проверить файл модели.');
          cached = { stamp, result };
          if (this.validation.size >= MAX_MODELS) this.validation.clear();
          this.validation.set(model.path, cached);
        }
        const error = await cached.result;
        if (error) return { ...model, status: 'failed' as const, error };
      }
      return model;
    }));
  }

  async addLocalFile(input: { path?: unknown; label?: unknown; contextTokens?: unknown }): Promise<CustomModelRecord> {
    const filePath = typeof input.path === 'string' ? input.path.trim() : '';
    if (!filePath || !path.isAbsolute(filePath) || filePath.length > 1024) {
      throw new CustomModelError('custom-model-path', 'Выбери файл модели с диска.');
    }
    if (path.extname(filePath).toLowerCase() !== '.gguf') {
      throw new CustomModelError('custom-model-format', 'Подходят только файлы .gguf — это формат моделей для llama.cpp.');
    }
    const resolved = path.resolve(filePath);
    if (isSplitGguf(resolved)) {
      throw new CustomModelError('custom-model-split', 'Модель разбита на части. Выбери цельный файл .gguf.');
    }
    const sizeBytes = await verifyGgufFile(resolved);
    const registry = await this.read();
    if (registry.models.some((model) => samePath(model.path, resolved))) {
      throw new CustomModelError('custom-model-duplicate', 'Эта модель уже добавлена.');
    }
    if (registry.models.length >= MAX_MODELS) {
      throw new CustomModelError('custom-model-limit', `Можно добавить до ${MAX_MODELS} своих моделей.`);
    }
    const record: CustomModelRecord = {
      id: newModelId(),
      label: normalizeLabel(input.label) || labelFromFileName(path.basename(resolved)),
      source: 'file',
      path: resolved,
      sizeBytes,
      contextTokens: normalizeContext(input.contextTokens),
      addedAt: this.now().toISOString(),
      origin: null,
      status: 'ready',
      downloadedBytes: sizeBytes,
      error: null,
    };
    await this.update((models) => [...models, record]);
    return record;
  }

  async inspectHub(input: unknown): Promise<CustomModelHubInspection> {
    const reference = parseHubReference(input);
    const url = `https://huggingface.co/api/models/${encodeRepository(reference.repository)}?blobs=true`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
    } catch {
      throw new CustomModelError('custom-model-hub-unavailable', 'Hugging Face сейчас не отвечает. Проверь интернет и попробуй ещё раз.');
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new CustomModelError('custom-model-hub-gated', 'Эта модель закрыта: её автор просит войти и принять условия на сайте Hugging Face.');
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new CustomModelError('custom-model-hub-missing', 'Такой модели нет на Hugging Face. Проверь ссылку.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CustomModelError('custom-model-hub-unavailable', 'Hugging Face не отдал список файлов. Попробуй чуть позже.');
    }
    const body = await readBoundedJson(response, 8 * 1024 * 1024);
    const siblings = Array.isArray(body?.siblings) ? body.siblings : [];
    const files = siblings
      .map((entry: any) => ({
        file: typeof entry?.rfilename === 'string' ? entry.rfilename : '',
        sizeBytes: Number(entry?.lfs?.size ?? entry?.size ?? 0),
      }))
      .filter((entry: { file: string; sizeBytes: number }) => entry.file.toLowerCase().endsWith('.gguf')
        && !/mmproj|(^|\/)mtp-|draft/iu.test(entry.file)
        && !isSplitGguf(entry.file)
        && entry.file.length <= 300)
      .slice(0, 200)
      .map((entry: { file: string; sizeBytes: number }) => ({
        ...entry,
        sizeBytes: Number.isFinite(entry.sizeBytes) && entry.sizeBytes > 0 ? entry.sizeBytes : 0,
        quantization: quantizationOf(entry.file),
        recommended: false,
      }))
      .sort((left: CustomModelHubFile, right: CustomModelHubFile) => left.sizeBytes - right.sizeBytes);
    if (files.length === 0) {
      throw new CustomModelError('custom-model-hub-empty', 'В этой модели нет файлов .gguf. Поищи её версию с «GGUF» в названии.');
    }
    const requested = reference.file ? files.find((entry: CustomModelHubFile) => entry.file === reference.file) : undefined;
    const recommended = requested
      || files.find((entry: CustomModelHubFile) => entry.quantization === 'Q4_K_M')
      || files.find((entry: CustomModelHubFile) => /^Q4/u.test(entry.quantization || ''))
      || files[Math.floor(files.length / 2)];
    if (recommended) recommended.recommended = true;
    return {
      repository: reference.repository,
      revision: reference.revision,
      files,
      suggestedLabel: labelFromRepository(reference.repository),
    };
  }

  async startDownload(input: { repository?: unknown; file?: unknown; revision?: unknown; label?: unknown; contextTokens?: unknown }): Promise<CustomModelRecord> {
    const reference = parseHubReference(input.repository);
    const file = typeof input.file === 'string' ? input.file.trim() : '';
    if (!file.toLowerCase().endsWith('.gguf') || file.length > 300 || file.split('/').some((part) => !part || part === '..' || part === '.')) {
      throw new CustomModelError('custom-model-file', 'Выбери файл .gguf из списка.');
    }
    if (isSplitGguf(file)) throw new CustomModelError('custom-model-split', 'Модель разбита на части. Выбери цельный файл .gguf.');
    const revision = typeof input.revision === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(input.revision) ? input.revision : reference.revision;
    const registry = await this.read();
    const origin = `${reference.repository}/${file}`;
    if (registry.models.some((model) => model.origin === origin && model.status !== 'failed')) {
      throw new CustomModelError('custom-model-duplicate', 'Эта модель уже добавлена.');
    }
    if (registry.models.length >= MAX_MODELS) {
      throw new CustomModelError('custom-model-limit', `Можно добавить до ${MAX_MODELS} своих моделей.`);
    }
    const id = newModelId();
    const directory = path.join(this.root, id);
    const target = path.join(directory, sanitizeFileName(path.posix.basename(file)));
    const record: CustomModelRecord = {
      id,
      label: normalizeLabel(input.label) || labelFromRepository(reference.repository),
      source: 'download',
      path: target,
      sizeBytes: 0,
      contextTokens: normalizeContext(input.contextTokens),
      addedAt: this.now().toISOString(),
      origin,
      status: 'downloading',
      downloadedBytes: 0,
      error: null,
    };
    await mkdir(directory, { recursive: true });
    await this.update((models) => [...models, record]);
    const controller = new AbortController();
    this.downloads.set(id, controller);
    this.progress.set(id, 0);
    const url = `https://huggingface.co/${encodeRepository(reference.repository)}/resolve/${encodeURIComponent(revision)}/${file.split('/').map(encodeURIComponent).join('/')}`;
    runInBackground('custom-model-download', this.runDownload(record, url, controller.signal));
    return record;
  }

  async remove(id: unknown): Promise<void> {
    if (!isCustomModelRole(id)) throw new CustomModelError('custom-model-id', 'Модель не найдена.');
    this.downloads.get(id)?.abort();
    const registry = await this.read();
    const record = registry.models.find((model) => model.id === id);
    if (!record) throw new CustomModelError('custom-model-id', 'Модель не найдена.');
    await this.update((models) => models.filter((model) => model.id !== id));
    if (record.source === 'download') {
      // Only Monarch's own download folder is deleted; an owner's file stays put.
      const directory = path.join(this.root, id);
      if (path.dirname(path.resolve(record.path)) === path.resolve(directory)) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    this.progress.delete(id);
  }

  async rename(id: unknown, label: unknown): Promise<CustomModelRecord> {
    if (!isCustomModelRole(id)) throw new CustomModelError('custom-model-id', 'Модель не найдена.');
    const next = normalizeLabel(label);
    if (!next) throw new CustomModelError('custom-model-label', 'Придумай название покороче — до 60 символов.');
    let updated: CustomModelRecord | undefined;
    await this.update((models) => models.map((model) => {
      if (model.id !== id) return model;
      updated = { ...model, label: next };
      return updated;
    }));
    if (!updated) throw new CustomModelError('custom-model-id', 'Модель не найдена.');
    return updated;
  }

  async stop(): Promise<void> {
    for (const controller of this.downloads.values()) controller.abort();
  }

  private async runDownload(record: CustomModelRecord, url: string, signal: AbortSignal): Promise<void> {
    const partial = `${record.path}.part`;
    try {
      assertTrustedDownloadUrl(url);
      const response = await this.fetchImpl(url, { signal, redirect: 'follow', headers: { Accept: 'application/octet-stream' } });
      if (response.url) assertTrustedDownloadUrl(response.url);
      if (response.status === 401 || response.status === 403) {
        throw new CustomModelError('custom-model-hub-gated', 'Эта модель закрыта: автор просит войти и принять условия на сайте Hugging Face.');
      }
      if (!response.ok || !response.body) throw new CustomModelError('custom-model-download', 'Hugging Face не отдал файл. Попробуй ещё раз.');
      const expected = Number(response.headers.get('content-length') || 0);
      if (expected > 0) {
        const disk = await statfs(path.dirname(record.path)).catch(() => null);
        const free = disk ? Number(disk.bavail) * Number(disk.bsize) : Number.NaN;
        if (Number.isFinite(free) && free < expected + 512 * 1024 * 1024) {
          throw new CustomModelError('custom-model-space', 'На диске не хватает места для этой модели.');
        }
        await this.update((models) => models.map((model) => model.id === record.id ? { ...model, sizeBytes: expected } : model));
      }
      let downloaded = 0;
      const counter = new TransformCounter((bytes) => {
        downloaded += bytes;
        this.progress.set(record.id, downloaded);
      });
      await pipeline(Readable.fromWeb(response.body as any), counter, createWriteStream(partial), { signal });
      if (expected > 0 && downloaded !== expected) throw new CustomModelError('custom-model-download', 'Файл скачался не полностью. Попробуй ещё раз.');
      await verifyGgufFile(partial);
      await renameWithWindowsRetry(partial, record.path);
      const size = (await stat(record.path)).size;
      await this.update((models) => models.map((model) => model.id === record.id
        ? { ...model, status: 'ready' as const, sizeBytes: size, downloadedBytes: size, error: null } : model));
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      if (signal.aborted) return;
      const message = error instanceof CustomModelError ? error.message : 'Не удалось скачать модель. Проверь интернет и попробуй ещё раз.';
      await this.update((models) => models.map((model) => model.id === record.id
        ? { ...model, status: 'failed' as const, error: message } : model)).catch(() => undefined);
    } finally {
      this.downloads.delete(record.id);
      this.progress.delete(record.id);
    }
  }

  private async read(): Promise<StoredRegistry> {
    try {
      const value = JSON.parse(await readFile(this.registryPath, 'utf8')) as StoredRegistry;
      if (value?.schemaVersion !== 1 || !Array.isArray(value.models)) return { schemaVersion: 1, models: [] };
      return { schemaVersion: 1, models: value.models.filter(validRecord).slice(0, MAX_MODELS) };
    } catch {
      return { schemaVersion: 1, models: [] };
    }
  }

  private update(change: (models: CustomModelRecord[]) => CustomModelRecord[]): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const current = await this.read();
      const next: StoredRegistry = { schemaVersion: 1, models: change(current.models) };
      await mkdir(this.root, { recursive: true });
      const temporary = `${this.registryPath}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
      await renameWithWindowsRetry(temporary, this.registryPath);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}

class TransformCounter extends Transform {
  constructor(private readonly onBytes: (bytes: number) => void) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.onBytes(chunk.byteLength);
    callback(null, chunk);
  }
}

async function verifyGgufFile(filePath: string): Promise<number> {
  let size = 0;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not-file');
    size = info.size;
  } catch {
    throw new CustomModelError('custom-model-missing', 'Файл не найден. Проверь, что он на месте.');
  }
  if (size < MIN_MODEL_BYTES) throw new CustomModelError('custom-model-small', 'Файл слишком маленький для языковой модели.');
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (header.toString('latin1') !== 'GGUF') {
      throw new CustomModelError('custom-model-format', 'Это не модель GGUF: файл повреждён или другого формата.');
    }
  } finally {
    await handle.close();
  }
  try { await assertChatGguf(filePath); }
  catch (error) {
    const code = error instanceof GgufChatError ? error.code : 'custom-model-format';
    throw new CustomModelError(code, customGgufErrorText(code));
  }
  return size;
}

function customGgufErrorText(code: string): string {
  if (code === 'custom-model-draft-only') return 'Это MTP draft — вспомогательная часть модели. Она не отвечает самостоятельно. Выбери основной GGUF этой модели без draft/mtp.';
  if (code === 'custom-model-auxiliary') return 'Это вспомогательный GGUF (адаптер или проектор), а не самостоятельная модель для чата. Выбери основной GGUF.';
  if (code === 'custom-model-split') return 'Модель разбита на части. Выбери цельный файл .gguf.';
  return 'Не получилось прочитать структуру GGUF: файл повреждён или его формат не поддерживается.';
}

function parseHubReference(input: unknown): { repository: string; revision: string; file: string | null } {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || raw.length > 400) throw new CustomModelError('custom-model-hub-link', 'Вставь ссылку на модель с Hugging Face.');
  let rest = raw;
  const url = /^https?:\/\//iu.test(raw) ? safeUrl(raw) : null;
  if (url) {
    const host = url.hostname.toLowerCase();
    if (host !== 'huggingface.co' && host !== 'www.huggingface.co' && host !== 'hf.co') {
      throw new CustomModelError('custom-model-hub-link', 'Пока поддерживаются ссылки с huggingface.co.');
    }
    rest = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/gu, '');
  } else {
    rest = raw.replace(/^(?:huggingface\.co|hf\.co)\//iu, '').replace(/^\/+|\/+$/gu, '');
  }
  const parts = rest.split('/');
  if (parts[0] === 'models') parts.shift();
  const [owner, name, kind, revision, ...fileParts] = parts;
  const valid = (value: string | undefined) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value);
  if (!valid(owner) || !valid(name)) throw new CustomModelError('custom-model-hub-link', 'Не получилось понять ссылку. Пример: huggingface.co/unsloth/Qwen3-8B-GGUF');
  const repository = `${owner}/${name}`;
  if ((kind === 'blob' || kind === 'resolve') && revision && fileParts.length) {
    return { repository, revision: /^[A-Za-z0-9._-]{1,80}$/u.test(revision) ? revision : 'main', file: fileParts.join('/') };
  }
  return { repository, revision: 'main', file: null };
}

function safeUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

function encodeRepository(repository: string): string {
  return repository.split('/').map(encodeURIComponent).join('/');
}

async function readBoundedJson(response: Response, limit: number): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new CustomModelError('custom-model-hub-unavailable', 'Hugging Face не отдал список файлов.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new CustomModelError('custom-model-hub-unavailable', 'Список файлов слишком большой.');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CustomModelError('custom-model-hub-unavailable', 'Hugging Face ответил непонятно. Попробуй позже.');
  }
}

function validRecord(value: unknown): value is CustomModelRecord {
  const record = value as CustomModelRecord;
  return Boolean(record && typeof record === 'object'
    && isCustomModelRole(record.id)
    && typeof record.label === 'string' && record.label.length > 0 && record.label.length <= 60
    && (record.source === 'file' || record.source === 'download')
    && typeof record.path === 'string' && path.isAbsolute(record.path)
    && ['ready', 'downloading', 'failed'].includes(record.status)
    && Number.isFinite(record.sizeBytes) && Number.isFinite(record.contextTokens));
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const label = value.replace(/[\u0000-\u001f<>]/gu, '').replace(/\s+/gu, ' ').trim();
  return label.length > 0 && label.length <= 60 ? label : '';
}

function normalizeContext(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONTEXT_TOKENS;
  return Math.max(2048, Math.min(131072, Math.round(number / 1024) * 1024));
}

function newModelId(): string {
  return `custom-${randomBytes(6).toString('hex')}`;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isSplitGguf(value: string): boolean {
  return /-\d{5}-of-\d{5}\.gguf$/iu.test(value);
}

function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 160);
  return cleaned.toLowerCase().endsWith('.gguf') ? cleaned : `${cleaned}.gguf`;
}

export function quantizationOf(file: string): string | null {
  const match = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|F16|BF16|F32)(?=\.gguf$|[-_.])/iu.exec(path.posix.basename(file));
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function labelFromFileName(file: string): string {
  const base = file.replace(/\.gguf$/iu, '')
    .replace(/[-_.](?:I?Q\d(?:_[A-Z0-9]+)*|F16|BF16|F32)$/iu, '')
    .replace(/[-_]+/gu, ' ')
    .trim();
  return (base || 'Моя модель').slice(0, 60);
}

function labelFromRepository(repository: string): string {
  const name = repository.split('/')[1] || repository;
  return name.replace(/[-_.]?gguf$/iu, '').replace(/[-_]+/gu, ' ').trim().slice(0, 60) || 'Моя модель';
}
