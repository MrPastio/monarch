import { classifyOscarRequestDisposition, resolveOscarFunctionInvocation } from '../core';
import type { OscarTurnRequestSnapshot } from './types';
import { looksLikeImageGenerationRequest } from '../image-generation';
import { parseLeadingOscarSkillInvocation } from './skill-invocation';

export type OscarServerDispositionLane = 'answer' | 'agent' | 'clarify' | 'memory';

export interface OscarServerDisposition {
  lane: OscarServerDispositionLane;
  kind: string;
  confidence: number;
  reason: string;
  requiresExternalResearch?: boolean;
}

export interface OscarStructuredDispositionProvider {
  classify(input: { text: string; history?: OscarTurnRequestSnapshot['history'] }): Promise<OscarServerDisposition>;
}

export async function classifyOscarServerDisposition(
  textInput: string,
  provider?: OscarStructuredDispositionProvider,
  options: { externalResearch?: boolean; history?: OscarTurnRequestSnapshot['history'] } = {},
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
    return {
      lane: 'answer',
      kind: 'external_research',
      confidence: Math.max(deterministic.confidence, 0.9),
      reason: 'The request requires a current external-source answer and no local system effect.',
      requiresExternalResearch: true,
    };
  }
  if (deterministic.mode === 'agent') {
    return {
      lane: 'agent',
      kind: deterministic.kind,
      confidence: deterministic.confidence,
      reason: deterministic.reason,
      requiresExternalResearch: false,
    };
  }
  if (options.externalResearch === true && !localTarget) {
    return {
      lane: 'answer',
      kind: 'external_research',
      confidence: 0.9,
      reason: 'An explicitly consented external research request has no local operational target.',
      requiresExternalResearch: false,
    };
  }
  if (['code', 'text_generation', 'file_generation'].includes(deterministic.kind)) {
    return {
      lane: 'answer',
      kind: deterministic.kind,
      confidence: Math.max(deterministic.confidence, 0.86),
      reason: 'The request asks for response content and has no canonical local-effect target.',
      requiresExternalResearch: false,
    };
  }
  if (isObviousInformationalRequest(text)) {
    return {
      lane: 'answer',
      kind: deterministic.kind,
      confidence: Math.max(deterministic.confidence, 0.8),
      reason: 'The request is explicitly informational and requires no local effect.',
      requiresExternalResearch: false,
    };
  }
  const imperative = hasImperativeShape(text);
  if (localTarget && imperative) {
    return {
      lane: 'agent',
      kind: /(?:файл|папк|каталог|директор|диск|drive|file|folder|directory|path)/iu.test(text)
        ? 'file_operation'
        : 'tool_use',
      confidence: 0.78,
      reason: 'A local target plus imperative shape fails closed to Agent Runtime.',
      requiresExternalResearch: false,
    };
  }
  if (provider && (localTarget || imperative)) {
    try {
      const classified = await provider.classify({ text, history: options.history });
      if (['answer', 'agent', 'clarify'].includes(classified.lane)) return classified;
    } catch {
      if (localTarget || imperative) {
        return {
          lane: 'agent',
          kind: localTarget ? 'file_operation' : 'tool_use',
          confidence: 0.55,
          reason: 'Structured disposition runtime failed; operational ambiguity fails closed to Agent Runtime.',
          requiresExternalResearch: false,
        };
      }
    }
  }
  if (imperative && !localTarget) {
    return {
      lane: 'clarify',
      kind: deterministic.kind,
      confidence: 0.5,
      reason: 'The requested operation has no canonical target yet.',
      requiresExternalResearch: false,
    };
  }
  return {
    lane: 'answer',
    kind: deterministic.kind,
    confidence: deterministic.confidence,
    reason: deterministic.reason,
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

function isObviousInformationalRequest(text: string): boolean {
  return /^(?:кто|что|где|когда|почему|как|сколько|какой|какая|какие|расскажи|объясни|поясни|who|what|where|when|why|how|tell|explain)(?:\s|$)/iu.test(text)
    || /\?$/.test(text)
    || /^(?:привет|здравствуй|hello|hi|hey)(?:\s|$)/iu.test(text);
}

function hasImperativeShape(text: string): boolean {
  return /(?:^|[.!?]\s*|,\s*)(?:(?:ты\s+)?(?:можешь|сможешь)|could\s+you|can\s+you|would\s+you)?\s*(?:проведи|проверь|просканируй|проаудируй|сделай|выполни|создай|измени|удали|открой|запусти|установи|перемести|скопируй|прочитай|найди|сохрани|очисти|изучи|исследуй|проанализируй|разбери|audit|scan|inspect|study|analyze|review|investigate|do|run|execute|create|change|delete|open|launch|install|move|copy|read|find|save|clean)(?:\s|$)/iu.test(text);
}
