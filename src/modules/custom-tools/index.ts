import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type {
  MonarchCapability,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRisk,
} from '../../core';
import { resolveMonarchRuntimePaths } from '../../core';
import { isPublicNetworkAddress } from '../../core/network-address-policy';
import { customToolsManifest } from './manifest';

/** Tools are host code with a host-fixed risk. Scripts written by a model or a
 * person used to run in `node:vm`, which is not a security boundary, and their
 * author declared their own risk. Both are gone: nothing outside this file can
 * add executable code or choose how much confirmation a tool needs. */
type BuiltInToolRisk = 'none' | 'network';

interface BuiltInTool {
  id: string;
  title: string;
  description: string;
  risk: BuiltInToolRisk;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<unknown> | unknown;
}

/** A tool saved by an earlier version. It is kept as inert data so the owner
 * can see and delete it; its script is never executed or returned. */
interface StoredToolRecord {
  id: string;
  title: string;
  description: string;
}

const CUSTOM_TOOL_FETCH_TIMEOUT_MS = 5000;
const CUSTOM_TOOL_FETCH_MAX_BYTES = 1024 * 1024;
const CUSTOM_TOOL_FETCH_MAX_REDIRECTS = 5;
const MAX_TEXT_INPUT_CHARS = 100_000;
const MAX_PICK_KEYS = 256;
const DEFAULT_FETCH_PREVIEW_CHARS = 4000;
const MAX_FETCH_PREVIEW_CHARS = 20_000;
export const CUSTOM_TOOL_SCRIPTS_DISABLED = 'custom-tool-scripts-disabled';

const BUILT_IN_TOOLS: readonly BuiltInTool[] = Object.freeze([
  {
    id: 'clock-now',
    title: 'Current time',
    description: 'Return the current local timestamp and timezone.',
    risk: 'none',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => ({
      iso: new Date().toISOString(),
      locale: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    }),
  },
  {
    id: 'text-slugify',
    title: 'Slugify text',
    description: 'Convert input.text into a lowercase URL/file-name friendly slug.',
    risk: 'none',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: (input) => {
      const text = requireString(input.text, 'text').slice(0, MAX_TEXT_INPUT_CHARS);
      return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120);
    },
  },
  {
    id: 'json-pick',
    title: 'Pick JSON fields',
    description: 'Return selected top-level fields from input.object by input.keys.',
    risk: 'none',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'object' },
        keys: { type: 'array', items: { type: 'string' } },
      },
      required: ['object', 'keys'],
      additionalProperties: false,
    },
    run: (input) => {
      const source = input.object && typeof input.object === 'object' && !Array.isArray(input.object)
        ? input.object as Record<string, unknown> : {};
      if (!Array.isArray(input.keys) || input.keys.length > MAX_PICK_KEYS) throw new ToolInputError('keys');
      const out: Record<string, unknown> = Object.create(null);
      for (const key of input.keys.map(String)) {
        if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
      }
      return { ...out };
    },
  },
  {
    id: 'web-fetch-text',
    title: 'Fetch public URL text',
    description: 'Fetch a public HTTP/HTTPS URL with SSRF protection and return a bounded text preview.',
    risk: 'network',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    run: async (input) => {
      const url = requireString(input.url, 'url');
      const requested = typeof input.maxChars === 'number' && Number.isFinite(input.maxChars)
        ? Math.trunc(input.maxChars) : DEFAULT_FETCH_PREVIEW_CHARS;
      const maxChars = Math.min(MAX_FETCH_PREVIEW_CHARS, Math.max(1, requested));
      const response = await safeFetch(url);
      const text = await response.text();
      return { status: response.status, ok: response.ok, text: text.slice(0, maxChars) };
    },
  },
] satisfies BuiltInTool[]);

const BUILT_IN_BY_ID = new Map(BUILT_IN_TOOLS.map(tool => [tool.id, tool]));

class ToolInputError extends Error {
  constructor(readonly field: string) {
    super(`Invalid tool input: ${field}`);
  }
}

export interface CustomToolsModuleOptions {
  storePath?: string;
  workspaceRoot?: string;
}

export class CustomToolsModule implements MonarchModule {
  readonly manifest = customToolsManifest;
  private readonly stored = new Map<string, StoredToolRecord>();
  private readonly storePath: string;

  constructor(options: CustomToolsModuleOptions | string = {}) {
    const normalized = typeof options === 'string' ? { storePath: options } : options;
    const workspaceRoot = path.resolve(normalized.workspaceRoot || process.cwd());
    this.storePath = normalized.storePath
      || path.join(resolveMonarchRuntimePaths(workspaceRoot).dataRoot, 'custom-tools.json');
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await this.loadStoredTools();
    await context.emit('custom-tools.activated', this.manifest.id, {
      loadedToolsCount: BUILT_IN_TOOLS.length,
      disabledStoredToolsCount: this.stored.size,
    });
  }

