import type { MonarchModuleManifest } from '../../core';

const AGENT_SKILL_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    source: { type: 'string', enum: ['manual', 'auto'] },
    scope: { type: 'string', enum: ['project', 'user'] },
    name: { type: 'string', minLength: 1, maxLength: 63 },
    displayName: { type: 'string', minLength: 3, maxLength: 80 },
    description: { type: 'string', minLength: 20, maxLength: 500 },
    instructions: { type: 'string', minLength: 40, maxLength: 8000 },
    examples: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 400 } },
    requiredCapabilities: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 128 } },
    allowImplicitInvocation: { type: 'boolean' },
  },
  required: [
    'schemaVersion', 'source', 'scope', 'name', 'displayName', 'description', 'instructions',
    'examples', 'requiredCapabilities', 'allowImplicitInvocation',
  ],
  additionalProperties: false,
} as const;

export const astraManifest: MonarchModuleManifest = {
  id: 'astra',
  name: 'Monarch Skills',
  version: '0.1.0',
  kind: 'system',
  description: 'Monolithic local skill layer for Oscar-facing capability cards, slot previews, and Monarch skill indexing.',
  owns: [
    'astra',
    'skills',
    'agent cards',
    'slots',
    'oscar integration',
    'навыки',
    'карточки навыков',
    'слоты',
    'интеграция oscar',
  ],
  permissions: ['read', 'write'],
  events: [
    'astra.activated',
    'astra.skill_index.created',
    'astra.slot.previewed',
    'astra.agent_skill.created',
  ],
  capabilities: [
    {
      id: 'astra.skills.index',
      moduleId: 'astra',
      title: 'Index Oscar skills',
      description: 'Return compact Oscar-facing agent cards for active Monarch capabilities.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          includeSystem: { type: 'boolean' },
        },
        additionalProperties: false,
      },

    },
    {
      id: 'astra.skill.explain',
      moduleId: 'astra',
      title: 'Explain skill card',
      description: 'Return one Oscar-facing agent card for a selected Monarch capability.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityId: { type: 'string' },
        },
        required: ['capabilityId'],
        additionalProperties: false,
      },

    },
    {
      id: 'astra.slot.preview',
      moduleId: 'astra',
      title: 'Preview skill slot',
      description: 'Build a read-only preview of the runtime slot Oscar would receive for a capability.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityId: { type: 'string' },
          intentText: { type: 'string' },
        },
        required: ['capabilityId'],
        additionalProperties: false,
      },

    },
    {
      id: 'astra.oscar.bridge.describe',
      moduleId: 'astra',
      title: 'Describe Oscar bridge',
      description: 'Describe the planned local integration contract between Oscar and the monolithic Astra layer.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },

    },
    {
      id: 'astra.agent-skills.list',
      moduleId: 'astra',
      title: 'List Agent Skills',
      description: 'Discover Codex-, Claude Code-, and Monarch-compatible SKILL.md workflows without loading their bodies.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean' },
        },
        additionalProperties: false,
      },

    },
    {
      id: 'astra.agent-skills.match',
      moduleId: 'astra',
      title: 'Match Agent Skills',
      description: 'Rank skills for a prompt using deterministic explicit and implicit invocation rules.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },

    },
    {
      id: 'astra.agent-skills.activate',
      moduleId: 'astra',
      title: 'Activate Agent Skill',
      description: 'Load one selected SKILL.md body and render invocation arguments without bypassing Monarch permissions.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['skill'],
        additionalProperties: false,
      },

    },
    {
      id: 'astra.agent-skills.draft',
      moduleId: 'astra',
      title: 'Draft Agent Skill',
      description: 'Build a deterministic editable local skill draft from a plain-language purpose without writing files.',
      risk: 'read',
      agent: {
        tags: ['skills', 'authoring', 'draft', 'local'],
        effects: [{
          kind: 'skill-draft-observation',
          description: 'Returns a review-required skill draft and its exact hash without filesystem mutation.',
          targetScope: 'agent-state',
        }],
        idempotency: 'idempotent',
        reversibility: 'automatic',
        effectProfile: {
          mutation: 'none',
          targetScope: 'agent-state',
          reversibility: 'automatic',
          privilege: 'normal',
          dataSensitivity: 'private',
          communication: 'none',
          financialImpact: false,
          identityImpact: false,
          securityImpact: false,
        },
        supportedSources: ['desktop', 'api', 'system'],
        estimatedLatency: 'instant',
        computeClass: 'light',
        cancellation: 'unsupported',
        verification: [{
          kind: 'schema',
          description: 'The result must contain a normalized draft, diagnostics, and an exact draft hash.',
          required: true,
        }],
        examples: [{ goal: 'Create an editable skill draft from a short description.' }],
      },
      inputSchema: {
        type: 'object',
        properties: {
          purpose: { type: 'string', minLength: 12, maxLength: 2000 },
          scope: { type: 'string', enum: ['project', 'user'] },
        },
        required: ['purpose'],
        additionalProperties: false,
      },

    },
    {
      id: 'astra.agent-skills.validate',
      moduleId: 'astra',
      title: 'Validate Agent Skill draft',
      description: 'Validate an exact local skill draft, conflicts, capability declarations, and secret-like material without writing files.',
      risk: 'read',
      agent: {
        tags: ['skills', 'authoring', 'validation', 'local'],
        effects: [{
          kind: 'skill-validation-observation',
          description: 'Returns deterministic diagnostics and the canonical draft hash.',
          targetScope: 'agent-state',
        }],
        idempotency: 'idempotent',
        reversibility: 'automatic',
        effectProfile: {
          mutation: 'none',
          targetScope: 'agent-state',
          reversibility: 'automatic',
          privilege: 'normal',
          dataSensitivity: 'private',
          communication: 'none',
          financialImpact: false,
          identityImpact: false,
          securityImpact: false,
        },
        supportedSources: ['desktop', 'api', 'system'],
        estimatedLatency: 'instant',
        computeClass: 'light',
        cancellation: 'unsupported',
        verification: [{
          kind: 'schema',
          description: 'The result must contain validation diagnostics and an exact draft hash.',
          required: true,
        }],
      },
      inputSchema: {
        type: 'object',
        properties: { draft: AGENT_SKILL_DRAFT_SCHEMA },
        required: ['draft'],
        additionalProperties: false,
      },

    },
    {
      id: 'astra.agent-skills.create',
      moduleId: 'astra',
      title: 'Create verified local Agent Skill',
      description: 'Atomically publish an exact validated skill draft and verify it through Astra read-back.',
      risk: 'write',
      agent: {
        tags: ['skills', 'authoring', 'create', 'filesystem', 'local'],
        preconditions: [{
          kind: 'exact-draft-hash',
          description: 'The expectedDraftHash must match the canonical validated draft exactly.',
        }],
        effects: [{
          kind: 'skill-package-create',
          description: 'Creates one new SKILL.md package in the selected Monarch skill root without overwrite.',
          targetScope: 'application',
        }],
        idempotency: 'conditional',
        reversibility: 'manual',
        effectProfile: {
          mutation: 'persistent',
          targetScope: 'application',
          reversibility: 'manual',
          privilege: 'normal',
          dataSensitivity: 'private',
          communication: 'none',
          financialImpact: false,
          identityImpact: false,
          securityImpact: false,
        },
        supportedSources: ['desktop', 'api', 'system'],
        estimatedLatency: 'short',
        computeClass: 'light',
        cancellation: 'supported',
        verification: [{
          kind: 'read-after-write',
          description: 'Astra must rediscover the new package and match the read-back fingerprint.',
          required: true,
          predicate: { kind: 'status', target: 'result.output.verified', value: true },
        }],
        examples: [{ goal: 'Publish the reviewed skill draft as a local project skill.' }],
      },
      inputSchema: {
        type: 'object',
        properties: {
          draft: AGENT_SKILL_DRAFT_SCHEMA,
          expectedDraftHash: { type: 'string', minLength: 64, maxLength: 64 },
        },
        required: ['draft', 'expectedDraftHash'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          created: { type: 'boolean' },
          verified: { type: 'boolean' },
          receipt: { type: 'object' },
          skill: { type: 'object' },
        },
        required: ['created', 'verified', 'receipt', 'skill'],
      },

    },
  ],
};
