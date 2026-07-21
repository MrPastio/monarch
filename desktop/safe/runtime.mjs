import process from 'node:process';
import { SafeVault, SafeVaultError } from './vault.mjs';
import { verifySafeCapabilityToken } from './capability-token.mjs';

const rootPath = process.env.MONARCH_SAFE_ROOT || '';
let vault = null;
let activePort = null;
let queue = Promise.resolve();
let capabilityKey = null;
const usedCapabilityNonces = new Set();

process.parentPort?.on('message', (event) => {
  if (event.data?.type === 'service-request') {
    queue = queue.then(() => handleServiceRequest(event.data)).catch(() => undefined);
    return;
  }
  if (event.data?.type !== 'connect' || !event.ports?.[0]) return;
  const reconnecting = Boolean(vault);
  if (activePort) {
    try { activePort.close(); } catch { /* already closed */ }
    activePort = null;
  }
  const connectedPort = event.ports[0];
  if (!vault) {
    capabilityKey = Buffer.from(event.data.capabilityKey || []);
    if (capabilityKey.byteLength !== 32) throw new Error('Monarch Safe capability authority is unavailable.');
    const qaAutoLockMs = process.env.MONARCH_SAFE_QA === '1' ? Number(process.env.MONARCH_SAFE_QA_AUTO_LOCK_MS) : undefined;
    vault = new SafeVault(rootPath, {
      testKdf: process.env.MONARCH_SAFE_QA === '1',
      deviceKey: event.data.deviceKey,
      ...(Number.isSafeInteger(qaAutoLockMs) ? { autoLockMs: qaAutoLockMs } : {}),
      onAutoLock: (status) => {
        if (activePort) activePort.postMessage({ type: 'event', event: 'auto-lock', data: status });
        emitParentStatus('auto-lock', status);
      },
    });
    queue = queue.then(() => vault.initialize());
  } else if (reconnecting) {
    queue = queue.then(() => vault.lock());
  }
  activePort = connectedPort;
  connectedPort.on('message', (messageEvent) => {
    const request = messageEvent.data;
    queue = queue.then(() => handleRequest(connectedPort, request)).catch(() => undefined);
  });
  connectedPort.on('close', () => {
    if (activePort !== connectedPort) return;
    activePort = null;
    queue = queue.then(() => {
      const status = vault?.lock();
      emitParentStatus('status', status);
    }).catch(() => undefined);
  });
  connectedPort.start();
  queue = queue.then(() => {
    if (activePort === connectedPort) connectedPort.postMessage({ type: 'event', event: 'ready', data: vault.status() });
  }).catch(() => undefined);
});

process.on('exit', () => { vault?.lock(); capabilityKey?.fill(0); });

async function handleRequest(port, request) {
  const id = typeof request?.id === 'string' ? request.id : '';
  const action = typeof request?.action === 'string' ? request.action : '';
  if (!id || !action || !port) return;
  try {
    const result = await dispatch(action, readRecord(request.payload));
    port.postMessage({ type: 'response', id, ok: true, result });
    if (result?.bytes instanceof Uint8Array) result.bytes.fill(0);
    if (['setup', 'completeSetup', 'resetProvisioning', 'unlockPin', 'unlockRecovery', 'unlockEmergency', 'updateSecurityPolicy', 'lock'].includes(action)) {
      port.postMessage({ type: 'event', event: 'status', data: vault.status() });
      emitParentStatus('status', vault.status());
    }
  } catch (error) {
    if (!(error instanceof SafeVaultError)) {
      console.error(`[Monarch Safe runtime] ${error?.name || 'Error'}: ${error?.message || 'unexpected failure'}`);
    }
    const normalized = normalizeError(error);
    port.postMessage({ type: 'response', id, ok: false, error: normalized });
    if (['vault-wiped', 'invalid-pin', 'invalid-emergency-phrase', 'emergency-attempt-used'].includes(normalized.code)) {
      const status = vault.status();
      port.postMessage({ type: 'event', event: 'status', data: status });
      emitParentStatus('status', status);
    }
  }
}

