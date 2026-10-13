import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
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
