import { resolveOscarFunctionInvocation } from '../core/oscar-function-invocation';
import { normalizeApplicationRequest } from '../modules/device';

export type TrustedComputerUseWorkflowKind = 'calculator' | 'interactive';

export interface TrustedComputerUseCalculation {
  expression: string;
  expectedText: string;
  keySequence: string[];
}

export interface TrustedComputerUseWorkflowGoal {
  application: string;
  applicationQuery: string;
  objective: string;
  kind: TrustedComputerUseWorkflowKind;
  calculation?: TrustedComputerUseCalculation;
  expectedText?: string;
  trustedTextInputs: string[];
}

const OPEN_WORKFLOW_PATTERN = /^(?:please\s+)?(?:открой|запусти|open|launch|start)\s+(?:(?:приложение|программу|app|application)\s+)?([\p{L}\p{N} ._-]{1,120}?)\s*(?:,|\s)\s*(?:и\s+затем|а\s+затем|а\s+потом|затем|потом|и|then|and\s+then|and)\s+(.{2,1000}?)\s*[.!?]?$/iu;

/**
 * Compile only a leading, user-authored Computer Use invocation that asks to
 * open one application and continue inside it. The application and any exact
 * text postcondition remain derived from the trusted original request; window
 * references and UI targets still come only from native observations.
 */
export function parseTrustedComputerUseWorkflow(value: unknown): TrustedComputerUseWorkflowGoal | null {
  const request = typeof value === 'string' ? value : '';
  const invocation = resolveOscarFunctionInvocation(request);
  if (invocation?.id !== 'computer-use') return null;
  const match = invocation.requestText.match(OPEN_WORKFLOW_PATTERN);
  const rawApplication = match?.[1]?.replace(/\s+/gu, ' ').trim() || '';
  const objective = match?.[2]?.replace(/\s+/gu, ' ').trim() || '';
  if (!rawApplication || !objective || /[;\r\n]/u.test(rawApplication)) return null;

  let application: string;
  try {
    application = normalizeApplicationRequest(rawApplication);
  } catch {
    return null;
  }

  const calculation = application.toLocaleLowerCase() === 'calculator'
    ? compileTrustedCalculatorExpression(objective)
    : null;
  if (calculation) {
    return {
      application,
      applicationQuery: application,
      objective,
      kind: 'calculator',
      calculation,
      expectedText: calculation.expectedText,
      trustedTextInputs: [],
    };
  }

  const trustedTextInputs = extractTrustedWorkflowTextInputs(objective);
  const expectedText = trustedWorkflowExpectedText(objective, trustedTextInputs);
  return {
    application,
    applicationQuery: application,
    objective,
    kind: 'interactive',
    trustedTextInputs,
    ...(expectedText ? { expectedText } : {}),
  };
}

/**
 * A deterministic fast path for bounded arithmetic. It is intentionally an
 * input compiler, not a calculator UI shortcut: every returned key is still a
 * separate observed Windows input atom with its own native receipt.
 */
export function compileTrustedCalculatorExpression(value: unknown): TrustedComputerUseCalculation | null {
  const objective = typeof value === 'string' ? value.normalize('NFKC') : '';
  const match = objective.match(/(?:^|\s)(\d{1,9})\s*([+\-*/×÷])\s*(\d{1,9})(?:\s|$|[.!?])/u);
  if (!match) return null;
  const leftText = match[1]!;
  const operator = match[2]!;
  const rightText = match[3]!;
  const left = Number(leftText);
  const right = Number(rightText);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;

  let result: number;
  let operationKey: 'add' | 'subtract' | 'multiply' | 'divide';
  if (operator === '+') {
    result = left + right;
    operationKey = 'add';
  } else if (operator === '-') {
    result = left - right;
    operationKey = 'subtract';
  } else if (operator === '*' || operator === '×') {
    result = left * right;
    operationKey = 'multiply';
  } else {
    if (right === 0) return null;
    result = left / right;
    operationKey = 'divide';
  }
  if (!Number.isFinite(result) || !Number.isSafeInteger(result) || Math.abs(result) > 999_999_999_999_999) {
    return null;
  }

  return {
    expression: `${leftText}${operator}${rightText}`,
    expectedText: String(result),
    keySequence: ['escape', ...leftText, operationKey, ...rightText, 'enter'],
  };
}

function extractTrustedWorkflowTextInputs(objective: string): string[] {
  return [...new Set([...objective.matchAll(/[«“„"']([^\r\n«»“”„"']{1,500})[»”“"']/gu)]
    .map((match) => match[1]?.replace(/\s+/gu, ' ').trim() || '')
    .filter(Boolean))];
}

function trustedWorkflowExpectedText(objective: string, quoted: readonly string[]): string {
  if (quoted.length === 0) return '';
  // For messaging requests, the last quoted literal is the exact message;
  // earlier literals commonly identify a chat or recipient.
  if (/(?:сообщени|напиши|отправ|send|message|write)/iu.test(objective)) return quoted.at(-1)!;
  return quoted.length === 1 ? quoted[0]! : '';
}
