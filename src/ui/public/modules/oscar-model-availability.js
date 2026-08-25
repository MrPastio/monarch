const READY_RUNTIME_STATES = new Set(['present', 'ready', 'active', 'experimental']);
const READY_CATALOG_STATES = new Set(['available', 'experimental']);

/**
 * A model is selectable when Monarch can actually infer with it or when its
 * managed text payload is installed. Provisioning remains authoritative for
 * downloads, but a changed download pin must not hide a compatible model that
 * the runtime has already discovered and can execute.
 */
export function resolveSelectableOscarModelAvailability(data, roles) {
  const requestedRoles = Array.isArray(roles) ? roles : [];
  const managedModels = Array.isArray(data?.components?.models) ? data.components.models : [];
  const runtimeEntries = Array.isArray(data?.modelRuntime?.entries) ? data.modelRuntime.entries : [];
  const catalogModels = Array.isArray(data?.models?.models) ? data.models.models : [];
  if (managedModels.length === 0 && runtimeEntries.length === 0 && catalogModels.length === 0) return null;

  return Object.fromEntries(requestedRoles.map((role) => {
    const managed = managedModels.find((entry) => entry?.role === role);
    const runtime = runtimeEntries.find((entry) => entry?.role === role);
    const catalog = catalogModels.find((entry) => entry?.role === role);
    const runtimeReady = runtime?.canInfer === true
      || READY_RUNTIME_STATES.has(String(runtime?.runnerStatus || '').toLowerCase());
    const catalogReady = READY_CATALOG_STATES.has(String(catalog?.status || '').toLowerCase());
    return [role, managed?.installed === true || runtimeReady || catalogReady];
  }));
}

export function filterSelectableOscarModelScale(scale, availability) {
  const roles = Array.isArray(scale) ? scale : [];
  if (!availability) return [...roles];
  return roles.filter((role) => availability[role] === true);
}
