import { classifyOscarRequestDisposition, resolveOscarFunctionInvocation } from '../core';
import type { OscarTurnRequestSnapshot } from './types';
import { looksLikeImageGenerationRequest } from '../image-generation';
import { parseLeadingOscarSkillInvocation } from './skill-invocation';
import { isOscarCapabilitiesOrIdentityRequest, isOscarResponseOnlyRequest } from '../core/intent-classifier';

export type OscarServerDispositionLane = 'answer' | 'agent' | 'clarify' | 'memory' | 'reminder';

export interface OscarServerDisposition {
  lane: OscarServerDispositionLane;
  kind: string;
  confidence: number;
  reason: string;
  requiresExternalResearch?: boolean;
}

export interface OscarStructuredDispositionProvider {
  classify(input: { text: string; history?: OscarTurnRequestSnapshot['history']; requestedModel?: string | undefined; signal?: AbortSignal | undefined }): Promise<OscarServerDisposition>;
  /** Whether a good answer needs fresh public data. Asked only when the person
   * has switched Internet on; it grants nothing, it only avoids searching for
   * a greeting or a question the model can answer from what it knows. */
  needsWeb?(input: { text: string; history?: OscarTurnRequestSnapshot['history']; requestedModel?: string | undefined; signal?: AbortSignal | undefined }): Promise<boolean>;
}

/** A request that needs public sources and also asks for something to be
 * done with them: the host searches, the agent acts on the result. */
export function researchThenActDisposition(classified: Pick<OscarServerDisposition, 'confidence'>, requiresExternalResearch = false): OscarServerDisposition {
  return {
    lane: 'agent',
    kind: 'research_then_act',
    confidence: classified.confidence,
    reason: 'The request needs public sources and an action on them: Monarch searches, the agent acts through Kernel.',
    requiresExternalResearch,
  };
}

/** Needing sources does not answer whether an action is also asked for — a
 * missing file path used to be read as "no action at all", so "найди новости
 * и отправь их в Telegram" lost the sending. The model decides; only its clear
 * "agent" makes it a task, and its doubt or failure keeps the sourced answer. */
async function researchOrTask(
  text: string,
  provider: OscarStructuredDispositionProvider | undefined,
  options: { history?: OscarTurnRequestSnapshot['history']; requestedModel?: string | undefined; signal?: AbortSignal | undefined },
  research: OscarServerDisposition,
): Promise<OscarServerDisposition> {
  if (!provider) return research;
  try {
    const classified = await provider.classify({ text, history: options.history, requestedModel: options.requestedModel, signal: options.signal });
    return classified.lane === 'agent' ? researchThenActDisposition(classified, research.requiresExternalResearch === true) : research;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return research;
  }
}

