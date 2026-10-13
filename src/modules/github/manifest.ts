import type { MonarchAgentCapabilityMetadataInput, MonarchModuleManifest } from '../../core';

const readAgent: MonarchAgentCapabilityMetadataInput = {
  idempotency: 'idempotent' as const,
  cancellation: 'supported' as const,
  estimatedLatency: 'short' as const,
  computeClass: 'light' as const,
  requiredCredentials: ['github-owner-token'],
  supportedSources: ['desktop', 'voice', 'api', 'coder', 'system'],
  effectProfile: {
    mutation: 'none' as const,
    targetScope: 'external-service' as const,
    reversibility: 'manual' as const,
    dataSensitivity: 'private' as const,
    communication: 'third-party' as const,
    financialImpact: false,
    identityImpact: false,
    securityImpact: false,
    privilege: 'normal' as const,
  },
};

const writeAgent: MonarchAgentCapabilityMetadataInput = {
  idempotency: 'non-idempotent' as const,
  cancellation: 'supported' as const,
  estimatedLatency: 'short' as const,
  computeClass: 'light' as const,
  requiredCredentials: ['github-owner-token-write'],
  supportedSources: ['desktop', 'api', 'coder'],
  effectProfile: {
    mutation: 'persistent' as const,
    targetScope: 'external-service' as const,
    reversibility: 'irreversible' as const,
    dataSensitivity: 'private' as const,
    communication: 'third-party' as const,
    financialImpact: false,
    identityImpact: true,
    securityImpact: false,
    privilege: 'normal' as const,
  },
};

const repositoryProperty = { type: 'string',
  pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/(?!\\.\\.?$)[A-Za-z0-9_.-]{1,100}$' } as const;

export const githubManifest: MonarchModuleManifest = {
  id: 'github',
  name: 'GitHub',
  version: '0.1.0',
  stage: 'alpha',
  kind: 'domain',
  description: 'Owner-connected GitHub repositories, files, issues and pull-request collaboration through a protected main-process broker.',
  owns: ['github', 'repositories', 'issues', 'pull-requests'],
  permissions: ['read', 'network'],
  events: ['github.activated'],
  capabilities: [
    {
      id: 'github.connection.status', moduleId: 'github', title: 'Check GitHub connection', risk: 'read',
      description: 'Return the connected account, repository allowlist and granted action classes without exposing the token.',
      agent: { ...readAgent, idempotency: 'idempotent', requiredCredentials: [], estimatedLatency: 'instant',
        effectProfile: { ...readAgent.effectProfile, reversibility: 'automatic', communication: 'none' } },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      id: 'github.repositories.list', moduleId: 'github', title: 'List allowed GitHub repositories', risk: 'network',
      description: 'Return metadata only for repositories explicitly allowed in Monarch Settings.',
      agent: readAgent,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      id: 'github.repository.file.read', moduleId: 'github', title: 'Read one GitHub repository file', risk: 'network',
      description: 'Read one bounded UTF-8 text file from an explicitly allowed repository and ref.',
      agent: readAgent,
      inputSchema: { type: 'object', properties: { repository: repositoryProperty,
        path: { type: 'string', minLength: 1, maxLength: 2048 }, ref: { type: 'string', minLength: 1, maxLength: 255 } },
      required: ['repository', 'path'], additionalProperties: false },
    },
    {
      id: 'github.issues.list', moduleId: 'github', title: 'List GitHub issues', risk: 'network',
      description: 'List bounded issue metadata from an explicitly allowed repository.',
      agent: readAgent,
      inputSchema: { type: 'object', properties: { repository: repositoryProperty,
        state: { type: 'string', enum: ['open', 'closed', 'all'] }, maxResults: { type: 'number', minimum: 1, maximum: 50 } },
      required: ['repository'], additionalProperties: false },
    },
    {
      id: 'github.issue.create', moduleId: 'github', title: 'Create GitHub issue', risk: 'network',
      description: 'Create one issue in an explicitly allowed repository. This posts externally as the connected account.',
      agent: writeAgent,
      inputSchema: { type: 'object', properties: { repository: repositoryProperty,
        title: { type: 'string', minLength: 1, maxLength: 256 }, body: { type: 'string', maxLength: 65536 } },
      required: ['repository', 'title'], additionalProperties: false },
    },
    {
      id: 'github.pull-requests.list', moduleId: 'github', title: 'List GitHub pull requests', risk: 'network',
      description: 'List bounded pull-request metadata from an explicitly allowed repository.',
      agent: readAgent,
      inputSchema: { type: 'object', properties: { repository: repositoryProperty,
        state: { type: 'string', enum: ['open', 'closed', 'all'] }, maxResults: { type: 'number', minimum: 1, maximum: 50 } },
      required: ['repository'], additionalProperties: false },
    },
    {
      id: 'github.pull-request.comment', moduleId: 'github', title: 'Comment on GitHub pull request', risk: 'network',
      description: 'Post one issue-style comment to an exact pull request as the connected account.',
      agent: writeAgent,
      inputSchema: { type: 'object', properties: { repository: repositoryProperty,
        pullNumber: { type: 'number', minimum: 1, maximum: 2147483647 }, body: { type: 'string', minLength: 1, maxLength: 65536 } },
      required: ['repository', 'pullNumber', 'body'], additionalProperties: false },
    },
  ],
};
