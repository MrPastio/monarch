import type { ChatRequest, ChatRoutePreview, HardwareInfo, MemoryStats, ModelStatus, SearchResult, WorkspaceActionRequest, WorkspaceToolResult } from '../types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:7861';

export class BackendHttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(formatBackendStatusMessage(status));
    this.name = 'BackendHttpError';
    this.status = status;
    this.detail = detail;
  }
}

export async function getHealth() {
  return fetchJson<{ ok: boolean; memory: MemoryStats; model: ModelStatus }>(`${API_BASE}/api/health`);
}

export async function getHardware() {
  return fetchJson<HardwareInfo>(`${API_BASE}/api/hardware`);
}

export async function getMemoryStats() {
  return fetchJson<MemoryStats>(`${API_BASE}/api/memory/stats`);
}

export async function getModelStatus() {
  return fetchJson<ModelStatus>(`${API_BASE}/api/model/status`);
}

export async function getEnvironment() {
  return fetchJson<WorkspaceToolResult>(`${API_BASE}/api/environment`);
}

export async function runSearch(query: string, maxResults = 5) {
  return fetchJson<SearchResult[]>(`${API_BASE}/api/search`, {
    method: 'POST',
    body: JSON.stringify({ query, max_results: maxResults, fetch_pages: true }),
  });
}

export async function listWorkspace(path = 'artifacts/generated', recursive = false, limit = 80) {
  const params = new URLSearchParams({ path, recursive: String(recursive), limit: String(limit) });
  return fetchJson<WorkspaceToolResult>(`${API_BASE}/api/workspace/list?${params.toString()}`);
}

export async function readWorkspaceFile(path: string) {
  const params = new URLSearchParams({ path });
  return fetchJson<WorkspaceToolResult>(`${API_BASE}/api/workspace/read?${params.toString()}`);
}

export async function searchWorkspace(query: string, path = '.', limit = 40) {
  const params = new URLSearchParams({ q: query, path, limit: String(limit) });
  return fetchJson<WorkspaceToolResult>(`${API_BASE}/api/workspace/search?${params.toString()}`);
}

export async function previewChatRoute(payload: ChatRequest, signal?: AbortSignal) {
  return fetchJson<ChatRoutePreview>(`${API_BASE}/api/chat/route`, {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
  });
}

export async function cancelGeneration() {
  return fetchJson<{ ok: boolean; cancelled: boolean; queue_busy: boolean }>(`${API_BASE}/api/generation/cancel`, {
    method: 'POST',
  });
}

export async function runWorkspaceAction(request: WorkspaceActionRequest) {
  return fetchJson<WorkspaceToolResult>(`${API_BASE}/api/workspace/action`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function streamChat(
  payload: ChatRequest,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal,
) {
  const headers = {
    'Content-Type': 'application/json',
  } as Record<string, string>;

  addAuthHeader(headers);

  const response = await fetch(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw await createBackendHttpError(response);
  }
  if (!response.body) {
    throw new Error('Backend не открыл поток ответа');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedDoneEvent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const flushed = drainSseBuffer(buffer, true);
        for (const event of flushed.events) {
          if (event.event === 'done') receivedDoneEvent = true;
          onEvent(event.event, event.data);
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSseBuffer(buffer);
      buffer = drained.buffer;
      for (const event of drained.events) {
        if (event.event === 'done') receivedDoneEvent = true;
        onEvent(event.event, event.data);
      }
    }
  } catch (error) {
    if (!receivedDoneEvent) throw error;
  } finally {
    reader.releaseLock();
  }

  if (!receivedDoneEvent) {
    throw new Error('Поток ответа завершился до подтверждения результата');
  }
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = {
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  } as Record<string, string>;

  addAuthHeader(headers);

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw await createBackendHttpError(response);
  }
  return response.json() as Promise<T>;
}

function addAuthHeader(headers: Record<string, string>) {
  const token = getApiToken();
  if (token) {
    headers['X-Oscar-Token'] = token;
  }
}

function getApiToken() {
  if (typeof window === 'undefined') {
    return '';
  }

  const token = (window as any).OSCAR_API_TOKEN;
  return typeof token === 'string' ? token.trim() : '';
}

async function createBackendHttpError(response: Response) {
  const detail = await readErrorDetail(response);
  return new BackendHttpError(response.status, detail);
}

export function formatBackendStatusMessage(status: number) {
  if (status === 401) return 'Нет доступа к Oscar backend. Проверь локальный токен и перезапусти UI.';
  if (status === 429) return 'Очередь генерации занята. Попробуй еще раз через несколько секунд.';
  if (status === 503) return 'Oscar backend сейчас не готов. Проверь локальный запуск и настройки токена.';
  if (status >= 500) return 'Oscar backend не смог обработать запрос. Детали остались в backend-логах.';
  if (status === 404) return 'Oscar backend не нашел нужный endpoint. Похоже, frontend и backend разных версий.';
  return `Oscar backend вернул ошибку ${status}.`;
}

async function readErrorDetail(response: Response) {
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = await response.json();
      if (typeof body?.detail === 'string') {
        return body.detail;
      }
      if (body?.detail) {
        return JSON.stringify(body.detail);
      }
      return '';
    }

    return (await response.text()).trim();
  } catch {
    return '';
  }
}

export function drainSseBuffer(buffer: string, flush = false): { events: Array<{ event: string; data: unknown }>; buffer: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const tail = blocks.pop() ?? '';
  const completeBlocks = flush && tail.trim() ? [...blocks, tail] : blocks;
  const events = completeBlocks
    .map((block) => parseSseBlock(block))
    .filter((event): event is { event: string; data: unknown } => event !== null);

  return {
    events,
    buffer: flush ? '' : tail,
  };
}

export function parseSseBlock(block: string): { event: string; data: unknown } | null {
  const event = block
    .split('\n')
    .find((line) => line.startsWith('event:'))
    ?.replace('event:', '')
    .trim();
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.replace('data:', '').trim())
    .join('\n');

  if (!event || !data) return null;

  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}
