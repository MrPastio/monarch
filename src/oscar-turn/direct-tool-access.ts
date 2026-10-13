import type { MonarchOwnerUnrestrictedOverride } from '../core/contracts';

/** Oscar-facing preset of the existing Owner Unrestricted Override.
 * Direct Access is an explicit durable Owner choice: it stays enabled until
 * the Owner turns it off. Safe isolation, secrets and Telegram/Voice are
 * never part of this preset. */
export const OSCAR_DIRECT_TOOL_ACCESS_PRESET = Object.freeze({
  enabled: true,
  lifetime: 'persistent' as const,
  shellApprovalPolicy: 'never' as const,
});

export function oscarDirectToolAccessActive(
  override: MonarchOwnerUnrestrictedOverride | undefined,
  surface?: string,
): boolean {
  if (!override?.enabled) return false;
  // A task-scoped grant belongs to one already running task and grants nothing to a
  // new request. Kernel enforces that; routing every later Turn into the Agent lane on
  // the strength of it would send work there with ordinary gating still in force.
  if (override.lifetime === 'task') return false;
  if (surface && surface !== 'desktop' && surface !== 'coder') return false;
  return true;
}
