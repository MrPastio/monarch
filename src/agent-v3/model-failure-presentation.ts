import type { AstraJournalSnapshot } from './journal';
import type { AstraModelWorkCheckpoint } from './model-work-adapter';

/** Closed user-presentation category. Raw provider/runtime codes remain in the
 * internal model-work frontier and are never copied into normal UI. */
export type AstraModelFailureCategory = 'model-connection-unavailable' | 'model-safety-blocked' | 'model-response-invalid';

export function classifyAstraModelWorkFailure(snapshot: AstraJournalSnapshot | null): AstraModelFailureCategory | undefined {
  if (!snapshot) return undefined;
  const checkpoint = snapshot.checkpoint as unknown as AstraModelWorkCheckpoint;
  const code = checkpoint.decision?.status === 'blocked' ? checkpoint.decision.code : checkpoint.reason;
  if (typeof code !== 'string') return undefined;
  if (code.startsWith('safety-blocked-')) return 'model-safety-blocked';
  if (new Set([
    'credential-unavailable', 'credential-invalid', 'credential-rejected', 'settings-not-configured',
    'settings-unavailable', 'settings-corrupt', 'provider-timeout', 'provider-unavailable',
    'provider-rate-limited', 'provider-failed', 'transport-deadline', 'transport-unavailable',
    'transport-body-failed', 'host-request-failed', 'host-request-refused', 'model-unavailable',
  ]).has(code)) return 'model-connection-unavailable';
  if (code.startsWith('provider-') || code.startsWith('response-') || new Set([
    'proposal-json', 'proposal-schema', 'proposal-transport-schema', 'model-output-limit',
    'context-driver-drift', 'model-decision-failed',
  ]).has(code)) return 'model-response-invalid';
  return undefined;
}
