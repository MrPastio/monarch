import type { AgentEvidenceReference } from '../agent';

export const OSCAR_INCIDENT_FAKE_STORAGE_AUDIT = [
  'Готово! Я просканировал диск D: и нашёл 42 каталога.',
  'Самые большие: D:\\Projects\\Archive — 182 ГБ, D:\\Data\\Logs — 64 ГБ и D:\\Temp\\Old_Cache — 31 ГБ.',
  'Аудит завершён, ничего не удалялось.',
].join(' ');

export interface ClaimIntegrityContext {
  executionAuthority: 'none' | 'kernel';
  evidence: AgentEvidenceReference[];
}

export interface ClaimIntegrityResult {
  allowed: boolean;
  visibleText: string;
  replacement: string;
  reasons: string[];
  semanticCheckUsed: boolean;
}

export interface ClaimIntegritySemanticVerifier {
  verify(input: { sentence: string; context: ClaimIntegrityContext }): Promise<'allow' | 'block'>;
}

const STRUCTURAL_MARKER = /(?:\[\s*Kernel[- ](?:действие|action)\s*\]|MONARCH_ACTION|<\/?(?:tool_call|function_call|action_proposal)\b|"capabilityId"\s*:|"canonicalProposalHash"\s*:)/iu;
const TEXT_CONFIRMATION = /(?:напиш|ответ|скажи|произнес|подтверд).{0,56}(?:«|"|')?\s*подтверждаю(?:[^\p{L}]|$)|(?:^|[^\p{L}])подтверди(?:те)?(?:[^\p{L}]|$).{0,120}(?:нача|запуст|выполн|скан|аудит|удал|перемест|архив|измен|созда|операц|действ)|(?:^|[^A-Za-z])(?:please\s+)?confirm(?:[^A-Za-z]|$).{0,120}(?:start|launch|execute|scan|audit|delete|move|archive|change|create|operation|action)|(?:^|[^A-Za-z])(?:type|say|reply)(?:[^A-Za-z]|$).{0,48}(?:confirm|confirmed|i confirm)(?:[^A-Za-z]|$)/iu;
const LOCAL_OPERATION_CLAIM = /(?:(?:^|[^\p{L}])(?:я|мы)\s+(?:уже\s+)?(?:просканировал|проверил|прочитал|проаудировал|создал|изменил|удалил|переместил|открыл|запустил|установил|очистил|сохранил|выполнил)(?:[^\p{L}]|$)|(?:^|[^\p{L}])(?:готово|выполнено|завершено)(?:[^\p{L}]|$).{0,80}(?:скан|аудит|операц|задач|удален|создан|изменен)|(?:^|[^A-Za-z])(?:i|we)\s+(?:have\s+)?(?:scanned|audited|inspected|created|changed|deleted|moved|opened|launched|installed|cleaned|saved|executed)(?:[^A-Za-z]|$)|(?:^|[^A-Za-z])(?:scan|audit|operation|task)\s+(?:is\s+)?(?:complete|completed|done)(?:[^A-Za-z]|$))/iu;
const LOCAL_OPERATION_COMMITMENT = /(?:(?:^|[^\p{L}])(?:я\s+)?(?:начинаю|приступаю|запускаю|перехожу\s+к|сейчас\s+(?:начну|запущу)|буду)\s+.{0,96}(?:скан|аудит|анализ|провер|чтен|удал|перемещ|архив|сортир|классиф|операц|действ)|(?:^|[^A-Za-z])(?:i\s+am\s+starting|i(?:'ll|\s+will)\s+(?:start|scan|audit|inspect|delete|move|archive|sort)|starting)\s+.{0,96}(?:scan|audit|inspection|deletion|move|archive|sort|operation|action))/iu;
const LOCAL_FACT_WITH_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\s]+).{0,100}(?:\b\d+(?:[.,]\d+)?\s*(?:bytes?|кб|мб|гб|тб|kb|mb|gb|tb)\b|\b\d+\s+(?:файл|папк|каталог|директор|files?|folders?|directories)\b)/iu;
const PROVIDER_IDENTITY_CONFLICT = /(?:(?:^|[^\p{L}])я\s+.{0,96}(?:представляюсь|являюсь|выступаю|не\s+могу\s+(?:говорить|представляться)|как)\s+.{0,48}(?:языков\p{L}*\s+модел\p{L}*|language\s+model).{0,32}(?:google|gemma)|(?:^|[^A-Za-z])i\s+.{0,96}(?:identify|introduce|am|as)\s+.{0,48}language\s+model.{0,32}(?:google|gemma))/iu;

export class ClaimIntegrityGate {
  constructor(private readonly semanticVerifier?: ClaimIntegritySemanticVerifier) {}

  createSession(context: ClaimIntegrityContext): ClaimIntegritySession {
    return new ClaimIntegritySession(context, this.semanticVerifier);
  }

  async inspectCompleteAnswer(text: string, context: ClaimIntegrityContext): Promise<ClaimIntegrityResult> {
    const original = String(text || '');
    const sentences = [original, ...splitIntegritySegments(original, true).segments];
    const reasons = new Set<string>();
    let semanticCheckUsed = false;
    for (const sentence of sentences) {
      const result = await inspectAnswerOnlyClaim(sentence, context, this.semanticVerifier);
      result.reasons.forEach((reason) => reasons.add(reason));
      semanticCheckUsed ||= result.semanticCheckUsed;
      if (!result.allowed) {
        const collectedReasons = [...reasons];
        return {
          allowed: false,
          visibleText: '',
          replacement: integrityReplacement(collectedReasons),
          reasons: collectedReasons,
          semanticCheckUsed,
        };
      }
    }
    return {
      allowed: true,
      visibleText: original,
      replacement: '',
      reasons: [],
      semanticCheckUsed,
    };
  }
}

function integrityReplacement(reasons: string[]): string {
  if (reasons.includes('provider-identity-conflict')) {
    return 'Я Oscar — локальный ассистент и агентский интерфейс Monarch.';
  }
  return 'Действие не подтверждено: Kernel ничего не выполнял, поэтому ничего не было выполнено.';
}

export class ClaimIntegritySession {
  private pending = '';
  private released = '';
  private stopped = false;

  constructor(
    private readonly context: ClaimIntegrityContext,
    private readonly semanticVerifier?: ClaimIntegritySemanticVerifier,
  ) {}

  get visibleText(): string {
    return this.released;
  }

  async append(fragmentInput: string): Promise<string[]> {
    const fragment = String(fragmentInput || '');
    if (!fragment) return [];
    this.pending += fragment;
    if (this.stopped) return [];
    const drained = splitIntegritySegments(this.pending, false);
    this.pending = drained.remainder;
    const deltas: string[] = [];
    for (let index = 0; index < drained.segments.length; index += 1) {
      const segment = drained.segments[index]!;
      const inspectionWindow = `${this.released.slice(-160)}${segment}`;
      const inspected = await inspectAnswerOnlyClaim(inspectionWindow, this.context, this.semanticVerifier);
      if (!inspected.allowed) {
        this.pending = drained.segments.slice(index).join('') + this.pending;
        this.stopped = true;
        break;
      }
      this.released += segment;
      deltas.push(segment);
    }
    return deltas;
  }
}

export async function inspectAnswerOnlyClaim(
  sentenceInput: string,
  context: ClaimIntegrityContext,
  semanticVerifier?: ClaimIntegritySemanticVerifier,
): Promise<ClaimIntegrityResult> {
  const sentence = String(sentenceInput || '').trim();
  const reasons: string[] = [];
  if (STRUCTURAL_MARKER.test(sentence)) reasons.push('forbidden-structural-marker');
  if (TEXT_CONFIRMATION.test(sentence)) reasons.push('text-confirmation-request');
  if (PROVIDER_IDENTITY_CONFLICT.test(sentence)) reasons.push('provider-identity-conflict');
  const effectLike = LOCAL_OPERATION_CLAIM.test(sentence)
    || LOCAL_OPERATION_COMMITMENT.test(sentence)
    || LOCAL_FACT_WITH_PATH.test(sentence);
  if (context.executionAuthority === 'none' && effectLike) {
    reasons.push('unverified-local-operation-claim');
    if (semanticVerifier) {
      const eligibleEvidence = context.evidence.some((entry) => (
        entry.evidenceClass === 'kernel-observation' || entry.evidenceClass === 'kernel-verification'
      ));
      if (eligibleEvidence) {
        const decision = await semanticVerifier.verify({ sentence, context });
        return {
          allowed: reasons.length === 1 && decision === 'allow',
          visibleText: decision === 'allow' ? sentence : '',
          replacement: decision === 'allow' ? '' : 'Действие не подтверждено: Kernel ничего не выполнял, поэтому ничего не было выполнено.',
          reasons: decision === 'allow' ? [] : reasons,
          semanticCheckUsed: true,
        };
      }
    }
  }
  const allowed = reasons.length === 0;
  return {
    allowed,
    visibleText: allowed ? sentence : '',
    replacement: allowed ? '' : 'Действие не подтверждено: Kernel ничего не выполнял, поэтому ничего не было выполнено.',
    reasons,
    semanticCheckUsed: false,
  };
}

function splitIntegritySegments(value: string, flushRemainder: boolean): { segments: string[]; remainder: string } {
  const text = String(value || '');
  if (!text) return { segments: [], remainder: '' };
  const segments: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    let end = -1;
    if (character === '\n') {
      end = index + 1;
    } else if (/[.!?…]/u.test(character) && index + 1 < text.length && /\s/u.test(text[index + 1]!)) {
      end = index + 2;
      while (end < text.length && /[\t \r]/u.test(text[end]!)) end += 1;
    }
    if (end > start) {
      segments.push(text.slice(start, end));
      start = end;
      index = end;
      continue;
    }
    index += 1;
  }
  const remainder = text.slice(start);
  if (flushRemainder && remainder) return { segments: [...segments, remainder], remainder: '' };
  return { segments, remainder };
}
