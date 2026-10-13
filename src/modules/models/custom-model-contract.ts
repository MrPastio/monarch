/** Owner-added local models use `custom-<id>` roles. They answer in the
 * ordinary chat only; agent work keeps the verified Monarch models. */
export const CUSTOM_MODEL_ROLE_PATTERN = /^custom-[a-z0-9]{6,32}$/u;

export function isCustomModelRole(value: unknown): value is string {
  return typeof value === 'string' && CUSTOM_MODEL_ROLE_PATTERN.test(value);
}
