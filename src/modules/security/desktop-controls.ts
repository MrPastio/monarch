/** Explicit user controls on the Security screen. Never an agent/API allowlist. */
export const SECURITY_DESKTOP_CONTROLS = new Set([
  'security.inspection.retry',
  'security.background.enable', 'security.background.disable',
  'security.protection.start', 'security.protection.stop', 'security.profile.set',
  'security.model_policy.set', 'security.network.profile.trust',
  'security.pin.set', 'security.pin.recover', 'security.incident.status',
  'security.quarantine.isolate', 'security.quarantine.restore',
  'security.response.propose', 'security.response.approve', 'security.emergency.resolve',
  'security.baseline.write', 'security.benchmark.start', 'security.benchmark.cancel',
]);
