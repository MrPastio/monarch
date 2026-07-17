import path from 'node:path';
import type {
  MonarchCapability,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchModuleRecord,
  MonarchPermissionMode,
  MonarchRisk,
  MonarchRouteDecision,
} from '../../core';
import { permissionModeForRisk } from '../../core';
import { astraManifest } from './manifest';
import {
  AgentSkillRegistry,
  getAgentSkillRegistry,
} from './agent-skills';

interface AstraAgentCard {
  id: string;
  capabilityId: string;
  moduleId: string;
  moduleName: string;
  moduleKind: string;
  title: string;
  description: string;
  risk: MonarchRisk;
  permissionMode: MonarchPermissionMode;
  inputSchema?: unknown;
  outputSchema?: unknown;
  routingHints: {
    aliases: string[];
    keywords: string[];
    examples: string[];
    intentKinds: string[];
  };
  whenToUse: string[];
  constraints: string[];
}

interface AstraSlotPreview {
  id: string;
  status: 'preview';
  capabilityId: string;
  moduleId: string;
  agentCardId: string;
  permissionMode: MonarchPermissionMode;
  risk: MonarchRisk;
  requiredInput: string[];
  executionTarget: {
    moduleId: string;
    capabilityId: string;
  };
  contextPack: {
    agentCard: AstraAgentCard;
    inputSchema?: unknown;
    outputSchema?: unknown;
    routingHints: AstraAgentCard['routingHints'];
    intentText?: string;
  };
}

export class AstraModule implements MonarchModule {
  readonly manifest = astraManifest;

