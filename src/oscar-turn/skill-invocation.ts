export interface OscarSkillInvocation {
  name: string;
  requestText: string;
}

/**
 * Parse only the explicit, leading skill syntax rendered by the composer.
 * The selection is routing/context metadata; it never grants execution
 * authority and is removed before an operational goal reaches Agent Runtime.
 */
export function parseLeadingOscarSkillInvocation(valueInput: unknown): OscarSkillInvocation | null {
  const value = String(valueInput || '').trim();
  const match = value.match(/^\$([a-z\d][a-z\d._-]{0,127})(?=$|\s)\s*/iu);
  if (!match) return null;
  return {
    name: String(match[1] || '').toLocaleLowerCase('en-US'),
    requestText: value.slice(match[0].length).trim(),
  };
}

export function stripLeadingOscarSkillInvocation(valueInput: unknown): string {
  const value = String(valueInput || '').trim();
  const invocation = parseLeadingOscarSkillInvocation(value);
  return invocation?.requestText || value;
}
