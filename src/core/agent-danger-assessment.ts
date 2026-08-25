import type {
  AgentDangerAssessmentV1,
  MonarchAgentCapabilitySource,
  MonarchAgentDangerBand,
  MonarchAgentDangerFactorV1,
  MonarchAgentDangerResponse,
  MonarchAgentSecurityMode,
  MonarchExecutionRequest,
  MonarchRisk,
  MonarchRiskVector,
} from './contracts';

export interface AssessAgentDangerInput {
  request: Pick<MonarchExecutionRequest, 'capabilityId' | 'input' | 'originatingUserText' | 'proposalSource'>;
  risk: MonarchRisk;
  riskVector: MonarchRiskVector;
  source?: MonarchAgentCapabilitySource;
}

const WEIGHTS = {
  effect: 0.19,
  scope: 0.10,
  reversibility: 0.12,
  privilege: 0.12,
  dataSensitivity: 0.09,
  externality: 0.10,
  novelty: 0.08,
  ambiguity: 0.06,
  blastRadius: 0.06,
  targetFreshness: 0.04,
  requestAlignment: 0.04,
} as const;

export function assessAgentDanger(input: AssessAgentDangerInput): AgentDangerAssessmentV1 {
  const vector = input.riskVector;
  const serializedInput = stableText(input.request.input);
  const requestText = (input.request.originatingUserText || '').trim();
  const capabilityId = input.request.capabilityId;
  const exactComputerBinding = /"windowRef"\s*:\s*"hwnd:[0-9a-f]{8,16}"/iu.test(serializedInput)
    && /"observationId"\s*:\s*"computer-observation-[0-9a-z-]{8,160}"/iu.test(serializedInput);
  const shell = capabilityId === 'system.shell.run';
  const bulk = vector.scope === 'bounded-set' || vector.scope === 'workspace' || vector.scope === 'system' || vector.scope === 'external';
  const aligned = requestText ? requestLooksAligned(requestText, capabilityId, vector.effect) : false;

  const factors: AgentDangerAssessmentV1['factors'] = {
    effect: factor(effectScore(vector.effect), `Effect is ${vector.effect}.`),
    scope: factor(scoreOf(vector.scope, {
      'single-object': 5, 'bounded-set': 35, workspace: 50, system: 60, external: 75,
    }), `Scope is ${vector.scope}.`),
    reversibility: factor(scoreOf(vector.reversibility, {
      'read-only': 0, reversible: 15, compensatable: 40, irreversible: 100,
    }), `Reversibility is ${vector.reversibility}.`),
    privilege: factor(scoreOf(vector.privilege, { user: 0, elevated: 65, 'security-control': 100 }), `Privilege is ${vector.privilege}.`),
    dataSensitivity: factor(scoreOf(vector.data, { public: 0, workspace: 20, personal: 45, secret: 100 }), `Data sensitivity is ${vector.data}.`),
    externality: factor(scoreOf(vector.externality, { local: 0, localhost: 10, 'trusted-origin': 35, 'new-origin': 75, public: 100 }), `Externality is ${vector.externality}.`),
    novelty: factor(scoreOf(vector.novelty, { 'known-capability': 0, 'new-args': 30, 'arbitrary-code': 100 }), `Novelty is ${vector.novelty}.`),
    ambiguity: factor(requestText ? (aligned ? 5 : 60) : 75, requestText
      ? aligned ? 'The requested operation is explicit.' : 'The exact requested operation is ambiguous.'
      : 'No originating user text is bound to the action.'),
    blastRadius: factor(vector.effect === 'none' || vector.effect === 'read' ? 0 : bulk ? 70 : 20, bulk
      ? 'The action can affect a broad target set.' : 'The action is bounded to a narrow target.'),
    targetFreshness: factor(exactComputerBinding ? 0 : requiresFreshTarget(capabilityId) ? 65 : shell ? 45 : 10, exactComputerBinding
      ? 'A fresh exact-window observation binds the target.'
      : requiresFreshTarget(capabilityId) ? 'No fresh exact-window binding is present.' : 'The target is resolved at dispatch or does not require an observation lease.'),
    requestAlignment: factor(aligned ? 0 : requestText ? 55 : 80, aligned
      ? 'Capability semantics match the originating request.' : 'Capability alignment cannot be proved from the originating request.'),
  };

  let probability = Object.entries(WEIGHTS).reduce((total, [name, weight]) => (
    total + factors[name as keyof typeof factors].score * weight
  ), 0);
  if (vector.effect === 'delete' && vector.reversibility === 'irreversible') probability += 18;
  if (vector.data === 'secret' && vector.externality !== 'local') probability += 28;
  if (vector.privilege === 'security-control') probability += 16;
  if (input.risk === 'money' || input.risk === 'identity') probability += 24;
  if (input.risk === 'security-sensitive') probability += 18;
  if (shell) probability += 10;
  if (input.source === 'telegram') probability += 8;
  probability = clampScore(probability);

  const knownFields = requestText ? 11 : 9;
  const confidence = clampScore(58
    + knownFields * 3
    + (input.request.proposalSource ? 5 : 0)
    - (vector.novelty === 'arbitrary-code' ? 5 : 0));
  return {
    schemaVersion: 'monarch.agent-danger-assessment.v1',
    dangerProbability: probability,
    assessmentConfidence: confidence,
    band: dangerBand(probability),
    factors,
  };
}