  constructor(private readonly agentSkills: AgentSkillRegistry = getAgentSkillRegistry()) {}

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('astra.activated', this.manifest.id, {
      mode: 'monolithic',
      surface: 'kernel-context',
      capabilities: this.manifest.capabilities.length,
    });
  }

  async health(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const cards = createAgentCards(context, { includeSystem: true });
    return {
      ok: true,
      summary: `Astra skill layer ready with ${cards.length} indexed capability cards.`,
      output: {
        mode: 'monolithic',
        cards: cards.length,
      },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    const lower = text.toLowerCase();
    if (!mentionsAstra(lower)) {
      return null;
    }

    if (mentionsAgentSkillSystem(lower)) {
      if (/(activate|invoke|use skill|активир|загрузи|используй навык)/i.test(lower)) {
        return {
          intentId: intent.id,
          targetModuleId: this.manifest.id,
          capabilityId: 'astra.agent-skills.activate',
          confidence: 0.96,
          reason: 'User explicitly asks to activate an Agent Skill.',
          permissionMode: 'allow',
          input: {
            skill: extractAgentSkillName(text),
            prompt: text,
          },
        };
      }
      if (/(match|radar|suggest|recommend|подбери|радар|какой навык)/i.test(lower)) {
        return {
          intentId: intent.id,
          targetModuleId: this.manifest.id,
          capabilityId: 'astra.agent-skills.match',
          confidence: 0.96,
          reason: 'User asks Skill Radar to match a workflow.',
          permissionMode: 'allow',
          input: { query: text, limit: 5 },
        };
      }
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'astra.agent-skills.list',
        confidence: 0.96,
        reason: 'User asks for discovered Agent Skills.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (mentionsAstraBridge(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'astra.oscar.bridge.describe',
        confidence: 0.94,
        reason: 'User asks about Astra/Oscar integration.',
        permissionMode: 'allow',
        input: {},
      };
    }

    if (/(slot|слот|runtime context|контекст)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'astra.slot.preview',
        confidence: 0.94,
        reason: 'User asks Astra to preview a skill slot.',
        permissionMode: 'allow',
        input: {
          capabilityId: extractCapabilityId(text) || '',
          intentText: text,
        },
      };
    }

    if (/(explain|describe|объясн|опиши|карточк)/i.test(lower)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'astra.skill.explain',
        confidence: 0.94,
        reason: 'User asks Astra to explain one skill card.',
        permissionMode: 'allow',
        input: {
          capabilityId: extractCapabilityId(text) || '',
        },
      };
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'astra.skills.index',
      confidence: 0.95,
      reason: 'User asks Astra to index available skills.',
      permissionMode: 'allow',
      input: {
        includeSystem: true,
      },
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'astra.skills.index':
      return this.indexSkills(request.input, context);
    case 'astra.skill.explain':
      return this.explainSkill(request.input, context);
    case 'astra.slot.preview':
      return this.previewSlot(request.input, context);
    case 'astra.oscar.bridge.describe':
      return this.describeOscarBridge();
    case 'astra.agent-skills.list':
      return this.listAgentSkills(request.input);
    case 'astra.agent-skills.match':
      return this.matchAgentSkills(request.input);
    case 'astra.agent-skills.activate':
      return this.activateAgentSkill(request.input);
    default:
      return {
        ok: false,
        summary: `Unsupported Astra capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async indexSkills(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const includeSystem = readBooleanInput(input, 'includeSystem', true);
    const cards = createAgentCards(context, { includeSystem });
    const modules = summarizeModules(context, { includeSystem });

    await context.emit('astra.skill_index.created', this.manifest.id, {
      cards: cards.length,
      modules: modules.length,
      includeSystem,
    });

    return {
      ok: true,
      summary: `Astra indexed ${cards.length} Oscar-facing skill cards.`,
      output: {
        mode: 'monolithic',
        cards,
        modules,
      },
    };
  }

  private explainSkill(
    input: unknown,
    context: MonarchKernelContext
  ): MonarchExecutionResult {
    const capabilityId = readStringInput(input, 'capabilityId');
    if (!capabilityId) {
      return {
        ok: false,
        summary: 'Astra skill explanation requires capabilityId.',
        error: 'missing-capability-id',
      };
    }

    const card = createAgentCardForCapabilityId(context, capabilityId);
    if (!card) {
      return {
        ok: false,
        summary: `Astra could not find capability: ${capabilityId}`,
        error: 'capability-not-found',
      };
    }

    return {
      ok: true,
      summary: `Astra explained skill card ${card.id}.`,
      output: { card },
    };
  }

  private async previewSlot(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const capabilityId = readStringInput(input, 'capabilityId');
    if (!capabilityId) {
      return {
        ok: false,
        summary: 'Astra slot preview requires capabilityId.',
        error: 'missing-capability-id',
      };
    }

    const slot = createSlotPreview(context, capabilityId, readStringInput(input, 'intentText'));
    if (!slot) {
      return {
        ok: false,
        summary: `Astra could not create a slot for unknown capability: ${capabilityId}`,
        error: 'capability-not-found',
      };
    }

    await context.emit('astra.slot.previewed', this.manifest.id, {
      slotId: slot.id,
      capabilityId: slot.capabilityId,
      moduleId: slot.moduleId,
    });

    return {
      ok: true,
      summary: `Astra prepared slot preview ${slot.id}.`,
      output: { slot },
    };
  }

  private describeOscarBridge(): MonarchExecutionResult {
    const oscarProjectRoot = process.env.OSCAR_PROJECT_ROOT || path.join(process.cwd(), 'oscar');
    const oscarApiBase = process.env.OSCAR_API_BASE || 'http://127.0.0.1:7861';

    return {
      ok: true,
      summary: 'Astra/Oscar bridge contract described.',
      output: {
        mode: 'planned-local-bridge',
        oscar: {
          projectRoot: oscarProjectRoot,
          apiBase: oscarApiBase,
          knownEndpoints: [
            'GET /api/health',
            'GET /api/model/status',
            'GET /api/memory/stats',
            'GET /api/memory/search?q=<query>&limit=<n>',
            'POST /api/search',
            'POST /api/chat',
            'POST /api/chat/stream',
          ],
        },
        monarch: {
          astraCapabilities: this.manifest.capabilities.map((capability) => capability.id),
          oscarPortCapabilities: [
            'oscar.status',
            'oscar.chat.local',
            'oscar.chat.web',
            'oscar.memory.search',
            'oscar.search.ingest',
          ],
          intendedFlow: [
            'Oscar-compatible requests enter Monarch through the oscar module or /api/intent.',
            'Astra exposes compact skill cards through astra.skills.index.',
            'Oscar requests astra.slot.preview before using a risky or unfamiliar capability.',
            'Monarch keeps execution, permissions, routing trace, and audit inside the local runtime.',
          ],
        },
        nextStep: 'Replace the temporary Oscar HTTP adapter capability by capability with native Monarch implementations.',
      },
    };
  }

  private async listAgentSkills(input: unknown): Promise<MonarchExecutionResult> {
    const skills = await this.agentSkills.list({
      refresh: readBooleanInput(input, 'refresh', false),
    });
    return {
      ok: true,
      summary: `Astra discovered ${skills.length} Agent Skills with progressive disclosure.`,
      output: {
        skills,
        counts: {
          project: skills.filter((skill) => skill.scope === 'project').length,
          user: skills.filter((skill) => skill.scope === 'user').length,
          system: skills.filter((skill) => skill.scope === 'system').length,
        },
      },
    };
  }

  private async matchAgentSkills(input: unknown): Promise<MonarchExecutionResult> {
    const query = readStringInput(input, 'query');
    if (!query) {
      return {
        ok: false,
        summary: 'Skill Radar requires a query.',
        error: 'missing-skill-query',
      };
    }
    const matches = await this.agentSkills.match(query, {
      limit: readNumberInput(input, 'limit', 5, 1, 20),
    });
    return {
      ok: true,
      summary: matches.length
        ? `Skill Radar matched ${matches.length} workflows.`
        : 'Skill Radar found no confident workflow match.',
      output: { query, matches },
    };
  }

  private async activateAgentSkill(input: unknown): Promise<MonarchExecutionResult> {
    const skillName = readStringInput(input, 'skill');
    if (!skillName) {
      return {
        ok: false,
        summary: 'Agent Skill activation requires a skill name or id.',
        error: 'missing-skill-name',
      };
    }
    const prompt = readStringInput(input, 'prompt');
    const knownSkill = (await this.agentSkills.list()).find((candidate) => (
      candidate.id.toLowerCase() === skillName.toLowerCase()
      || candidate.name.toLowerCase() === skillName.toLowerCase()
    ));
    if (knownSkill && !knownSkill.compatible) {
      return {
        ok: false,
        summary: `Agent Skill ${knownSkill.name} is not compatible with this operating system.`,
        error: 'skill-platform-incompatible',
        output: { skill: knownSkill },
      };
    }
    const skill = await this.agentSkills.activate(skillName, prompt, { explicit: true });
    if (!skill) {
      return {
        ok: false,
        summary: `Agent Skill was not found: ${skillName}`,
        error: 'skill-not-found',
      };
    }
    return {
      ok: true,
      summary: `Activated Agent Skill ${skill.name}; its body was loaded only now.`,
      output: { skill },
      metadata: {
        permissionsPreserved: true,
        allowedToolsAreAdvisory: true,
      },
    };
  }
}

function createAgentCards(
  context: MonarchKernelContext,
  options: { includeSystem: boolean }
): AstraAgentCard[] {
  return context
    .listModules()
    .filter((record) => shouldExposeModule(record, options))
    .flatMap((record) => context
      .listCapabilities(record.manifest.id)
      .map((capability) => createAgentCard(record, capability)));
}

function createAgentCardForCapabilityId(
  context: MonarchKernelContext,
  capabilityId: string
): AstraAgentCard | null {
  const capability = context.getCapability(capabilityId);
  if (!capability) {
    return null;
  }

  const moduleRecord = context
    .listModules()
    .find((record) => record.manifest.id === capability.moduleId);
  if (!moduleRecord) {
    return null;
  }

  return createAgentCard(moduleRecord, capability);
}

function createAgentCard(
  moduleRecord: MonarchModuleRecord,
  capability: MonarchCapability
): AstraAgentCard {
  const routing = capability.routing || {};
  const permissionMode = permissionModeForRisk(capability.risk);

  return {
    id: createAgentCardId(capability),
    capabilityId: capability.id,
    moduleId: capability.moduleId,
    moduleName: moduleRecord.manifest.name,
    moduleKind: moduleRecord.manifest.kind,
    title: capability.title,
    description: capability.description || moduleRecord.manifest.description,
    risk: capability.risk,
    permissionMode,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    routingHints: {
      aliases: routing.aliases || [],
      keywords: routing.keywords || [],
      examples: routing.examples || [],
      intentKinds: routing.intentKinds || [],
    },
    whenToUse: createWhenToUse(moduleRecord, capability),
    constraints: createConstraints(capability.risk, permissionMode),
  };
}

function createSlotPreview(
  context: MonarchKernelContext,
  capabilityId: string,
  intentText: string
): AstraSlotPreview | null {
  const card = createAgentCardForCapabilityId(context, capabilityId);
  if (!card) {
    return null;
  }

  const contextPack: AstraSlotPreview['contextPack'] = {
    agentCard: card,
    inputSchema: card.inputSchema,
    outputSchema: card.outputSchema,
    routingHints: card.routingHints,
  };
  if (intentText) {
    contextPack.intentText = intentText;
  }

  return {
    id: createSlotId(card),
    status: 'preview',
    capabilityId: card.capabilityId,
    moduleId: card.moduleId,
    agentCardId: card.id,
    permissionMode: card.permissionMode,
    risk: card.risk,
    requiredInput: requiredInputKeys(card.inputSchema),
    executionTarget: {
      moduleId: card.moduleId,
      capabilityId: card.capabilityId,
    },
    contextPack,
  };
}

function summarizeModules(
  context: MonarchKernelContext,
  options: { includeSystem: boolean }
): Array<Record<string, unknown>> {
  return context
    .listModules()
    .filter((record) => shouldExposeModule(record, options))
    .map((record) => ({
      id: record.manifest.id,
      name: record.manifest.name,
      kind: record.manifest.kind,
      status: record.status,
      owns: record.manifest.owns,
      capabilities: context.listCapabilities(record.manifest.id).length,
    }));
}

function shouldExposeModule(
  record: MonarchModuleRecord,
  options: { includeSystem: boolean }
): boolean {
  if (record.status !== 'active') {
    return false;
  }
  return options.includeSystem || record.manifest.kind !== 'system';
}

function createAgentCardId(capability: MonarchCapability): string {
  return `astra.card.${capability.id}.v1`;
}

function createSlotId(card: AstraAgentCard): string {
  return `slot.${card.capabilityId}.preview.v1`;
}

function createWhenToUse(
  moduleRecord: MonarchModuleRecord,
  capability: MonarchCapability
): string[] {
  const hints = [
    ...moduleRecord.manifest.owns,
    ...(capability.routing?.intentKinds || []),
    ...(capability.routing?.aliases || []),
  ].filter(Boolean);

  if (hints.length === 0) {
    return [`Use when Oscar needs ${capability.title}.`];
  }

  return [
    `Use for ${capability.title}.`,
    `Domain hints: ${hints.slice(0, 8).join(', ')}.`,
  ];
}

function createConstraints(
  risk: MonarchRisk,
  permissionMode: MonarchPermissionMode
): string[] {
  const constraints = [
    'Call through Monarch execution only; do not bypass the module boundary.',
    'Provide input that matches the declared schema.',
  ];

  if (permissionMode === 'confirm') {
    constraints.push(`Requires user confirmation because risk is ${risk}.`);
  }
  if (permissionMode === 'deny') {
    constraints.push(`Blocked by default because risk is ${risk}.`);
  }

  return constraints;
}

function requiredInputKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === 'string')
    : [];
}

function mentionsAstra(text: string): boolean {
  return /(astra|skill|skills|agent card|slot|bridge|integration|астра|навык|навыки|карточк|слот|интеграц)/i.test(text)
    || containsRussianBridgeTerm(text);
}

function mentionsAstraBridge(text: string): boolean {
  return /\b(?:bridge|integration)\b|интеграц/i.test(text)
    || containsRussianBridgeTerm(text);
}

function containsRussianBridgeTerm(text: string): boolean {
  return /(?:^|[^\p{L}\p{N}_])(?:мост(?:а|ом|у|ы|е|ах|ами)?|связ(?:ь|и|ью|ям|ями|ях)?)(?=$|[^\p{L}\p{N}_])/iu.test(text);
}

function mentionsAgentSkillSystem(text: string): boolean {
  return /(agent skills?|skill\.md|codex skills?|claude skills?|skill radar|систем[аыу] навыков|радар навыков|навык skill\.md)/i.test(text);
}

function extractAgentSkillName(text: string): string {
  const explicit = text.match(/(?:^|\s)[$/]([a-z0-9][a-z0-9:_-]{0,127})(?=\s|$)/i)?.[1];
  if (explicit) return explicit;
  return text.match(/(?:skill|навык)\s+([a-z0-9][a-z0-9:_-]{1,127})/i)?.[1] || '';
}

function extractCapabilityId(text: string): string {
  const match = text.match(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9_-]+)+\b/i);
  return match?.[0] || '';
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readBooleanInput(input: unknown, key: string, fallback: boolean): boolean {
  if (!input || typeof input !== 'object') {
    return fallback;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readNumberInput(
  input: unknown,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (!input || typeof input !== 'object') return fallback;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function createAstraModule(): MonarchModule {
  return new AstraModule();
}

export const astraModulePackage: MonarchModulePackage = {
  id: astraManifest.id,
  moduleId: astraManifest.id,
  version: astraManifest.version,
  description: astraManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createAstraModule,
};
