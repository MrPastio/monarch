import path from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { startServiceSecretServer } from './service-secret-server.mjs';
import { renameWithRetry } from './windows-rename.mjs';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;

const exactObject = (value, keys, code = 'github:input') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw Error(code);
  return value;
};
const tokenValue = value => {
  const token = String(value || '').trim();
  if (token.length < 20 || token.length > 512 || /\s/u.test(token)) throw Error('github:token');
  return token;
};
const repositoryValue = value => {
  const repository = String(value || '').trim();
  const [owner, name, extra] = repository.split('/');
  if (extra !== undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner || '')
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(name || '') || name === '.' || name === '..') throw Error('github:input');
  return repository;
};
const repositoriesValue = value => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw Error('github:repositories');
  const repositories = value.map(repositoryValue);
  if (new Set(repositories.map(item => item.toLocaleLowerCase('en-US'))).size !== repositories.length) {
    throw Error('github:repositories');
  }
  return repositories;
};
const permissionsValue = value => {
  const permissions = exactObject(value, ['read', 'issues', 'pullRequests'], 'github:permissions');
  if (Object.values(permissions).some(item => typeof item !== 'boolean') || !Object.values(permissions).some(Boolean)) {
    throw Error('github:permissions');
  }
  return { read: permissions.read, issues: permissions.issues, pullRequests: permissions.pullRequests };
};
const bounded = async (response, maximum = MAX_RESPONSE_BYTES) => {
  if (!response?.body) throw Error('github:empty-response');
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(length) && length > maximum) throw Error('github:response-budget');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw Error('github:response-budget'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
};
const responseJson = async (response, maximum) => {
  let value;
  try { value = JSON.parse((await bounded(response, maximum)).toString('utf8')); }
  catch (error) { if (error?.message?.startsWith('github:')) throw error; throw Error('github:provider-json'); }
  if (!response.ok) throw Error(response.status === 401 ? 'github:authentication'
    : response.status === 403 ? 'github:permission-required'
      : response.status === 404 ? 'github:provider-not-found' : 'github:provider-rejected');
  return value;
};
const stateValue = value => ['open', 'closed', 'all'].includes(value) ? value : value === undefined ? 'open' : (() => { throw Error('github:input'); })();
const maxResultsValue = value => {
  const result = value === undefined ? 20 : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 50) throw Error('github:input');
  return result;
};
const issueNumberValue = value => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647) throw Error('github:input');
  return result;
};
const textValue = (value, maximum, required = false) => {
  const result = String(value ?? '').trim();
  if (required && !result || Buffer.byteLength(result) > maximum) throw Error('github:input');
  return result;
};

