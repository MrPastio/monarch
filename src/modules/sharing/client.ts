import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_SHARING_BASE_URL = 'http://127.0.0.1:7861/v1';
const DEFAULT_TIMEOUT_MS = 5000;

export interface MonarchSharingConnection {
  baseUrl: string;
  endpoints: {
    models: string;
    chatCompletions: string;
    audioModels: string;
    audioSpeech: string;
  };
  authentication: {
    type: 'bearer';
    tokenPath: string;
    configured: boolean;
  };
  compatibility: {
    api: 'OpenAI';
    chatCompletions: true;
    streaming: true;
    modelDiscovery: true;
    speech: true;
    offlineInference: true;
  };
  defaultBinding: '127.0.0.1';
}

export interface MonarchSharingStatus {
  connected: boolean;
  connection: MonarchSharingConnection;
  models: string[];
  ttsModels: string[];
  ttsError?: string;
  error?: string;
}

interface OpenAiModelsResponse {
  data?: Array<{ id?: unknown }>;
}

export interface MonarchSharingClient {
  connection(): MonarchSharingConnection;
  status(): Promise<MonarchSharingStatus>;
}

export class LocalMonarchSharingClient implements MonarchSharingClient {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly projectRoot = process.cwd(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  connection(): MonarchSharingConnection {
    const baseUrl = normalizeSharingBaseUrl(
      this.env.MONARCH_SHARING_BASE_URL || this.env.OSCAR_API_BASE || DEFAULT_SHARING_BASE_URL
    );
    const tokenPath = path.join(this.projectRoot, 'secrets', 'oscar_token.txt');
    return {
      baseUrl,
      endpoints: {
        models: `${baseUrl}/models`,
        chatCompletions: `${baseUrl}/chat/completions`,
        audioModels: `${baseUrl}/audio/models`,
        audioSpeech: `${baseUrl}/audio/speech`,
      },
      authentication: {
        type: 'bearer',
        tokenPath,
        configured: Boolean(readApiToken(this.env, tokenPath)),
      },
      compatibility: {
        api: 'OpenAI',
        chatCompletions: true,
        streaming: true,
        modelDiscovery: true,
        speech: true,
        offlineInference: true,
      },
      defaultBinding: '127.0.0.1',
    };
  }

  async status(): Promise<MonarchSharingStatus> {
    let connection: MonarchSharingConnection;
    try {
      connection = this.connection();
    } catch (error) {
      return {
        connected: false,
        connection: fallbackConnection(this.projectRoot),
        models: [],
        ttsModels: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const token = readApiToken(this.env, connection.authentication.tokenPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), configuredTimeout(this.env));
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await this.fetchImpl(connection.endpoints.models, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          connected: false,
          connection,
          models: [],
          ttsModels: [],
          error: `Monarch Sharing returned HTTP ${response.status}.`,
        };
      }
      const payload = await response.json() as OpenAiModelsResponse;
      const models = (payload.data || [])
        .map((entry) => typeof entry.id === 'string' ? entry.id.trim() : '')
        .filter(Boolean);
      let ttsModels: string[] = [];
      let ttsError: string | undefined;
      try {
        const ttsResponse = await this.fetchImpl(connection.endpoints.audioModels, {
          headers,
          signal: controller.signal,
        });
        if (!ttsResponse.ok) {
          ttsError = `Monarch Sharing TTS returned HTTP ${ttsResponse.status}.`;
        } else {
          const ttsPayload = await ttsResponse.json() as OpenAiModelsResponse;
          ttsModels = (ttsPayload.data || [])
            .map((entry) => typeof entry.id === 'string' ? entry.id.trim() : '')
            .filter(Boolean);
        }
      } catch (error) {
        ttsError = error instanceof Error ? error.message : String(error);
      }
      return { connected: true, connection, models, ttsModels, ...(ttsError ? { ttsError } : {}) };
    } catch (error) {
      return {
        connected: false,
        connection,
        models: [],
        ttsModels: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeSharingBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Monarch Sharing base URL must use http or https.');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('Monarch Sharing control-plane only accepts loopback endpoints.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') {
    url.pathname = '/v1';
  } else if (pathname === '/api') {
    url.pathname = '/v1';
  } else if (!pathname.endsWith('/v1')) {
    url.pathname = `${pathname}/v1`;
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function readApiToken(env: NodeJS.ProcessEnv, tokenPath: string): string {
  const fromEnv = env.OSCAR_API_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (!existsSync(tokenPath)) {
    return '';
  }
  try {
    return readFileSync(tokenPath, 'utf8').trim().replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function configuredTimeout(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.MONARCH_SHARING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(parsed) ? Math.max(250, Math.min(parsed, 30000)) : DEFAULT_TIMEOUT_MS;
}

function fallbackConnection(projectRoot: string): MonarchSharingConnection {
  const tokenPath = path.join(projectRoot, 'secrets', 'oscar_token.txt');
  return {
    baseUrl: DEFAULT_SHARING_BASE_URL,
    endpoints: {
      models: `${DEFAULT_SHARING_BASE_URL}/models`,
      chatCompletions: `${DEFAULT_SHARING_BASE_URL}/chat/completions`,
      audioModels: `${DEFAULT_SHARING_BASE_URL}/audio/models`,
      audioSpeech: `${DEFAULT_SHARING_BASE_URL}/audio/speech`,
    },
    authentication: { type: 'bearer', tokenPath, configured: false },
    compatibility: {
      api: 'OpenAI',
      chatCompletions: true,
      streaming: true,
      modelDiscovery: true,
      speech: true,
      offlineInference: true,
    },
    defaultBinding: '127.0.0.1',
  };
}
