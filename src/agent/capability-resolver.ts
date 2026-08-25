import type {
  MonarchAgentCapabilitySource,
  MonarchCapability,
  MonarchPermissionProfile,
  MonarchResolvedAgentCapabilityMetadata,
} from '../core/contracts';
import { resolveAgentCapabilityMetadata, supportsBoundedAgentExecution } from '../core/capability-metadata';
import { isComputerUseInvocation } from '../core/oscar-function-invocation';
import {
  evaluateRequiredRuntimes,
  type AgentRuntimeAvailabilitySnapshot,
} from './runtime-availability';

export interface AgentCapabilityResolverInput {
  goal: string;
  /** Runtime-owned capabilities required by the typed goal contract. */
  requiredCapabilityIds?: readonly string[];
  /** Model-authored, non-authoritative relevance query from discover-tools. */
  discoveryQuery?: string;
  currentStep?: string;
  recentObservationSummaries?: readonly string[];
  source: MonarchAgentCapabilitySource;
  capabilities: readonly MonarchCapability[];
  moduleStates?: Readonly<Record<string, 'active' | 'degraded' | 'inactive' | 'failed' | 'unavailable'>>;
  runtimeAvailability?: readonly AgentRuntimeAvailabilitySnapshot[];
  availableCredentialRefs?: ReadonlySet<string>;
  permissionProfile?: MonarchPermissionProfile;
  minimum?: number;
  maximum?: number;
}

export interface AgentCapabilityCard {
  id: string;
  moduleId: string;
  title: string;
  description: string;
  risk: MonarchCapability['risk'];
  inputSchema?: MonarchCapability['inputSchema'];
  outputSchema?: MonarchCapability['outputSchema'];
  metadata: MonarchResolvedAgentCapabilityMetadata;
  score: number;
  reasons: string[];
  warnings: string[];
}

export interface AgentCapabilityExclusion {
  capabilityId: string;
  reason: string;
}

export interface AgentCapabilityResolverDiagnostics {
  requestedRange: { minimum: number; maximum: number };
  considered: number;
  included: Array<{ capabilityId: string; score: number; reasons: string[]; warnings: string[] }>;
  excluded: AgentCapabilityExclusion[];
  policy: {
    sandboxMode?: MonarchPermissionProfile['sandboxMode'];
    approvalPolicy?: MonarchPermissionProfile['approvalPolicy'];
    autonomyMode?: MonarchPermissionProfile['autonomyMode'];
  };
}

export interface AgentCapabilityResolverResult {
  groups: AgentCapabilityGroup[];
  cards: AgentCapabilityCard[];
  capabilities: MonarchCapability[];
  diagnostics: AgentCapabilityResolverDiagnostics;
}

export interface AgentCapabilityGroup {
  moduleId: string;
  count: number;
  sampleCapabilityIds: string[];
}

/**
 * The resolver is a relevance layer, not an authorization layer.  A broad
 * operational window lets Oscar keep the primitives needed by a multi-step
 * task while Kernel preflight remains the only execution authority.
 */
export const DEFAULT_AGENT_CAPABILITY_MINIMUM = 8;
export const DEFAULT_AGENT_CAPABILITY_MAXIMUM = 24;
export const ABSOLUTE_AGENT_CAPABILITY_MAXIMUM = 24;

const RUNTIME_OWNED_MODEL_CAPABILITIES = new Set([
  'models.catalog.list',
  'models.runtime.status',
  'models.chat.select',
  'models.router.pipeline',
  'models.chat.complete',
]);

interface AgentRoutingHints {
  applicationLaunch: boolean;
  browserTarget: boolean;
  fileTarget: boolean;
  fileContentRead: boolean;
  batchFileRead: boolean;
  recoverableRemoval: boolean;
  permanentRemoval: boolean;
}

const ROUTING_META_TOKENS = new Set([
  'please', 'could', 'would', 'only', 'real', 'really', 'verified', 'verify',
  'result', 'results', 'output', 'success', 'exit', 'code', 'show', 'return',
  'пожалуйста', 'плиз', 'можешь', 'только', 'реально', 'реальный', 'проверенный',
  'проверено', 'проверь', 'результат', 'результаты', 'вывод', 'успех', 'код',
  'покажи', 'показать', 'верни',
]);

