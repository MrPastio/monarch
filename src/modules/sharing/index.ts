import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import {
  LocalMonarchSharingClient,
  type MonarchSharingClient,
} from './client';
import { sharingManifest } from './manifest';

export class SharingModule implements MonarchModule {
  readonly manifest = sharingManifest;

  constructor(
    private readonly client: MonarchSharingClient = new LocalMonarchSharingClient()
  ) {}

  async activate(context: MonarchKernelContext): Promise<void> {
    const connection = this.client.connection();
    await context.emit('sharing.activated', this.manifest.id, {
      baseUrl: connection.baseUrl,
      compatibility: connection.compatibility.api,
      offlineInference: connection.compatibility.offlineInference,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: 'Monarch Sharing control surface is ready; runtime availability is checked separately.',
      output: { connection: this.client.connection() },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.toLowerCase();
    if (!mentionsSharing(text)) {
      return null;
    }
    if (/(status|health|ready|работает|статус|доступен)/i.test(text)) {
      return decision(intent.id, 'sharing.status', 'User asks for Monarch Sharing runtime status.');
    }
    if (/(connect|connection|endpoint|base url|api key|подключ|адрес|ключ|куда)/i.test(text)) {
      return decision(intent.id, 'sharing.connection.get', 'User asks how to connect to Monarch Sharing.');
    }
    if (/(model|models|модел)/i.test(text)) {
      return decision(intent.id, 'sharing.models.list', 'User asks which local models Sharing exposes.');
    }
    return decision(intent.id, 'sharing.connection.get', 'User asks how to connect to Monarch Sharing.');
  }

  async executeCapability(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'sharing.connection.get': {
      const connection = this.client.connection();
      return {
        ok: true,
        summary: `Monarch Sharing is available at ${connection.baseUrl}.`,
        output: { connection },
      };
    }
    case 'sharing.status': {
      const status = await this.client.status();
      return {
        ok: status.connected,
        summary: status.connected
          ? `Monarch Sharing is online with ${status.models.length} exposed model IDs.`
          : `Monarch Sharing is offline: ${status.error || 'local endpoint unavailable'}`,
        output: { status },
        ...(status.connected ? {} : { error: 'sharing-offline' }),
      };
    }
    case 'sharing.models.list': {
      const status = await this.client.status();
      return {
        ok: status.connected,
        summary: status.connected
          ? `Monarch Sharing exposes ${status.models.length} model IDs.`
          : `Cannot list Sharing models: ${status.error || 'local endpoint unavailable'}`,
        output: { models: status.models, connection: status.connection },
        ...(status.connected ? {} : { error: 'sharing-offline' }),
      };
    }
    default:
      return {
        ok: false,
        summary: `Unsupported sharing capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }
}

function mentionsSharing(text: string): boolean {
  return /\b(monarch sharing|sharing|shared model|local (?:ai|model) api|openai compatible|api server)\b/i.test(text)
    || /(шаринг|расшар|подключить.{0,24}(?:модел|нейрон)|локальн.{0,12}api|api.{0,12}модел)/i.test(text);
}

function decision(
  intentId: string,
  capabilityId: string,
  reason: string
): MonarchRouteDecision {
  return {
    intentId,
    targetModuleId: sharingManifest.id,
    capabilityId,
    confidence: 0.9,
    reason,
    permissionMode: 'allow',
    input: {},
  };
}

export function createSharingModule(): MonarchModule {
  return new SharingModule();
}

export const sharingModulePackage: MonarchModulePackage = {
  id: sharingManifest.id,
  moduleId: sharingManifest.id,
  version: sharingManifest.version,
  description: sharingManifest.description,
  core: { minVersion: '0.1.0' },
  factory: createSharingModule,
};

export * from './client';
export * from './manifest';
