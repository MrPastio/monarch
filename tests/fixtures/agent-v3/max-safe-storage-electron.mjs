import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { build } from 'esbuild';
import { loadAstraMaxHost } from '../../../desktop/electron/astra-max-host-loader.mjs';

const allowedParent = path.resolve('E:\\MonarchRuntimeTests');
const root = process.argv[2] ? path.resolve(process.argv[2]) : '';
const boundary = allowedParent.toLowerCase() + path.sep;
if (!root || !root.toLowerCase().startsWith(boundary)
  || !/^astra-max-safe-storage-[a-z0-9-]{8,80}$/u.test(path.basename(root))) {
  throw new Error('max-safe-storage-fixture:root-scope');
}
await mkdir(root, { recursive: false, mode: 0o700 });
if ((await realpath(root)).toLowerCase() !== root.toLowerCase()) throw new Error('max-safe-storage-fixture:root-identity');
const profile = path.join(root, 'electron-profile');
const versionRoot = path.join(root, 'version');
const dataRoot = path.join(root, 'data');
await Promise.all([mkdir(profile), mkdir(path.join(versionRoot, 'dist'), { recursive: true }), mkdir(dataRoot)]);
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');

const bundle = path.join(versionRoot, 'dist', 'astra-max-electron.mjs');
await build({ entryPoints: [path.resolve('src/agent-v3/max-electron-entry.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning' });

async function run() {
  let exitCode = 1;
  try {
    if (process.platform !== 'win32' || !safeStorage.isEncryptionAvailable()) {
      throw new Error('max-safe-storage-fixture:windows-encryption-unavailable');
    }
    const acceptedAt = new Date().toISOString();
    const apiKey = 'gsk_live_fixture_only_' + randomUUID().replaceAll('-', '');
    const first = await loadAstraMaxHost({ deployment: 'isolated-validation', versionRoot, dataRoot, safeStorage });
    const before = await first.setupView();
    const saved = await first.configure({ apiKey, consent: {
      agreementVersion: 'monarch.astra-max.groq-consent.2026-09-04.v1', providerId: 'groq', acceptedAt,
      nonLocalProcessingAcknowledged: true, selectedContextAcknowledged: true, providerTermsAcknowledged: true,
    } });
    const reopenedHost = await loadAstraMaxHost({ deployment: 'isolated-validation', versionRoot, dataRoot, safeStorage });
    const reopened = await reopenedHost.setupView();
    const encrypted = await readFile(path.join(dataRoot, 'integrations', 'astra-max', 'groq-max.safe'));
    if (before.state !== 'not-configured' || saved.state !== 'ready' || reopened.state !== 'ready'
      || encrypted.includes(Buffer.from(apiKey, 'utf8'))) throw new Error('max-safe-storage-fixture:acceptance');
    const proof = {
      schemaVersion: 'monarch.astra-max.safe-storage-acceptance.v2', platform: process.platform,
      loader: 'exact-version-bundle', encryptionAvailable: true,
      storageBackend: typeof safeStorage.getSelectedStorageBackend === 'function'
        ? safeStorage.getSelectedStorageBackend() : 'windows-protected-storage',
      beforeState: before.state, savedState: saved.state, reopenedState: reopened.state,
      protectedRecordReopened: reopened.state === 'ready',
      plaintextAbsentFromProtectedFile: !encrypted.includes(Buffer.from(apiKey, 'utf8')),
      protectedBytes: encrypted.byteLength, bundleBytes: (await readFile(bundle)).byteLength, root,
    };
    await writeFile(path.join(root, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    exitCode = 0;
  } catch (error) {
    const raw = error instanceof Error ? error.message : '';
    const code = /^(?:max-safe-storage-fixture|astra-max-(?:settings|loader)):[a-z0-9-]{1,96}$/u.test(raw)
      ? raw : 'max-safe-storage-fixture:unexpected';
    const failure = { schemaVersion: 'monarch.astra-max.safe-storage-failure.v1', code };
    await writeFile(path.join(root, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
    process.stderr.write(`${JSON.stringify(failure)}\n`);
  } finally { app.exit(exitCode); }
}

void app.whenReady().then(run);