export function resolveAgentCapabilities(input: AgentCapabilityResolverInput): AgentCapabilityResolverResult {
  const minimum = clampInteger(
    input.minimum ?? DEFAULT_AGENT_CAPABILITY_MINIMUM,
    1,
    ABSOLUTE_AGENT_CAPABILITY_MAXIMUM,
  );
  const maximum = clampInteger(
    input.maximum ?? DEFAULT_AGENT_CAPABILITY_MAXIMUM,
    minimum,
    ABSOLUTE_AGENT_CAPABILITY_MAXIMUM,
  );
  const relevantStep = isGenericAgentPlanStep(input.currentStep || '')
    ? ''
    : input.currentStep || '';
  const routingText = [
    input.goal,
    relevantStep,
    input.discoveryQuery || '',
  ].join(' ');
  const computerUseOnly = isComputerUseInvocation(input.goal);
  // Observation/tool text is untrusted evidence. It remains available to the
  // model context, but it cannot steer which effectful tools enter the bounded
  // candidate window.
  const query = tokenizeRoutingQuery(routingText);
  const discoveryQuery = tokenizeRoutingQuery(input.discoveryQuery || '');
  const routingHints = deriveRoutingHints(routingText);
  const requiredCapabilityIds = [...new Set(
    (input.requiredCapabilityIds || [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .slice(0, ABSOLUTE_AGENT_CAPABILITY_MAXIMUM),
  )];
  const requiredCapabilityIdSet = new Set(requiredCapabilityIds);
  const runtimeById = new Map((input.runtimeAvailability || []).map((entry) => [entry.runtimeId, entry]));
  const excluded: AgentCapabilityExclusion[] = [];
  const eligible: Array<{ capability: MonarchCapability; card: AgentCapabilityCard }> = [];

  for (const capability of input.capabilities) {
    const computerUseBootstrapCapability = capability.id === 'device.app.open';
    if (computerUseOnly && !computerUseBootstrapCapability && (
      capability.moduleId !== 'computer'
      || capability.id === 'computer.control.start'
      || capability.id === 'computer.control.stop'
    )) {
      excluded.push({ capabilityId: capability.id, reason: 'explicit-computer-use-function-boundary' });
      continue;
    }
    const exclusion = exclusionReason(capability, input, runtimeById);
    if (exclusion) {
      excluded.push({ capabilityId: capability.id, reason: exclusion });
      continue;
    }

    const metadata = resolveAgentCapabilityMetadata(capability);
    const runtimeDecision = evaluateRequiredRuntimes(
      metadata.requiredRuntime.map((runtimeId) => runtimeById.get(runtimeId) || {
        runtimeId,
        state: 'unavailable' as const,
        ready: false,
        health: 'unknown' as const,
        message: 'No runtime availability snapshot was provided.',
      }),
    );
    const score = scoreCapability(capability, metadata, query, discoveryQuery, relevantStep, routingHints);
    const reasons = inclusionReasons(capability, metadata, query, score);
    if (requiredCapabilityIdSet.has(capability.id)) {
      reasons.push('runtime-required-by-goal-contract');
    }
    const warnings = runtimeDecision.warnings;
    const card: AgentCapabilityCard = {
      id: capability.id,
      moduleId: capability.moduleId,
      title: capability.title,
      description: capability.description || '',
      risk: capability.risk,
      ...(capability.inputSchema ? { inputSchema: capability.inputSchema } : {}),
      ...(capability.outputSchema ? { outputSchema: capability.outputSchema } : {}),
      metadata,
      score,
      reasons,
      warnings,
    };
    eligible.push({ capability, card });
  }

  eligible.sort((left, right) => right.card.score - left.card.score || left.capability.id.localeCompare(right.capability.id));
  const selected = selectCapabilityWindow(eligible, minimum, maximum, requiredCapabilityIds);
  const selectedIds = new Set(selected.map((entry) => entry.capability.id));
  for (const entry of eligible) {
    if (!selectedIds.has(entry.capability.id)) {
      excluded.push({ capabilityId: entry.capability.id, reason: 'ranked-below-bounded-candidate-window' });
    }
  }

  const policy: AgentCapabilityResolverDiagnostics['policy'] = {};
  if (input.permissionProfile?.sandboxMode) policy.sandboxMode = input.permissionProfile.sandboxMode;
  if (input.permissionProfile?.approvalPolicy) policy.approvalPolicy = input.permissionProfile.approvalPolicy;
  if (input.permissionProfile?.autonomyMode) policy.autonomyMode = input.permissionProfile.autonomyMode;
  return {
    groups: buildCapabilityGroups(eligible.map((entry) => entry.capability)),
    cards: selected.map((entry) => entry.card),
    capabilities: selected.map((entry) => ({ ...entry.capability })),
    diagnostics: {
      requestedRange: { minimum, maximum },
      considered: input.capabilities.length,
      included: selected.map((entry) => ({
        capabilityId: entry.capability.id,
        score: entry.card.score,
        reasons: entry.card.reasons,
        warnings: entry.card.warnings,
      })),
      excluded,
      policy,
    },
  };
}

function selectCapabilityWindow(
  eligible: Array<{ capability: MonarchCapability; card: AgentCapabilityCard }>,
  minimum: number,
  maximum: number,
  requiredCapabilityIds: readonly string[],
): Array<{ capability: MonarchCapability; card: AgentCapabilityCard }> {
  if (eligible.length <= maximum) return eligible;

  const positiveCount = eligible.filter((entry) => entry.card.score > 0).length;
  const globallyRankedCount = Math.min(
    maximum,
    Math.max(minimum, Math.min(positiveCount, Math.max(minimum, Math.floor(maximum / 2)))),
  );
  const selectedIds = new Set<string>();
  const selected: Array<{ capability: MonarchCapability; card: AgentCapabilityCard }> = [];
  const append = (entry: { capability: MonarchCapability; card: AgentCapabilityCard }) => {
    if (selected.length >= maximum || selectedIds.has(entry.capability.id)) return;
    selectedIds.add(entry.capability.id);
    selected.push(entry);
  };

  // A typed goal contract may require a terminal worker even when lexical
  // relevance is weak (for example, a greeting has no token overlap with
  // models.agent.respond). Pin only capabilities that already passed every
  // source, runtime, Safe and cancellation exclusion. This is relevance, not
  // execution authority; Kernel still owns preflight and dispatch.
  for (const capabilityId of requiredCapabilityIds) {
    const entry = eligible.find((candidate) => candidate.capability.id === capabilityId);
    if (entry) append(entry);
  }

  // Keep the strongest cross-module matches first.
  for (const entry of eligible.slice(0, globallyRankedCount)) append(entry);

  // Evidence synthesis is the terminal schema for local-state requests. Keep
  // it beside a workspace-heavy tool cohort when it positively matched; other
  // providers still enter through normal ranking or explicit discovery.
  const groundedSynthesis = eligible.find((entry) => entry.capability.id === 'models.agent.synthesize');
  if (groundedSynthesis && groundedSynthesis.card.score > 0) append(groundedSynthesis);

  // Then keep a stable operational cohort from the leading module. This is
  // what prevents a file task from seeing only "read" while losing the write,
  // move, verify, or recovery primitives needed by later plan steps.
  const leadingModuleId = eligible[0]?.capability.moduleId;
  if (leadingModuleId) {
    for (const entry of eligible) {
      if (entry.capability.moduleId === leadingModuleId) append(entry);
    }
  }

  // Fill any remaining capacity by global relevance. Permission posture never
  // removes tools here; exact allow/confirm/deny is decided at Kernel dispatch.
  for (const entry of eligible) append(entry);
  return selected.sort((left, right) => (
    right.card.score - left.card.score || left.capability.id.localeCompare(right.capability.id)
  ));
}

function exclusionReason(
  capability: MonarchCapability,
  input: AgentCapabilityResolverInput,
  runtimeById: ReadonlyMap<string, AgentRuntimeAvailabilitySnapshot>,
): string | null {
  if (capability.moduleId === 'safe') return 'safe-agent-catalog-boundary';
  if (/^coder\.projects\./u.test(capability.id)) return 'coder-project-selection-is-owned-by-local-surface';
  if (capability.moduleId === 'security' && (
    capability.risk !== 'none' && capability.risk !== 'read'
    || /\.(?:set|stop|block|cancel|approve|resolve|dismiss|write)$/u.test(capability.id)
  )) return 'security-runtime-controls-are-not-agent-tools';
  if (capability.id === 'assistant.reply') return 'assistant-is-not-an-agent-tool';
  if (RUNTIME_OWNED_MODEL_CAPABILITIES.has(capability.id)) {
    return 'model-routing-is-owned-by-runtime';
  }
  if (/^oscar\.(?:chat|voice)\./u.test(capability.id)) {
    return 'nested-oscar-surface-is-not-an-agent-tool';
  }
  if (capability.id === 'custom-tools.auto-create') return 'automatic-create-and-execute-chain-forbidden';
  if (capability.id === 'device.desktop.actions') return 'composite-duplicates-atomic-device-capabilities';
  const moduleState = input.moduleStates?.[capability.moduleId];
  if (moduleState && moduleState !== 'active' && moduleState !== 'degraded') return `module-${moduleState}`;

  const metadata = resolveAgentCapabilityMetadata(capability);
  if (!supportsBoundedAgentExecution(metadata)) return 'effectful-capability-cancellation-unsupported';
  if (!metadata.supportedSources.includes(input.source)) return `source-${input.source}-unsupported`;
  for (const credential of metadata.requiredCredentials) {
    if (!input.availableCredentialRefs?.has(credential)) return `credential-reference-unavailable:${credential}`;
  }
  if (metadata.requiredRuntime.length > 0) {
    const snapshots = metadata.requiredRuntime.map((runtimeId) => runtimeById.get(runtimeId) || {
      runtimeId,
      state: 'unavailable' as const,
      ready: false,
      health: 'unknown' as const,
    });
    const runtimeDecision = evaluateRequiredRuntimes(snapshots);
    if (!runtimeDecision.usable) {
      const detail = runtimeDecision.decisions.find((entry) => !entry.usable)?.reason
        || runtimeDecision.unavailableRuntimeIds.join(',');
      return `runtime-unavailable:${detail}`;
    }
  }
  return null;
}

function scoreCapability(
  capability: MonarchCapability,
  metadata: MonarchResolvedAgentCapabilityMetadata,
  query: ReadonlySet<string>,
  discoveryQuery: ReadonlySet<string>,
  currentStep: string,
  routingHints: AgentRoutingHints,
): number {
  const weighted: Array<[string, number]> = [
    [capability.id, 8],
    [capability.moduleId, 4],
    [capability.title, 5],
    [capability.description || '', 3],
    [(capability.routing?.aliases || []).join(' '), 6],
    [(capability.routing?.keywords || []).join(' '), 5],
    [(capability.routing?.examples || []).join(' '), 3],
    [metadata.tags.join(' '), 5],
    [metadata.effects.map((effect) => `${effect.kind} ${effect.description}`).join(' '), 2],
  ];
  let score = 0;
  for (const [text, weight] of weighted) {
    const tokens = tokenize(text);
    for (const token of query) {
      if (tokens.has(token)) {
        score += weight;
      } else if (
        weight >= 3
        && Array.from(tokens).some((candidate) => isSingleEditToken(token, candidate))
      ) {
        score += weight;
      }
    }
  }
  if (discoveryQuery.size > 0) {
    const discoveryIdentity = tokenize([
      capability.id,
      capability.moduleId,
      capability.title,
      capability.description || '',
      ...(capability.routing?.aliases || []),
      ...(capability.routing?.keywords || []),
      ...(capability.routing?.examples || []),
      ...metadata.tags,
    ].join(' '));
    for (const token of discoveryQuery) {
      if (discoveryIdentity.has(token)) score += 12;
      else if (Array.from(discoveryIdentity).some((candidate) => isSingleEditToken(token, candidate))) score += 8;
    }
  }
  const stepTokens = tokenize(currentStep);
  const idTokens = tokenize(`${capability.id} ${capability.title}`);
  for (const token of stepTokens) if (idTokens.has(token)) score += 4;
  const tags = new Set(metadata.tags);
  if (
    routingHints.applicationLaunch
    && metadata.effectProfile.targetScope === 'application'
    && tags.has('application')
    && (tags.has('launch') || tags.has('open'))
  ) {
    score += 14;
  }
  if (routingHints.applicationLaunch && capability.moduleId === 'workspace') {
    score -= 10;
  }
  if (routingHints.browserTarget && tags.has('browser')) {
    score += 14;
  }
  if (routingHints.fileTarget && capability.moduleId === 'workspace') {
    score += 6;
  }
  if (
    routingHints.fileContentRead
    && capability.moduleId === 'workspace'
    && tags.has('file')
    && tags.has('read')
    && !tags.has('list')
  ) {
    // This is retrieval only: the LLM still receives the complete request and
    // independently chooses a typed capability. A concrete file target plus a
    // content-reading intent must outrank generic "status"/"inspect" tools.
    score += 36;
  }
  if (tags.has('batch')) {
    if (routingHints.batchFileRead) score += 24;
    else if (routingHints.fileContentRead) score -= 48;
  }
  if (
    routingHints.recoverableRemoval
    && capability.moduleId === 'workspace'
    && (tags.has('trash') || tags.has('recycle'))
  ) {
    score += 36;
  }
  if (
    routingHints.recoverableRemoval
    && metadata.effectProfile.reversibility === 'irreversible'
  ) {
    score -= 36;
  }
  if (
    routingHints.permanentRemoval
    && capability.moduleId === 'workspace'
    && metadata.effectProfile.reversibility === 'irreversible'
    && tags.has('delete')
  ) {
    score += 36;
  }
  if (capability.risk === 'read') score += 0.5;
  if (capability.id === 'models.agent.respond') score += 1;
  if (metadata.source === 'explicit') score += 0.25;
  return score;
}

function buildCapabilityGroups(capabilities: readonly MonarchCapability[]): AgentCapabilityGroup[] {
  const groups = new Map<string, MonarchCapability[]>();
  for (const capability of capabilities) {
    const current = groups.get(capability.moduleId) || [];
    current.push(capability);
    groups.set(capability.moduleId, current);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleId, entries]) => ({
      moduleId,
      count: entries.length,
      sampleCapabilityIds: entries
        .map((entry) => entry.id)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 4),
    }));
}