async function handleServiceRequest(request) {
  const id = typeof request?.id === 'string' ? request.id : '';
  const action = typeof request?.action === 'string' ? request.action : '';
  if (!id || !action) return;
  try {
    const result = await dispatchService(action, readRecord(request.payload));
    process.parentPort?.postMessage({ type: 'service-response', id, ok: true, result });
  } catch (error) {
    process.parentPort?.postMessage({ type: 'service-response', id, ok: false, error: normalizeError(error) });
  }
}

function dispatchService(action, payload) {
  if (!vault) throw new SafeVaultError('runtime-not-ready', 'Safe runtime is not ready.');
  switch (action) {
  case 'chatStatus': return Promise.resolve(vault.status());
  case 'chatList': return Promise.resolve({ chats: vault.listChats() });
  case 'chatRead': return vault.readChat(payload);
  case 'chatUpsert': return vault.upsertChat(payload);
  case 'chatDelete': return vault.deleteChat(payload);
  case 'chatLock': {
    const status = vault.lock();
    if (activePort) activePort.postMessage({ type: 'event', event: 'status', data: status });
    emitParentStatus('status', status);
    return Promise.resolve(status);
  }
  default: throw new SafeVaultError('unsupported-service-action', 'Safe runtime rejected an unsupported chat service action.');
  }
}

function emitParentStatus(event, data) {
  if (!data) return;
  process.parentPort?.postMessage({ type: 'service-event', event, data });
}

function dispatch(action, payload) {
  if (!vault) throw new SafeVaultError('runtime-not-ready', 'Safe runtime is not ready.');
  switch (action) {
  case 'status': return Promise.resolve(vault.status());
  case 'touch': return vault.touch();
  case 'setup': return vault.setup(payload);
  case 'completeSetup': return vault.completeSetup(payload);
  case 'resetProvisioning': return vault.resetProvisioning();
  case 'unlockPin': return vault.unlockWithPin(String(payload.pin || ''));
  case 'unlockRecovery': return vault.unlockWithRecoveryKey(String(payload.key || ''));
  case 'unlockEmergency': return vault.unlockWithEmergencyPhrase(String(payload.phrase || ''));
  case 'updateSecurityPolicy': return vault.updateSecurityPolicy(payload);
  case 'lock': return Promise.resolve(vault.lock());
  case 'list': return Promise.resolve(vault.list());
  case 'createSection': return vault.createSection(payload);
  case 'updateSection': return vault.updateSection(payload);
  case 'deleteSection': return vault.deleteSection(payload);
  case 'createFolder': return vault.createFolder(payload);
  case 'updateFolder': return vault.updateFolder(payload);
  case 'deleteFolder': return vault.deleteFolder(payload);
  case 'createFile': return vault.createFile(payload);
  case 'importFile': return vault.importFile(payload);
  case 'readFile': return vault.readFile(payload);
  case 'writeFile':
    if (!verifySafeCapabilityToken({ token: payload.capabilityToken, key: capabilityKey, action: 'writeFile', resourceId: String(payload.id || ''), usedNonces: usedCapabilityNonces })) {
      throw new SafeVaultError('mutation-authorization-required', 'A fresh native confirmation is required before replacing an active file generation.');
    }
    return vault.writeFile(payload);
  case 'deleteFile':
    if (!verifySafeCapabilityToken({ token: payload.capabilityToken, key: capabilityKey, action: 'deleteFile', resourceId: String(payload.id || ''), usedNonces: usedCapabilityNonces })) {
      throw new SafeVaultError('destructive-authorization-required', 'A fresh native confirmation is required for file deletion.');
    }
    return vault.deleteFile(payload);
  case 'createArchive': return vault.createArchive(payload);
  case 'extractArchive': return vault.extractArchive(payload);
  default: throw new SafeVaultError('unsupported-action', 'Safe runtime rejected an unsupported action.');
  }
}

function readRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeError(error) {
  if (error instanceof SafeVaultError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: 'safe-internal-error', message: 'Monarch Safe rejected the operation.' };
}