export function createGitHubSecretBroker({ dataRoot, safeStorage, fetchImpl = fetch, restrictAccess = async () => true }) {
  const recordPath = path.join(dataRoot, 'github-token.encrypted');
  const requireEncryption = () => { if (!safeStorage?.isEncryptionAvailable?.()) throw Error('github:encryption-unavailable'); };

  function normalizeRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1 || typeof value.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/u.test(value.login)
      || typeof value.token !== 'string' || value.token.length < 20 || value.token.length > 512 || /\s/u.test(value.token)
      || !Array.isArray(value.repositories) || !value.permissions) throw Error('github:credential-record');
    const repositories = repositoriesValue(value.repositories);
    const permissions = permissionsValue(value.permissions);
    return { version: 1, login: value.login, token: value.token, repositories, permissions,
      connectedAt: typeof value.connectedAt === 'string' ? value.connectedAt : new Date().toISOString() };
  }

  async function readRecord() {
    requireEncryption();
    let bytes;
    try { bytes = await readFile(recordPath); }
    catch (error) { if (error?.code === 'ENOENT') throw Error('github:not-connected'); throw Error('github:credential-record'); }
    if (bytes.byteLength > 64 * 1024) throw Error('github:credential-record');
    try { return normalizeRecord(JSON.parse(safeStorage.decryptString(bytes))); }
    catch (error) { if (error?.message === 'github:credential-record') throw error; throw Error('github:credential-record'); }
  }

  async function saveRecord(record) {
    const normalized = normalizeRecord(record);
    requireEncryption();
    await mkdir(dataRoot, { recursive: true });
    if (await restrictAccess(dataRoot) !== true) throw Error('github:protected-record');
    const temporary = `${recordPath}.${randomBytes(8).toString('hex')}.tmp`;
    const encrypted = Buffer.from(safeStorage.encryptString(JSON.stringify(normalized)));
    if (!encrypted.length || encrypted.length > 64 * 1024) throw Error('github:credential-record');
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, recordPath);
    } catch (error) {
      await unlink(temporary).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw unlinkError; });
      throw error;
    }
  }

  async function api(record, route, options = {}) {
    const response = await fetchImpl(`${API}${route}`, {
      method: options.method ?? 'GET',
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(60_000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${record.token}`,
        'x-github-api-version': API_VERSION,
        'user-agent': 'Monarch-Oscar-Agent',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return responseJson(response, options.maxBytes ?? MAX_RESPONSE_BYTES);
  }

  function requirePermission(record, permission) {
    if (record.permissions[permission] !== true) throw Error('github:permission-required');
  }
  function requireRepository(record, value) {
    const repository = repositoryValue(value);
    const allowed = record.repositories.find(item => item.toLocaleLowerCase('en-US') === repository.toLocaleLowerCase('en-US'));
    if (!allowed) throw Error('github:repository-denied');
    return allowed;
  }

  async function configure(raw) {
    const input = exactObject(raw, ['token', 'repositories', 'permissions'], 'github:configuration');
    const token = tokenValue(input.token);
    const repositories = repositoriesValue(input.repositories);
    const permissions = permissionsValue(input.permissions);
    const provisional = { token };
    const profile = await api(provisional, '/user', { maxBytes: 128 * 1024 });
    const login = String(profile.login || '');
    if (!/^[A-Za-z0-9-]{1,39}$/u.test(login)) throw Error('github:profile');
    for (const repository of repositories) {
      const metadata = await api(provisional, `/repos/${repository}`, { maxBytes: 256 * 1024 });
      if (String(metadata.full_name || '').toLocaleLowerCase('en-US') !== repository.toLocaleLowerCase('en-US')) {
        throw Error('github:repository-denied');
      }
    }
    await saveRecord({ version: 1, login, token, repositories, permissions, connectedAt: new Date().toISOString() });
    return status();
  }

  async function operation(name, rawInput = {}, signal) {
    signal?.throwIfAborted();
    if (name === 'status') { exactObject(rawInput, []); return status(); }
    const record = await readRecord();
    signal?.throwIfAborted();
    const operationSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    if (name === 'repositories.list') {
      exactObject(rawInput, []);
      requirePermission(record, 'read');
      const repositories = [];
      for (const repository of record.repositories) {
        const metadata = await api(record, `/repos/${repository}`, { maxBytes: 256 * 1024, signal: operationSignal });
        repositories.push({ name: repository, private: metadata.private === true,
          defaultBranch: String(metadata.default_branch || '').slice(0, 255),
          description: String(metadata.description || '').slice(0, 2048),
          url: String(metadata.html_url || '').slice(0, 2048) });
      }
      return { repositories };
    }
    const allowedFields = name === 'repository.file.read' ? ['repository', 'path', 'ref']
      : name === 'issues.list' || name === 'pull-requests.list' ? ['repository', 'state', 'maxResults']
        : name === 'issue.create' ? ['repository', 'title', 'body']
          : name === 'pull-request.comment' ? ['repository', 'pullNumber', 'body'] : [];
    if (allowedFields.length === 0) throw Error('github:operation-denied');
    const input = exactObject(rawInput, allowedFields);
    const repository = requireRepository(record, input.repository);
    if (name === 'repository.file.read') {
      requirePermission(record, 'read');
      const filePath = textValue(input.path, 2048, true);
      if (filePath.startsWith('/') || filePath.includes('\\') || filePath.split('/').some(part => !part || part === '.' || part === '..')) {
        throw Error('github:input');
      }
      const ref = input.ref === undefined ? '' : textValue(input.ref, 255, true);
      const payload = await api(record, `/repos/${repository}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
        { maxBytes: 512 * 1024, signal: operationSignal });
      if (payload.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string') throw Error('github:not-text-file');
      const bytes = Buffer.from(payload.content.replace(/\s/gu, ''), 'base64');
      if (bytes.byteLength > MAX_FILE_BYTES || bytes.includes(0)) throw Error('github:not-text-file');
      const content = bytes.toString('utf8');
      if (Buffer.from(content, 'utf8').compare(bytes) !== 0) throw Error('github:not-text-file');
      return { repository, path: filePath, ref: ref || null, sha: String(payload.sha || ''), size: bytes.byteLength, content };
    }
    if (name === 'issues.list') {
      requirePermission(record, 'issues');
      const state = stateValue(input.state), maxResults = maxResultsValue(input.maxResults);
      const payload = await api(record, `/repos/${repository}/issues?state=${state}&per_page=${maxResults}`,
        { signal: operationSignal });
      const issues = Array.isArray(payload) ? payload.filter(item => !item.pull_request).slice(0, maxResults).map(item => ({
        number: issueNumberValue(item.number), title: String(item.title || '').slice(0, 256), state: String(item.state || ''),
        author: String(item.user?.login || '').slice(0, 64), url: String(item.html_url || '').slice(0, 2048),
        updatedAt: String(item.updated_at || ''), labels: Array.isArray(item.labels) ? item.labels.slice(0, 32).map(label => String(label.name || '').slice(0, 128)) : [],
      })) : [];
      return { repository, issues };
    }
    if (name === 'issue.create') {
      requirePermission(record, 'issues');
      const title = textValue(input.title, 256, true), body = textValue(input.body, 65536);
      const issue = await api(record, `/repos/${repository}/issues`, { method: 'POST', signal: operationSignal,
        body: { title, ...(body ? { body } : {}) } });
      return { repository, number: issueNumberValue(issue.number), title: String(issue.title || title).slice(0, 256),
        url: String(issue.html_url || '').slice(0, 2048), state: String(issue.state || '') };
    }
    if (name === 'pull-requests.list') {
      requirePermission(record, 'pullRequests');
      const state = stateValue(input.state), maxResults = maxResultsValue(input.maxResults);
      const payload = await api(record, `/repos/${repository}/pulls?state=${state}&per_page=${maxResults}`,
        { signal: operationSignal });
      const pullRequests = Array.isArray(payload) ? payload.slice(0, maxResults).map(item => ({
        number: issueNumberValue(item.number), title: String(item.title || '').slice(0, 256), state: String(item.state || ''),
        author: String(item.user?.login || '').slice(0, 64), draft: item.draft === true,
        head: String(item.head?.label || '').slice(0, 255), base: String(item.base?.label || '').slice(0, 255),
        url: String(item.html_url || '').slice(0, 2048), updatedAt: String(item.updated_at || ''),
      })) : [];
      return { repository, pullRequests };
    }
    if (name === 'pull-request.comment') {
      requirePermission(record, 'pullRequests');
      const pullNumber = issueNumberValue(input.pullNumber), body = textValue(input.body, 65536, true);
      const comment = await api(record, `/repos/${repository}/issues/${pullNumber}/comments`, {
        method: 'POST', signal: operationSignal, body: { body },
      });
      return { repository, pullNumber, commentId: Number(comment.id), url: String(comment.html_url || '').slice(0, 2048),
        createdAt: String(comment.created_at || '') };
    }
    throw Error('github:operation-denied');
  }

  const present = record => ({ connected: true, login: record.login,
    repositories: [...record.repositories], permissions: { ...record.permissions } });
  const status = () => readRecord().then(present).catch(error => error.message === 'github:not-connected'
    ? { connected: false, login: '', repositories: [], permissions: { read: false, issues: false, pullRequests: false } }
    : Promise.reject(error));
  const disconnect = async () => {
    try { await unlink(recordPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw Error('github:credential-record'); }
    return status();
  };
  return { configure, operation, status, disconnect };
}

export function startGitHubSecretServer(broker) {
  return startServiceSecretServer({ serviceId: 'github', operation: broker.operation });
}