function inclusionReasons(
  capability: MonarchCapability,
  metadata: MonarchResolvedAgentCapabilityMetadata,
  query: ReadonlySet<string>,
  score: number,
): string[] {
  const reasons: string[] = [];
  const identityTokens = tokenize(`${capability.id} ${capability.title} ${capability.routing?.aliases?.join(' ') || ''}`);
  if (Array.from(query).some((term) => identityTokens.has(term))) reasons.push('goal-or-step-match');
  if (metadata.source === 'explicit') reasons.push('agent-metadata-available');
  if (capability.risk === 'read') reasons.push('read-only-inspection');
  if (score <= 0) reasons.push('bounded-window-backfill');
  return reasons.length > 0 ? reasons : ['deterministic-ranking'];
}

function tokenize(value: string): Set<string> {
  return new Set(
    value.toLocaleLowerCase('ru-RU')
      .split(/[^\p{L}\p{N}._-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function tokenizeRoutingQuery(value: string): Set<string> {
  return new Set(
    Array.from(tokenize(value)).filter((token) => !ROUTING_META_TOKENS.has(token)),
  );
}

function deriveRoutingHints(value: string): AgentRoutingHints {
  const normalized = value.toLocaleLowerCase('ru-RU');
  const routingTokens = tokenize(normalized);
  const browserTarget = /(?:https?:\/\/|www\.|\b(?:browser|website|webpage|url)\b|браузер|сайт|веб-?страниц)/iu.test(normalized);
  const fileTarget = !browserTarget && (
    /(?:^|[\s"'«(])(?:[a-z]:[\\/]|\\\\|\/[\w.-]+\/)/iu.test(normalized)
    || /(?:^|[\s"'«(])[\p{L}\p{N}_. -]+\.[a-z0-9]{1,12}(?:$|[\s"'»),.!?])/iu.test(normalized)
    || /\b(?:file|folder|directory|path|document|report|note|workspace)\b|файл|папк|директор|пут[ьи]|документ|отч[её]т|заметк|рабоч\w*\s+пространств/iu.test(normalized)
  );
  const launchVerb = /\b(?:open|launch|start|run)\b|открой|открыть|запусти|запустить|включи|включить/iu.test(normalized)
    || hasApproximateRoutingToken(routingTokens, ['open', 'launch', 'start', 'открой', 'запусти', 'включи']);
  const fileMutation = fileTarget && (
    /\b(?:move|rename|copy|write|append|create|replace|edit|delete|remove|trash)\b|перемести|переименуй|скопируй|запиши|добавь|создай|замени|измени|удали|убери|в\s+корзин/iu.test(normalized)
    || hasApproximateRoutingToken(routingTokens, [
      'move', 'rename', 'copy', 'write', 'append', 'create', 'replace', 'edit', 'delete', 'remove', 'trash',
      'перемести', 'переименуй', 'скопируй', 'запиши', 'добавь', 'создай', 'замени', 'измени', 'удали', 'убери',
    ])
  );
  const removalIntent = fileTarget && (
    /\b(?:delete|remove|trash)\b|удали|удалить|убери|убрать/iu.test(normalized)
    || hasApproximateRoutingToken(routingTokens, [
      'delete', 'remove', 'trash', 'удали', 'удалить', 'убери', 'убрать',
    ])
  );
  const permanentRemoval = removalIntent && (
    /\b(?:permanent|permanently|irreversible|irreversibly|forever)\b|безвозврат|навсегда|окончательно|минуя\s+корзин|не\s+в\s+корзин/iu.test(normalized)
    || hasApproximateRoutingToken(routingTokens, [
      'permanent', 'permanently', 'irreversible', 'irreversibly', 'forever', 'безвозвратно', 'навсегда', 'окончательно',
    ])
  );
  const recoverableRemoval = removalIntent && !permanentRemoval;
  const fileContentRead = fileTarget && !fileMutation && (
    /\b(?:read|inspect|summarize|parse)\b|прочитай|прочесть|прочитать|перескажи|разбери/iu.test(normalized)
    || hasApproximateRoutingToken(routingTokens, [
      'read', 'inspect', 'summarize', 'parse', 'прочитай', 'прочесть', 'прочитать', 'перескажи', 'разбери',
    ])
  );
  const batchFileRead = fileContentRead && (
    /\b(?:all|every|multiple|files|documents|folder|directory|desktop)\b|все\w*\s+(?:файл|документ)|файл[ыо][вм]?|документ[ыо][вм]?|папк|директор|рабоч\w*\s+стол/iu.test(normalized)
    || hasApproximateRoutingToken(routingTokens, [
      'all', 'every', 'multiple', 'files', 'documents', 'folder', 'directory', 'desktop',
      'все', 'файлы', 'документы', 'папка', 'директория',
    ])
  );
  return {
    applicationLaunch: launchVerb && !fileTarget && !browserTarget,
    browserTarget,
    fileTarget,
    fileContentRead,
    batchFileRead,
    recoverableRemoval,
    permanentRemoval,
  };
}

function hasApproximateRoutingToken(
  tokens: ReadonlySet<string>,
  expected: readonly string[],
): boolean {
  for (const candidate of expected) {
    if (tokens.has(candidate)) return true;
    for (const token of tokens) {
      if (isSingleEditToken(token, candidate)) return true;
    }
  }
  return false;
}

function isSingleEditToken(left: string, right: string): boolean {
  if (left.length < 5 || right.length < 5 || Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    let differences = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) differences += 1;
      if (differences > 1) return false;
    }
    return differences === 1;
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

function isGenericAgentPlanStep(value: string): boolean {
  return value.trim().toLowerCase() === 'choose the next evidence-producing action.';
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(Math.floor(value), maximum));
}