export async function classifyOscarServerDisposition(
  textInput: string,
  provider?: OscarStructuredDispositionProvider,
  options: { externalResearch?: boolean; history?: OscarTurnRequestSnapshot['history']; requestedModel?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<OscarServerDisposition> {
  const originalText = String(textInput || '').replace(/\s+/g, ' ').trim();
  const skillInvocation = parseLeadingOscarSkillInvocation(originalText);
  const text = skillInvocation?.requestText || originalText;
  const functionInvocation = resolveOscarFunctionInvocation(text);
  if (functionInvocation?.id === 'computer-use') {
    return {
      lane: 'agent',
      kind: 'computer_use',
      confidence: 1,
      reason: 'A leading user-authored @Computer Use mention explicitly selects the visible screen-control runtime.',
      requiresExternalResearch: false,
    };
  }
  const deterministic = classifyOscarRequestDisposition(text);
  if (extractExplicitMemoryText(text)) {
    return {
      lane: 'memory',
      kind: 'memory_remember',
      confidence: 1,
      reason: 'An exact remember command is a typed local data write, not an Agent action.',
      requiresExternalResearch: false,
    };
  }
  if (looksLikeRequestedMaterialHandoff(textInput, options.history)) {
    return {
      lane: 'answer',
      kind: 'material_review',
      confidence: 0.99,
      reason: 'The current message supplies material that Oscar explicitly requested for review; its contents carry no execution authority.',
      requiresExternalResearch: false,
    };
  }
  if (looksLikeImageGenerationRequest(text)) {
    return {
      lane: 'answer',
      kind: 'image_generation',
      confidence: 0.99,
      reason: 'Image generation is handled by the typed Monarch Images provider flow, while Oscar remains answer-only.',
      requiresExternalResearch: false,
    };
  }
  const localTarget = deterministic.hasLocalEffectTarget;
  if (deterministic.requiresExternalResearch) {
    return researchOrTask(originalText, provider, options, {
      lane: 'answer',
      kind: 'external_research',
      confidence: Math.max(deterministic.confidence, 0.9),
      reason: 'The request requires a current external-source answer and no local system effect.',
      requiresExternalResearch: true,
    });
  }
  if (isOscarResponseOnlyRequest(text) || isOscarCapabilitiesOrIdentityRequest(text)) {
    return { lane: 'answer', kind: deterministic.kind, confidence: deterministic.confidence,
      reason: 'Host-owned discussion, prohibition or supplied-material boundary excludes execution.',
      requiresExternalResearch: false };
  }
  if (options.externalResearch === true && !localTarget) {
    return researchOrTask(originalText, provider, options, {
      lane: 'answer',
      kind: 'external_research',
      confidence: 0.9,
      reason: 'An explicitly consented external research request has no local operational target.',
      requiresExternalResearch: false,
    });
  }
  // For ordinary language the selected model owns only the answer/agent surface
  // decision. Host regexes may enforce typed safety exclusions above, but they
  // must not act as activation phrases for execution.
  if (provider) {
    try {
      const classified = await provider.classify({
        text: originalText,
        history: options.history,
        requestedModel: options.requestedModel,
        signal: options.signal,
      });
      // Clarification parks the Turn in waiting-for-user and replaces the reply
      // with a policy question, so it needs the same host corroboration the
      // provider-failure branch below already requires: some operational signal
      // in the request itself, or in the operational thread it continues — a
      // bare "делай" clarifies the search proposed one message earlier.
      // Ordinary conversation with no such signal anywhere is answered instead
      // of stalled. Narrowing clarify to answer never opens execution authority.
      if (classified.lane === 'clarify' && !hasOperationalSignal(deterministic, localTarget, options.history)) {
        return {
          lane: 'answer',
          kind: deterministic.kind,
          confidence: deterministic.confidence,
          reason: 'The model asked to clarify an operation the request never names; without a host-visible local effect target the Turn stays answer-only.',
          requiresExternalResearch: false,
        };
      }
      if (['answer', 'agent', 'clarify'].includes(classified.lane)) {
        return { ...classified, requiresExternalResearch: classified.requiresExternalResearch ?? false };
      }
    } catch (error) {
      if (options.signal?.aborted || /^astra-max-native:[a-z0-9-]{1,80}$/u.test(String((error as Error)?.message))) throw error;
      if (deterministic.mode === 'agent' || localTarget) {
        return {
          lane: 'clarify',
          kind: localTarget ? 'file_operation' : 'tool_use',
          confidence: 0.55,
          reason: 'Structured disposition runtime failed; unresolved intent requires clarification before execution.',
          requiresExternalResearch: false,
        };
      }
      return {
        lane: 'answer',
        kind: deterministic.kind,
        confidence: deterministic.confidence,
        reason: 'Semantic disposition is unavailable; host fallback remains answer-only without opening execution.',
        requiresExternalResearch: false,
      };
    }
  }
  // A missing semantic provider can never turn words into execution authority.
  // Deterministic parsing remains useful only to explain why clarification is
  // needed; explicit typed endpoints and visible tool mentions are handled above.
  if (deterministic.mode === 'agent' || localTarget) {
    return {
      lane: 'clarify',
      kind: deterministic.kind,
      confidence: 0.5,
      reason: 'Semantic disposition is unavailable; no executor was selected from request wording.',
      requiresExternalResearch: false,
    };
  }
  return {
    lane: 'answer',
    kind: deterministic.kind,
    confidence: deterministic.confidence,
    reason: 'No semantic disposition provider is available; model-free fallback stays answer-only.',
    requiresExternalResearch: false,
  };
}

export function looksLikeRequestedMaterialHandoff(
  textInput: string,
  history: OscarTurnRequestSnapshot['history'],
): boolean {
  const text = String(textInput || '').trim();
  if (!text || !Array.isArray(history) || history.length === 0) return false;
  const lastAssistant = history.at(-1);
  if (lastAssistant?.role !== 'assistant') return false;
  const invitation = String(lastAssistant?.content || '').replace(/\s+/g, ' ').trim();
  if (!assistantRequestedMaterial(invitation)) return false;
  const deterministic = classifyOscarRequestDisposition(text);
  const numberedItems = [...text.matchAll(/(?:^|\s)\d{1,3}[.)]\s+([\s\S]*?)(?=(?:\s+\d{1,3}[.)]\s+)|$)/gu)]
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
  const numberedMaterial = numberedItems.length >= 2
    && numberedItems.every((item) => classifyOscarRequestDisposition(item).mode !== 'agent');
  const explicitMaterialEnvelope = /^(?:```|~~~|\{|\[)/u.test(text)
    || /^(?:вот|держи|скидываю|присылаю|отправляю|показываю|here(?:'s|\s+is)|sharing|sending)\s+(?:лог|вывод|трассировк\p{L}*|код|json|текст|цитат\p{L}*|список\s+обновлен\p{L}*|changelog|release\s+notes?)(?:\s|:|$)/iu.test(text)
    || /^(?:ч[её]тк\p{L}*\s+)?(?:список\s+обновлен\p{L}*|changelog|release\s+notes?)(?:\s|:|$)/iu.test(text);
  const strongEnvelope = explicitMaterialEnvelope || numberedMaterial;
  const explicitIntentShift = /^(?:(?:а\s+вместо\s+этого|а|но|вместо\s+этого|instead)\s+)?(?:запомни|сохрани\s+в\s+память|remember|save\s+to\s+memory|кто|что|где|когда|почему|как|сколько|какой|какая|какие|расскажи|объясни|поясни|найди|поищи|who|what|where|when|why|how|tell|explain|find|search)(?:\s|[,.:;!?]|$)/iu.test(text);
  if (!explicitMaterialEnvelope && (
    deterministic.mode === 'agent'
    || deterministic.requiresExternalResearch
    || explicitIntentShift
    || /\?$/.test(text)
  )) return false;
  return strongEnvelope || text.length >= 12;
}

function assistantRequestedMaterial(text: string): boolean {
  if (!text) return false;
  if (/(?:^|\s)(?:не\s+(?:скидывай|присылай|отправляй|вставляй|показывай)|не\s+готов\p{L}*\s+(?:посмотреть|изучить|проверить|прочитать)|do\s+not\s+(?:send|paste|share)|don't\s+(?:send|paste|share)|not\s+ready\s+to\s+(?:review|look|inspect|read))(?:\s|[,.!?]|$)/iu.test(text)) {
    return false;
  }
  return /(?:^|\s)(?:скидывай|скинь|присылай|пришли|можешь\s+прислать|отправь|отправляй|вставь|вставляй|покажи|давай(?:\s+(?:сюда|список|его|материал\p{L}*))?|send(?:\s+it(?:\s+over)?)?|paste|share|show\s+me|drop\s+it|go\s+ahead)(?:\s|[,.!?]|$)/iu.test(text)
    || /(?:готов\p{L}*\s+(?:посмотреть|изучить|проверить|прочитать)|ready\s+to\s+(?:review|look|inspect|read))/iu.test(text);
}
export function extractExplicitMemoryText(value: string): string | null {
  const text = String(value || '').trim();
  const match = text.match(
    /^(?:запомни|сохрани\s+в\s+память|remember|save\s+to\s+memory)\s*[,;:\-—]?\s*(?<memory>[\s\S]+)$/iu,
  );
  const memory = String(match?.groups?.memory || '').trim();
  return memory ? memory.slice(0, 4_000) : null;
}

export function isNonAuthoritativeConfirmationText(value: string): boolean {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return /^(?:я\s+)?подтверждаю(?:\s+(?:действие|операцию|удаление))?[.!]?$/iu.test(text)
    || /^(?:confirm|confirmed|i\s+confirm)[.!]?$/iu.test(text);
}

/** Host-visible evidence that this request, or the operational thread it
 * continues, is about work on the machine. Only a bounded recent window counts:
 * clarification is a follow-up to a live operational exchange, not a property a
 * conversation keeps forever after one file question. */
function hasOperationalSignal(
  deterministic: ReturnType<typeof classifyOscarRequestDisposition>,
  localTarget: boolean,
  history: OscarTurnRequestSnapshot['history'],
): boolean {
  if (deterministic.mode === 'agent' || localTarget) return true;
  return (Array.isArray(history) ? history.slice(-4) : []).some((message) => {
    const content = String(message?.content || '').replace(/\s+/g, ' ').trim();
    if (!content) return false;
    const entry = classifyOscarRequestDisposition(content);
    return entry.mode === 'agent' || entry.hasLocalEffectTarget;
  });
}
