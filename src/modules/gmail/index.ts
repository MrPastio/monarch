import type { MonarchModulePackage } from '../../core';
import { BrokeredServiceModule, type ServiceHostTransport } from '../service-host';
import { GmailHostTransport } from './host-transport';
import { gmailManifest } from './manifest';

export class GmailModule extends BrokeredServiceModule {
  constructor(transport: ServiceHostTransport = new GmailHostTransport()) {
    super({
      manifest: gmailManifest,
      transport,
      operationByCapability: {
        'gmail.connection.status': 'status',
        'gmail.messages.search': 'messages.search',
        'gmail.message.read': 'message.read',
        'gmail.draft.create': 'draft.create',
        'gmail.draft.send': 'draft.send',
      },
      summarize: summaryFor,
      failureSummary: gmailFailure,
    });
  }
}

function summaryFor(operation: string, output: Record<string, unknown>): string {
  if (operation === 'status') return output.connected ? 'Gmail connected.' : 'Gmail is not connected.';
  if (operation === 'messages.search') return `Gmail returned ${Array.isArray(output.messages) ? output.messages.length : 0} message metadata records.`;
  if (operation === 'message.read') return 'Gmail message read.';
  if (operation === 'draft.create') return 'Gmail draft created.';
  return 'Gmail draft sent.';
}
function gmailFailure(code: string): string {
  if (code === 'gmail:not-connected') return 'Gmail не подключён. Открой Настройки → Интеграции → Gmail.';
  if (code === 'gmail:scope-required') return 'Для этого действия не выдано нужное разрешение Gmail.';
  if (code === 'gmail:authentication') return 'Подключение Gmail истекло. Подключи аккаунт заново.';
  return 'Gmail не выполнил запрос.';
}

export const gmailModulePackage: MonarchModulePackage = {
  id: gmailManifest.id, moduleId: gmailManifest.id, version: gmailManifest.version,
  description: gmailManifest.description, core: { minVersion: '0.1.0' }, factory: () => new GmailModule(),
};
