import type { MonarchModulePackage } from '../../core';
import { BrokeredServiceModule, type ServiceHostTransport } from '../service-host';
import { GitHubHostTransport } from './host-transport';
import { githubManifest } from './manifest';

export class GitHubModule extends BrokeredServiceModule {
  constructor(transport: ServiceHostTransport = new GitHubHostTransport()) {
    super({
      manifest: githubManifest,
      transport,
      operationByCapability: {
        'github.connection.status': 'status',
        'github.repositories.list': 'repositories.list',
        'github.repository.file.read': 'repository.file.read',
        'github.issues.list': 'issues.list',
        'github.issue.create': 'issue.create',
        'github.pull-requests.list': 'pull-requests.list',
        'github.pull-request.comment': 'pull-request.comment',
      },
      summarize: summaryFor,
      failureSummary: githubFailure,
    });
  }
}

function summaryFor(operation: string, output: Record<string, unknown>): string {
  if (operation === 'status') return output.connected ? 'GitHub connected.' : 'GitHub is not connected.';
  if (operation === 'repositories.list') return `GitHub returned ${Array.isArray(output.repositories) ? output.repositories.length : 0} allowed repositories.`;
  if (operation === 'repository.file.read') return 'GitHub repository file read.';
  if (operation === 'issues.list') return `GitHub returned ${Array.isArray(output.issues) ? output.issues.length : 0} issues.`;
  if (operation === 'issue.create') return 'GitHub issue created.';
  if (operation === 'pull-requests.list') return `GitHub returned ${Array.isArray(output.pullRequests) ? output.pullRequests.length : 0} pull requests.`;
  return 'GitHub pull-request comment posted.';
}

function githubFailure(code: string): string {
  if (code === 'github:not-connected') return 'GitHub не подключён. Открой Настройки → Интеграции → GitHub.';
  if (code === 'github:repository-denied') return 'Этот репозиторий не разрешён в настройках GitHub Monarch.';
  if (code === 'github:permission-required') return 'Для этого действия не выдано нужное разрешение GitHub.';
  if (code === 'github:authentication') return 'GitHub token недействителен или отозван. Подключи GitHub заново.';
  return 'GitHub не выполнил запрос.';
}

export const githubModulePackage: MonarchModulePackage = {
  id: githubManifest.id,
  moduleId: githubManifest.id,
  version: githubManifest.version,
  description: githubManifest.description,
  core: { minVersion: '0.1.0' },
  factory: () => new GitHubModule(),
};
