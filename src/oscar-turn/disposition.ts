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
  const memoryCommand = parseExplicitMemoryCommand(text);
  if (memoryCommand && !memoryCommand.rest) {
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
  return parseExplicitMemoryCommand(value)?.memory ?? null;
}

export interface OscarExplicitMemoryCommand {
  /** What to remember, as the person said it. */
  memory: string;
  /** The rest of the message when it also asks something; '' for a pure command. */
  rest: string;
}

const REMEMBER = String.raw`(?:запомни(?!\p{L})(?:\s+(?:это|себе)(?!\p{L}))?|сохрани\s+(?:это\s+)?в\s+памят[ьи](?!\p{L})|remember(?!\p{L})(?:\s+(?:this|that)(?!\p{L}))?|save\s+(?:this\s+)?to\s+memory(?!\p{L}))`;
const LEADING_REMEMBER = new RegExp(String.raw`^(?:пожалуйста[,\s]+)?${REMEMBER}\s*[,;:\-—]?\s*(?<memory>[\s\S]+)$`, 'iu');
const EMBEDDED_REMEMBER = new RegExp(String.raw`(?<lead>[,;.!?]\s*|\s+)(?:и\s+|а\s+|and\s+)?(?:ещё\s+|также\s+|also\s+)?${REMEMBER}(?:\s*[,:\-—]\s*|\s+)(?<memory>[^.!?\n]{3,})`, 'iu');
const TRAILING_REMEMBER = new RegExp(String.raw`^(?<memory>[^\n]{3,}?)[\s,.!—\-]+(?:${REMEMBER})\s*[.!]*$`, 'iu');

/** «Запомни …» anywhere in a message: at the start, after a question
 * ("какая погода? и запомни, что я живу в Варне") or at the end
 * ("я живу в Варне, запомни"). The memory part is the clause the command
 * governs; a question elsewhere in the message is answered as usual. */
export function parseExplicitMemoryCommand(value: string): OscarExplicitMemoryCommand | null {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const finish = (memory: string, rest: string): OscarExplicitMemoryCommand | null => {
    const cleaned = memory.trim().replace(/^[,;:\-—\s]+|[,;:\-—\s]+$/gu, '');
    if (cleaned.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return null;
    if (/^(?:это|себе|this|that|it)$/iu.test(cleaned)) return null;
    return { memory: cleaned.slice(0, 4_000), rest: substantiveRest(rest) };
  };
  const leading = text.match(LEADING_REMEMBER);
  if (leading?.groups?.memory) {
    // "запомни, что я живу в Варне. Какая там погода?" — the sentences up to
    // the first question are the memory, the question is still a question.
    // A numbered list ("Запомни: 1. … 2. …") stays one record.
    const body = leading.groups.memory;
    const sentences = body.split(/(?<=[.!?])\s+(?=\S)/u);
    const question = sentences.findIndex((sentence, index) => index > 0 && /\?\s*$/u.test(sentence));
    return question > 0
      ? finish(sentences.slice(0, question).join(' ').replace(/[.!]+$/u, ''), sentences.slice(question).join(' '))
      : finish(body, '');
  }
  const trailing = text.match(TRAILING_REMEMBER);
  if (trailing?.groups?.memory) {
    const body = trailing.groups.memory;
    const lastSentence = body.split(/(?<=[.!?])\s+/u).pop() || body;
    return finish(lastSentence, body.slice(0, body.length - lastSentence.length));
  }
  const embedded = text.match(EMBEDDED_REMEMBER);
  if (embedded?.groups?.memory && embedded.index !== undefined) {
    const before = text.slice(0, embedded.index + (embedded.groups.lead || '').length);
    const after = text.slice(embedded.index + embedded[0].length);
    return finish(embedded.groups.memory, `${before} ${after}`);
  }
  return null;
}

function substantiveRest(value: string): string {
  const rest = value.replace(/\s+/g, ' ').trim()
    .replace(/^(?:и|а|and|also|ещё|пожалуйста|please|спасибо|thanks)[,\s]+/iu, '')
    .replace(/^[,;:\-—.!\s]+|[,;:\-—\s]+$/gu, '');
  return rest.replace(/[^\p{L}\p{N}]/gu, '').length >= 3 ? rest : '';
}

const FORGET = /^(?:пожалуйста[,\s]+)?(?:забудь|удали\s+из\s+памяти|сотри\s+из\s+памяти|forget)\s*[,:]?\s*(?:(?:то,?\s+)?что|про|о|об|about|that)?\s*(?<what>.+)$/iu;
const CONVERSATIONAL_FORGET = /^(?:предыдущ|последн|прошл\p{L}*\s+сообщ|(?:это|этот|эту|всё|все)(?!\p{L})|(?:что\s+)?я\s+(?:сказал|написал|спросил)|наш\p{L}*\s+(?:разговор|диалог)|(?:about\s+it|it|that\s+message|everything|what\s+i\s+(?:said|wrote))(?!\p{L}))/iu;

/** «Забудь, где я живу» / «удали из памяти про кота». Conversational uses
 * ("забудь предыдущее сообщение", "забудь всё") are not memory commands. */
export function parseForgetMemoryCommand(value: string): string | null {
  const text = String(value || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/u, '');
  const what = text.match(FORGET)?.groups?.what?.trim();
  if (!what || what.replace(/[^\p{L}\p{N}]/gu, '').length < 3 || CONVERSATIONAL_FORGET.test(what)) return null;
  return what.slice(0, 1_000);
}

/** «Что ты обо мне знаешь?» — answered from the records themselves. */
export function isMemoryOverviewRequest(value: string): boolean {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return /^(?:а\s+)?(?:скажи,?\s+)?что\s+ты\s+(?:уже\s+)?(?:(?:знаешь|помнишь|запомнил)\s+(?:обо\s+мне|про\s+меня)|(?:обо\s+мне|про\s+меня)\s+(?:знаешь|помнишь|запомнил))\s*[?.!]*$/iu.test(text)
    || /^(?:покажи|открой)\s+(?:мою\s+|свою\s+)?память\s*[?.!]*$/iu.test(text)
    || /^what\s+do\s+you\s+(?:know|remember)\s+about\s+me\s*[?.!]*$/iu.test(text);
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
