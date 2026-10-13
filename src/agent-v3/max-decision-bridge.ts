import { astraJournalJson, type AstraJson } from './journal';
import type { AstraContextPlan } from './context-engine';
import { AstraReadDecisionGateway, astraReadDecisionSchema, type AstraReadCandidate,
  type AstraReadProposal } from './read-decision-gateway';
import { AstraMaxProviderError } from './groq-max-provider';
import {
  ASTRA_MAX_PROVIDER_ID,
  ASTRA_MAX_SAFETY_MODEL,
  astraMaxInputDigest,
  astraMaxOutputDigest,
  type AstraMaxDeployment,
  type AstraMaxPrimaryModel,
  type AstraMaxProposalRequestV1,
  type AstraMaxProposalV1,
  type AstraMaxProviderConsentV1,
  type AstraMaxReasoningEffort,
} from './max-provider-contract';

export interface AstraMaxProposalPort {
  propose(input: AstraMaxProposalRequestV1, signal?: AbortSignal): Promise<AstraMaxProposalV1>;
}

export type AstraMaxReadDecision = {
  status: 'accepted';
  authority: 'none';
  proposal: AstraReadProposal;
  normalized: string[];
  context: { surfaceDigest: string; sourceRevision: number; tokenCount: number; omittedRefs: string[] };
  max: { requestId: string; providerId: typeof ASTRA_MAX_PROVIDER_ID; modelId: AstraMaxPrimaryModel;
    safetyModelId: typeof ASTRA_MAX_SAFETY_MODEL; inputDigest: string; outputDigest: string };
} | {
  status: 'blocked';
  code: string;
  max: { requestId: string; providerId: typeof ASTRA_MAX_PROVIDER_ID; modelId: AstraMaxPrimaryModel };
};

/**
 * Isolated composition boundary: a cloud model receives one already prepared
 * Astra Context surface and returns only a proposal. The existing closed
 * decision profile rebinds opaque handles to host-owned arguments. No Kernel,
 * tool catalog executor or effect port is accepted by this function.
 */
export async function decideAstraReadWithMax(options: {
  deployment: AstraMaxDeployment;
  provider: AstraMaxProposalPort;
  context: AstraContextPlan;
  candidates: AstraReadCandidate[];
  requestId: string;
  modelId: AstraMaxPrimaryModel;
  reasoningEffort: AstraMaxReasoningEffort;
  maxCompletionTokens: number;
  consent: AstraMaxProviderConsentV1;
  controlEpoch: number;
  catalogRevision: number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<AstraMaxReadDecision> {
  const trace = { requestId: options.requestId, providerId: ASTRA_MAX_PROVIDER_ID, modelId: options.modelId } as const;
  const blocked = (code: string): AstraMaxReadDecision => ({ status: 'blocked', code, max: trace });
  if (options.deployment !== 'isolated-validation' && options.deployment !== 'source-preview') return blocked('deployment');
  const current = (): boolean => !options.signal?.aborted && options.isCurrent() === true;
  if (!current()) return blocked('stale-context');

  try {
    const candidates = structuredClone(options.candidates);
    const schema = astraReadDecisionSchema(candidates);
    const gateway = new AstraReadDecisionGateway({ isCurrent: () => current() });
    const offer = gateway.offer({ executionId: options.context.executionId, controlEpoch: options.controlEpoch,
      catalogRevision: options.catalogRevision, context: options.context, candidates });
    const responseSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { proposal: schema },
      required: ['proposal'],
    } as AstraJson;
    const request: AstraMaxProposalRequestV1 = {
      requestId: options.requestId,
      executionId: options.context.executionId,
      modelId: options.modelId,
      reasoningEffort: options.reasoningEffort,
      maxCompletionTokens: options.maxCompletionTokens,
      messages: [{ role: 'user', content: options.context.surface }],
      responseSchema,
      consent: structuredClone(options.consent),
    };
    const generated = await options.provider.propose(request, options.signal);
    if (!current()) return blocked('stale-context');
    if (!validProviderBinding(generated, request)) return blocked('provider-binding');
    const wrapper = generated.value as Record<string, unknown>;
    if (Object.keys(wrapper).length !== 1 || !Object.hasOwn(wrapper, 'proposal')) return blocked('provider-envelope');
    const decision = gateway.accept(offer.offerId, astraJournalJson(wrapper.proposal as AstraJson));
    if (decision.status !== 'accepted') return blocked('decision-' + decision.code);
    return {
      ...decision,
      context: {
        surfaceDigest: options.context.surfaceDigest,
        sourceRevision: options.context.sourceRevision,
        tokenCount: options.context.tokenCount,
        omittedRefs: [...options.context.omittedRefs],
      },
      max: {
        ...trace,
        safetyModelId: ASTRA_MAX_SAFETY_MODEL,
        inputDigest: generated.inputDigest,
        outputDigest: generated.outputDigest,
      },
    };
  } catch (error) {
    if (error instanceof AstraMaxProviderError && /^[a-z0-9-]{1,96}$/u.test(error.code)) {
      return blocked('provider-' + error.code);
    }
    if (error instanceof Error && error.message.startsWith('astra-decision:')) {
      const code = error.message.slice('astra-decision:'.length);
      if (/^[a-z0-9-]{1,96}$/u.test(code)) return blocked('decision-' + code);
    }
    return blocked('composition-failed');
  }
}

function validProviderBinding(value: unknown, request: AstraMaxProposalRequestV1): value is AstraMaxProposalV1 {
  if (!record(value)) return false;
  return value.authority === 'none'
    && value.providerId === ASTRA_MAX_PROVIDER_ID
    && value.modelId === request.modelId
    && value.safetyModelId === ASTRA_MAX_SAFETY_MODEL
    && value.requestId === request.requestId
    && value.executionId === request.executionId
    && value.finishReason === 'stop'
    && value.inputDigest === astraMaxInputDigest(request)
    && record(value.value)
    && value.outputDigest === astraMaxOutputDigest(value.value as AstraJson);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
