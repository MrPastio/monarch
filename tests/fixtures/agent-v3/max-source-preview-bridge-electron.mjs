import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import {
  ASTRA_MAX_SOURCE_PREVIEW_MODE,
  createAstraMaxDesktopBridge,
} from '../../../desktop/electron/astra-max-desktop-bridge.mjs';

const allowedParent = path.resolve('E:\\MonarchRuntimeTests');
const root = process.argv[2] ? path.resolve(process.argv[2]) : '';
const versionRoot = process.argv[3] ? path.resolve(process.argv[3]) : '';
const boundary = allowedParent.toLowerCase() + path.sep;
if (!root || !root.toLowerCase().startsWith(boundary)
  || path.dirname(root).toLowerCase() !== allowedParent.toLowerCase()) {
  throw Error('max-source-preview-fixture:root');
}
await mkdir(root, { recursive: false, mode: 0o700 });
if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) throw Error('max-source-preview-fixture:root-identity');
const profile = path.join(root, 'electron-profile');
const dataRoot = path.join(root, 'data');
await Promise.all([mkdir(profile), mkdir(dataRoot)]);
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');

async function run() {
  let exitCode = 1;
  let stage = 'ready';
  try {
    if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) {
      throw Error('max-source-preview-fixture:windows-encryption-unavailable');
    }
    const apiKey = 'gsk_source_preview_' + randomUUID().replaceAll('-', '');
    const acceptedClock = Date.now();
    stage = 'create-first-bridge';
    const first = createAstraMaxDesktopBridge({ mode: ASTRA_MAX_SOURCE_PREVIEW_MODE,
      versionRoot, dataRoot, safeStorage, now: () => acceptedClock });
    stage = 'read-before-status';
    const before = await first.status();
    stage = 'configure';
    const saved = await first.configure({ apiKey, acknowledgements: {
      nonLocalProcessing: true, selectedContext: true, providerTerms: true,
    } });
    stage = 'reopen';
    const reopened = await createAstraMaxDesktopBridge({ mode: ASTRA_MAX_SOURCE_PREVIEW_MODE,
      versionRoot, dataRoot, safeStorage, now: () => acceptedClock }).status();
    stage = 'read-protected-record';
    const protectedRecord = await readFile(path.join(dataRoot, 'integrations', 'astra-max', 'groq-max.safe'));
    stage = 'assert';
    if (before.state !== 'not-configured' || saved.state !== 'ready' || reopened.state !== 'ready'
      || protectedRecord.includes(Buffer.from(apiKey, 'utf8'))
      || JSON.stringify({ before, saved, reopened }).includes(apiKey)) {
      throw Error('max-source-preview-fixture:acceptance');
    }
    const proof = {
      schemaVersion: 'monarch.astra-max.source-preview-bridge-acceptance.v1',
      platform: process.platform,
      mode: ASTRA_MAX_SOURCE_PREVIEW_MODE,
      encryptionAvailable: true,
      storageBackend: typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend() : 'windows-protected-storage',
      beforeState: before.state,
      savedState: saved.state,
      reopenedState: reopened.state,
      rendererViewCredentialFree: true,
      plaintextAbsentFromProtectedFile: !protectedRecord.includes(Buffer.from(apiKey, 'utf8')),
      protectedBytes: protectedRecord.byteLength,
      root,
    };
    await writeFile(path.join(root, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    exitCode = 0;
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    const code = /^(?:max-source-preview-fixture|astra-max-(?:desktop|loader|settings)):[a-z0-9-]{1,96}$/u.test(raw)
      ? raw : 'max-source-preview-fixture:unexpected';
    await writeFile(path.join(root, 'failure.json'), `${JSON.stringify({ code, stage }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    process.stderr.write(`${JSON.stringify({ code, stage })}\n`);
  } finally { app.exit(exitCode); }
}

void app.whenReady().then(run);