export function dangerResponseForMode(
  mode: MonarchAgentSecurityMode,
  dangerProbability: number,
): MonarchAgentDangerResponse {
  const score = clampScore(dangerProbability);
  if (mode === 'off') return 'allow';
  if (mode === 'observe') return 'observe';
  if (mode === 'guard') {
    if (score <= 39) return 'allow';
    if (score <= 69) return 'enhanced-readback';
    if (score <= 89) return 'confirm';
    return 'block';
  }
  if (score <= 19) return 'allow';
  if (score <= 49) return 'enhanced-readback';
  if (score <= 79) return 'confirm';
  return 'block';
}

export function dangerBand(scoreInput: number): MonarchAgentDangerBand {
  const score = clampScore(scoreInput);
  if (score <= 19) return 'minimal';
  if (score <= 39) return 'low';
  if (score <= 69) return 'elevated';
  if (score <= 89) return 'high';
  return 'critical';
}

function effectScore(effect: MonarchRiskVector['effect']): number {
  return scoreOf(effect, { none: 0, read: 5, write: 40, device: 30, network: 65, execute: 78, delete: 85 });
}

function requiresFreshTarget(capabilityId: string): boolean {
  return /^computer\.window\.(?:click|close|type|key|scroll)$/u.test(capabilityId);
}

function requestLooksAligned(text: string, capabilityId: string, effect: MonarchRiskVector['effect']): boolean {
  const normalized = text.toLocaleLowerCase('ru-RU');
  if (effect === 'none' || effect === 'read') return true;
  if (capabilityId === 'device.app.open') return /\b(?:open|launch|start)\b|открой|открыть|запуст/iu.test(normalized);
  if (capabilityId === 'system.shell.run') return /\b(?:shell|terminal|command|run|execute)\b|терминал|команд|выполн|запуст/iu.test(normalized);
  if (effect === 'delete') return /\b(?:delete|remove|trash)\b|удал|сотр|корзин/iu.test(normalized);
  if (effect === 'write') return /\b(?:write|create|edit|change|move|copy|rename|save|update|fix|implement)\b|запиш|созд|измен|перемест|скопир|переимен|сохран|исправ|реализ/iu.test(normalized);
  if (effect === 'device') return /\b(?:open|close|click|press|type|scroll|set|control)\b|открой|закрой|нажм|введ|прокрут|установ|включ|выключ/iu.test(normalized);
  if (effect === 'network') return /\b(?:send|upload|download|publish|request|fetch|open)\b|отправ|загруз|скача|опубли|запрос|открой/iu.test(normalized);
  return /\b(?:run|execute|install|start)\b|выполн|запуст|установ/iu.test(normalized);
}

function factor(score: number, reason: string): MonarchAgentDangerFactorV1 {
  return { score: clampScore(score), reason };
}

function scoreOf<T extends string>(value: T, scores: Record<T, number>): number {
  return scores[value];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 100)));
}

function stableText(value: unknown): string {
  try {
    return JSON.stringify(value) || '';
  } catch {
    return '';
  }
}
