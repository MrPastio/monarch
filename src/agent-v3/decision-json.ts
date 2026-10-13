import { astraJournalJson, type AstraJson } from './journal';

/** Shared syntax validation only: never grants authority or changes field values. */
export function parseAstraDecisionJson(raw: string, maximum = 16384): { value: Record<string, unknown>; normalized: string[] } {
  const reject = (code: string): never => { throw Error('astra-decision:' + code); };
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) reject('decision-size');
  let text = raw.trim(); const normalized: string[] = [];
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(text);
  if (fence) { text = fence[1]!.trim(); normalized.push('json-fence'); }
  const value: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [], keyStates: boolean[] = []; let expectKey = false;
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu)) {
    const part = token[0];
    if (part === '{' || part === '[') {
      keyStates.push(expectKey); stack.push(part === '{' ? new Set() : null); expectKey = part === '{';
      if (stack.length > 16) reject('decision-depth');
    } else if (part === '}' || part === ']') { stack.pop(); expectKey = keyStates.pop() ?? false; }
    else if (part === ',') expectKey = stack.at(-1) instanceof Set;
    else if (part.startsWith('"') && expectKey && stack.at(-1) instanceof Set) {
      const key = JSON.parse(part) as string, keys = stack.at(-1)!;
      if (keys.has(key)) reject('duplicate-key'); keys.add(key); expectKey = false;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('decision-object');
  astraJournalJson(value as AstraJson);
  return { value: value as Record<string, unknown>, normalized };
}