  resolveCapabilityRisk(
    request: MonarchExecutionRequest,
    capability: MonarchCapability
  ): MonarchRisk | undefined {
    if (request.capabilityId !== 'custom-tools.execute') {
      return undefined;
    }
    // Only host code decides the risk; an unknown or stored tool keeps the
    // capability's own (highest) risk and is refused before running anyway.
    const toolId = readStringInput(request.input, 'toolId').toLowerCase();
    return BUILT_IN_BY_ID.get(toolId)?.risk ?? capability.risk;
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: `Custom Tools Engine ready. ${BUILT_IN_TOOLS.length} built-in tools available.`,
      output: {
        toolsCount: BUILT_IN_TOOLS.length,
        disabledStoredToolsCount: this.stored.size,
        storePath: this.storePath,
      },
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    _context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'custom-tools.list':
      return this.listTools();
    case 'custom-tools.delete':
      return this.deleteTool(request.input);
    case 'custom-tools.execute':
      return this.executeTool(request.input);
    default:
      return {
        ok: false,
        summary: `Unsupported custom tools capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private listTools(): MonarchExecutionResult {
    const builtIn = BUILT_IN_TOOLS.map(tool => ({
      id: tool.id,
      title: tool.title,
      description: tool.description,
      risk: tool.risk,
      inputSchema: structuredClone(tool.inputSchema),
      builtIn: true,
      executable: true,
    }));
    const stored = Array.from(this.stored.values()).map(tool => ({
      ...tool,
      builtIn: false,
      executable: false,
      disabledReason: CUSTOM_TOOL_SCRIPTS_DISABLED,
    }));
    return {
      ok: true,
      summary: `Custom Tools Engine listed ${builtIn.length} built-in tools`
        + (stored.length ? ` and ${stored.length} disabled saved tools.` : '.'),
      output: { tools: [...builtIn, ...stored] },
    };
  }

  private async deleteTool(input: unknown): Promise<MonarchExecutionResult> {
    const id = readStringInput(input, 'id').toLowerCase();
    if (BUILT_IN_BY_ID.has(id)) {
      return {
        ok: false,
        summary: `Built-in tool ${id} cannot be deleted.`,
        error: 'built-in-tool',
      };
    }
    const tool = this.stored.get(id);
    if (!id || !tool) {
      return {
        ok: false,
        summary: `Delete custom tool failed: tool not found: ${id}`,
        error: 'tool-not-found',
      };
    }
    // Re-read the file so other fields of the remaining records are kept as written.
    const raw = await this.readStoreFile();
    await this.writeStoreFile(raw.filter(item => normalizedRecordId(item) !== id));
    this.stored.delete(id);
    return {
      ok: true,
      summary: `Successfully deleted custom tool: ${tool.title} (${id}).`,
    };
  }

  private async executeTool(input: unknown): Promise<MonarchExecutionResult> {
    const toolId = readStringInput(input, 'toolId').toLowerCase();
    const tool = BUILT_IN_BY_ID.get(toolId);
    if (!tool) {
      return this.stored.has(toolId)
        ? {
          ok: false,
          summary: `Saved tool ${toolId} is disabled: Monarch no longer runs tool scripts.`,
          error: CUSTOM_TOOL_SCRIPTS_DISABLED,
        }
        : {
          ok: false,
          summary: `Custom tool not found: ${toolId}`,
          error: 'tool-not-found',
        };
    }
    const rawInput = input && typeof input === 'object' ? (input as Record<string, unknown>).input : undefined;
    if (rawInput !== undefined && (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput))) {
      return { ok: false, summary: `Custom tool ${toolId} needs an object input.`, error: 'invalid-tool-input' };
    }
    try {
      const result = await tool.run((rawInput as Record<string, unknown> | undefined) ?? {});
      return {
        ok: true,
        summary: `Executed custom tool: ${tool.title} (${toolId}).`,
        output: { result },
      };
    } catch (error) {
      if (error instanceof ToolInputError) {
        return { ok: false, summary: `Custom tool ${toolId}: invalid ${error.field}.`, error: 'invalid-tool-input' };
      }
      return {
        ok: false,
        summary: `Custom tool ${toolId} execution failed: ${error instanceof Error ? error.message : String(error)}`,
        error: 'custom-tool-execution-failed',
      };
    }
  }

  /** Built-in entries seeded into the file by earlier versions are dropped;
   * every other record stays in the file untouched and is listed as disabled. */
  private async loadStoredTools(): Promise<void> {
    this.stored.clear();
    const raw = await this.readStoreFile();
    const kept = raw.filter(item => !BUILT_IN_BY_ID.has(normalizedRecordId(item)));
    for (const item of kept) {
      const id = normalizedRecordId(item);
      if (!id) continue;
      const record = item as Record<string, unknown>;
      this.stored.set(id, {
        id,
        title: typeof record.title === 'string' ? record.title.slice(0, 200) : id,
        description: typeof record.description === 'string' ? record.description.slice(0, 1000) : '',
      });
    }
    if (kept.length !== raw.length || !(await this.storeFileExists())) await this.writeStoreFile(kept);
  }

  private async readStoreFile(): Promise<unknown[]> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async storeFileExists(): Promise<boolean> {
    try {
      await access(this.storePath);
      return true;
    } catch {
      return false;
    }
  }

  private async writeStoreFile(records: unknown[]): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }
}

function normalizedRecordId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' ? id.trim().toLowerCase() : '';
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const val = (input as Record<string, unknown>)[key];
  return typeof val === 'string' ? val.trim() : '';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ToolInputError(field);
  return value;
}

export async function safeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOM_TOOL_FETCH_TIMEOUT_MS);
  const userSignal = init?.signal;
  if (userSignal?.aborted) {
    controller.abort();
  } else if (userSignal) {
    userSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetchWithValidatedRedirects(url, init, controller.signal, 0);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithValidatedRedirects(
  url: string | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
  redirectCount: number
): Promise<Response> {
  const target = await normalizeFetchTarget(url);
  const dispatcher = createPinnedDispatcher(target.records);
  try {
    const requestInit: UndiciRequestInit = {
      ...((init || {}) as unknown as UndiciRequestInit),
      signal,
      redirect: 'manual',
      dispatcher,
    };
    const response = await undiciFetch(target.url, requestInit);

    if (isRedirectStatus(response.status)) {
      if (redirectCount >= CUSTOM_TOOL_FETCH_MAX_REDIRECTS) {
        throw new Error('Custom tool fetch redirect limit exceeded.');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Custom tool fetch redirect target is missing.');
      }
      await response.body?.cancel().catch(() => undefined);
      return fetchWithValidatedRedirects(
        new URL(location, target.url),
        init,
        signal,
        redirectCount + 1
      );
    }

    return readBoundedResponse(response as unknown as Response);
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

async function normalizeFetchTarget(url: string | URL): Promise<{
  url: string;
  records: Array<{ address: string; family: 4 | 6 }>;
}> {
  const parsed = url instanceof URL ? url : new URL(String(url));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS fetch URLs are allowed.');
  }
  const records = await assertPublicNetworkTarget(parsed);
  return { url: parsed.toString(), records };
}

async function assertPublicNetworkTarget(parsed: URL): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isBlockedNetworkHost(hostname)) {
    throw new Error('Local and private network fetch targets are blocked.');
  }

  let records: Array<{ address: string }> = [];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Custom tool fetch DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (records.length === 0 || records.some((record) => isBlockedNetworkHost(record.address))) {
    throw new Error('Local and private network fetch targets are blocked.');
  }
  return records
    .map((record) => ({ address: record.address, family: isIP(record.address) }))
    .filter((record): record is { address: string; family: 4 | 6 } => record.family === 4 || record.family === 6);
}

function createPinnedDispatcher(records: Array<{ address: string; family: 4 | 6 }>): Agent {
  return new Agent({
    connect: {
      lookup: ((_: string, options: unknown, callback: (...args: unknown[]) => void) => {
        const normalized = typeof options === 'object' && options ? options as { all?: boolean; family?: number } : {};
        const eligible = normalized.family === 4 || normalized.family === 6
          ? records.filter((record) => record.family === normalized.family)
          : records;
        if (eligible.length === 0) {
          const error = Object.assign(new Error('No validated address matches the requested IP family.'), { code: 'ENOTFOUND' });
          callback(error);
          return;
        }
        if (normalized.all) callback(null, eligible);
        else callback(null, eligible[0]!.address, eligible[0]!.family);
      }) as never,
    },
  });
}

function isBlockedNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  return isIP(host.split('%', 1)[0]!) !== 0 && !isPublicNetworkAddress(host);
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

async function readBoundedResponse(response: Response): Promise<Response> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > CUSTOM_TOOL_FETCH_MAX_BYTES) {
    throw new Error(`Custom tool fetch response exceeds ${CUSTOM_TOOL_FETCH_MAX_BYTES} bytes.`);
  }

  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    totalBytes += value.byteLength;
    if (totalBytes > CUSTOM_TOOL_FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Custom tool fetch response exceeds ${CUSTOM_TOOL_FETCH_MAX_BYTES} bytes.`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const headers = new Headers(response.headers);
  headers.set('content-length', String(totalBytes));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


export function createCustomToolsModule(options: CustomToolsModuleOptions = {}): MonarchModule {
  return new CustomToolsModule(options);
}

export const customToolsModulePackage: MonarchModulePackage = {
  id: 'custom-tools',
  moduleId: 'custom-tools',
  version: '0.1.0',
  description: customToolsManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createCustomToolsModule,
};
