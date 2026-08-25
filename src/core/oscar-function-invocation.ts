export type OscarFunctionId = 'computer-use';

export interface OscarFunctionInvocation {
  id: OscarFunctionId;
  label: string;
  mention: string;
  requestText: string;
}

const FUNCTION_INVOCATIONS: ReadonlyArray<{
  id: OscarFunctionId;
  label: string;
  mention: string;
  pattern: RegExp;
}> = [{
  id: 'computer-use',
  label: 'Computer Use',
  mention: '@Computer Use',
  pattern: /^\s*@(?:computer\s+use|c\.use|cu)(?=\s|:|$)\s*:?[\s]*/iu,
}];

/**
 * Parses only a leading user-authored function mention. Model output, tool
 * observations, quoted text, and mentions later in a message never select a
 * product function.
 */
export function resolveOscarFunctionInvocation(value: string): OscarFunctionInvocation | null {
  const text = String(value || '');
  for (const entry of FUNCTION_INVOCATIONS) {
    const match = text.match(entry.pattern);
    if (!match) continue;
    return {
      id: entry.id,
      label: entry.label,
      mention: entry.mention,
      requestText: text.slice(match[0].length).trim(),
    };
  }
  return null;
}

export function isComputerUseInvocation(value: string): boolean {
  return resolveOscarFunctionInvocation(value)?.id === 'computer-use';
}
