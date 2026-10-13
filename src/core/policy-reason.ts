import type { MonarchPolicyEvidence } from './contracts';

/** Plain-language reason a Kernel decision stopped for the person. */
export type MonarchPolicyReasonKind =
  | 'mode' | 'security' | 'security-confirm-all' | 'irreversible' | 'intent' | 'command'
  | 'red-zone' | 'protected-path' | 'policy';

/** The deciding evidence is the last warn/block entry: the Kernel returns right
 * after recording the rule that stopped the action, and Security's final facts
 * are appended after the preflight evidence. */
export function policyReasonKind(evidence: readonly Partial<MonarchPolicyEvidence>[] | undefined): MonarchPolicyReasonKind {
  const deciding = [...(evidence || [])].reverse().find(entry => entry?.severity === 'warn' || entry?.severity === 'block');
  const code = String(deciding?.code || '');
  if (!deciding) return 'policy';
  if (code.startsWith('model-policy.')) return 'security-confirm-all';
  if (code.startsWith('shell.exact-action-card')) return 'command';
  if (code.startsWith('risk.irreversible')) return 'irreversible';
  if (code.startsWith('filesystem.')) return /red-zone/u.test(code) ? 'red-zone' : 'protected-path';
  if (deciding.source === 'security') return 'security';
  if (deciding.source === 'permission') return 'mode';
  if (deciding.source === 'lease' || deciding.source === 'provenance' || code.startsWith('proposal.user-intent')) return 'intent';
  return 'policy';
}
