import { describe, expect, it } from 'vitest';
import {
  normalizeSharingBaseUrl,
  SharingModule,
  type MonarchSharingClient,
  type MonarchSharingConnection,
  type MonarchSharingStatus,
} from '../../src/modules/sharing';
import { builtInModulePackages } from '../../src/modules/catalog';

const connection: MonarchSharingConnection = {
  baseUrl: 'http://127.0.0.1:7861/v1',
  endpoints: {
    models: 'http://127.0.0.1:7861/v1/models',
    chatCompletions: 'http://127.0.0.1:7861/v1/chat/completions',
    audioModels: 'http://127.0.0.1:7861/v1/audio/models',
    audioSpeech: 'http://127.0.0.1:7861/v1/audio/speech',
  },
  authentication: {
    type: 'bearer',
    tokenPath: 'E:\\Monarch\\secrets\\oscar_token.txt',
    configured: true,
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

class StubSharingClient implements MonarchSharingClient {
  constructor(private readonly current: MonarchSharingStatus) {}

  connection(): MonarchSharingConnection {
    return connection;
  }

  async status(): Promise<MonarchSharingStatus> {
    return this.current;
  }
}

describe('Monarch Sharing module', () => {
  it('is registered as a built-in package with model and Oscar dependencies', () => {
    const sharing = builtInModulePackages.find((entry) => entry.id === 'sharing');

    expect(sharing?.moduleId).toBe('sharing');
    const module = sharing?.factory({} as never);
    expect(module?.manifest.dependencies).toEqual(['models', 'oscar']);
  });

  it('routes connection requests and exposes no token value', async () => {
    const module = new SharingModule(new StubSharingClient({
      connected: true,
      connection,
      models: ['monarch-auto', 'monarch-fast'],
      ttsModels: ['qwen3-tts-0.6b-base'],
    }));
    const route = await module.handleIntent({
      id: 'intent_sharing_connection',
      text: 'как подключить локальную модель к Monarch Sharing API',
      source: 'test',
      createdAt: new Date(0).toISOString(),
    });
    const result = await module.executeCapability({
      id: 'exec_sharing_connection',
      intentId: 'intent_sharing_connection',
      moduleId: 'sharing',
      capabilityId: 'sharing.connection.get',
      input: {},
      createdAt: new Date(0).toISOString(),
      requestedBy: 'test',
    });

    expect(route?.capabilityId).toBe('sharing.connection.get');
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      connection: {
        baseUrl: 'http://127.0.0.1:7861/v1',
        authentication: {
          type: 'bearer',
          configured: true,
        },
      },
    });
    expect(JSON.stringify(result.output)).not.toContain('sharing-test-token');
  });

  it('reports exposed model IDs through a read-only capability', async () => {
    const module = new SharingModule(new StubSharingClient({
      connected: true,
      connection,
      models: ['monarch-auto', 'monarch-balanced'],
      ttsModels: [],
    }));

    const result = await module.executeCapability({
      id: 'exec_sharing_models',
      intentId: 'intent_sharing_models',
      moduleId: 'sharing',
      capabilityId: 'sharing.models.list',
      input: {},
      createdAt: new Date(0).toISOString(),
      requestedBy: 'test',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      models: ['monarch-auto', 'monarch-balanced'],
    });
  });

  it('normalizes Oscar root URLs to /v1 and rejects non-loopback control planes', () => {
    expect(normalizeSharingBaseUrl('http://127.0.0.1:7861')).toBe('http://127.0.0.1:7861/v1');
    expect(normalizeSharingBaseUrl('http://localhost:7861/api')).toBe('http://localhost:7861/v1');
    expect(() => normalizeSharingBaseUrl('https://models.example.com')).toThrow(/loopback/i);
  });
});
