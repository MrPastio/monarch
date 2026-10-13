const SERVICE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const ENV_PREFIX = /^MONARCH_[A-Z0-9_]+$/u;

function configuration() { throw Error('service-integrations:configuration'); }
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) configuration();
  return value;
}

function normalizeEntry(value) {
  exactObject(value, ['id', 'envPrefix', 'status', 'connect', 'disconnect', 'startServer', 'close', 'messages']);
  if (!SERVICE_ID.test(value.id || '') || !ENV_PREFIX.test(value.envPrefix || '')
    || typeof value.status !== 'function' || typeof value.connect !== 'function'
    || typeof value.disconnect !== 'function' || typeof value.startServer !== 'function'
    || value.close !== undefined && typeof value.close !== 'function'
    || !value.messages || typeof value.messages !== 'object' || Array.isArray(value.messages)) configuration();
  return Object.freeze({ ...value, messages: Object.freeze({ ...value.messages }) });
}

function publicFailure(entry, method, error) {
  const exact = entry.messages[error?.message];
  const fallback = entry.messages[method];
  return Error(typeof exact === 'string' ? exact : typeof fallback === 'string' ? fallback : 'Интеграция не выполнила запрос.');
}

/** Owns Desktop-only credential brokers and their ephemeral loopback bindings. */
export function createServiceIntegrationRegistry(entries) {
  if (!Array.isArray(entries) || entries.length < 1) configuration();
  const normalized = entries.map(normalizeEntry);
  if (new Set(normalized.map(entry => entry.id)).size !== normalized.length
    || new Set(normalized.map(entry => entry.envPrefix)).size !== normalized.length) configuration();
  const byId = new Map(normalized.map(entry => [entry.id, entry]));
  const servers = new Map();

  function entryFor(id) {
    if (typeof id !== 'string' || !SERVICE_ID.test(id) || !byId.has(id)) throw Error('service-integrations:unknown');
    return byId.get(id);
  }

  async function invoke(id, method, input) {
    const entry = entryFor(id);
    try {
      if (method === 'status') return await entry.status();
      if (method === 'connect') return await entry.connect(input);
      if (method === 'disconnect') return await entry.disconnect();
      throw Error('service-integrations:operation');
    } catch (error) {
      throw publicFailure(entry, method, error);
    }
  }

  async function startAll() {
    const started = [];
    try {
      for (const entry of normalized) {
        if (servers.has(entry.id)) continue;
        const server = await entry.startServer();
        if (!server || typeof server.endpoint !== 'string' || typeof server.bearerToken !== 'string'
          || typeof server.close !== 'function') configuration();
        servers.set(entry.id, server);
        started.push(entry.id);
      }
    } catch (error) {
      for (const id of started.reverse()) {
        const server = servers.get(id);
        servers.delete(id);
        await server?.close().catch(() => undefined);
      }
      throw error;
    }
    return normalized.map(entry => entry.id);
  }

  function runtimeEnvironment() {
    const environment = {};
    for (const entry of normalized) {
      const server = servers.get(entry.id);
      environment[`${entry.envPrefix}_ENDPOINT`] = server?.endpoint || '';
      environment[`${entry.envPrefix}_TOKEN`] = server?.bearerToken || '';
    }
    return environment;
  }

  async function closeAll() {
    for (const entry of [...normalized].reverse()) await entry.close?.().catch(() => undefined);
    for (const entry of [...normalized].reverse()) {
      const server = servers.get(entry.id);
      servers.delete(entry.id);
      await server?.close().catch(() => undefined);
    }
  }

  return Object.freeze({ ids: Object.freeze(normalized.map(entry => entry.id)), invoke, startAll, runtimeEnvironment, closeAll });
}

export function registerServiceIntegrationIpc({ ipcMain, registry, assertTrustedRenderer }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || !registry || typeof registry.invoke !== 'function'
    || typeof assertTrustedRenderer !== 'function') configuration();
  ipcMain.handle('monarch:integration-status', (event, serviceId) => {
    assertTrustedRenderer(event);
    return registry.invoke(serviceId, 'status');
  });
  ipcMain.handle('monarch:integration-connect', (event, request) => {
    assertTrustedRenderer(event);
    const value = exactObject(request, ['serviceId', 'input']);
    if (!value.input || typeof value.input !== 'object' || Array.isArray(value.input)) configuration();
    return registry.invoke(value.serviceId, 'connect', value.input);
  });
  ipcMain.handle('monarch:integration-disconnect', (event, request) => {
    assertTrustedRenderer(event);
    const value = exactObject(request, ['serviceId', 'confirmed']);
    if (value.confirmed !== true) throw Error('Отключение интеграции не подтверждено.');
    return registry.invoke(value.serviceId, 'disconnect');
  });
}
