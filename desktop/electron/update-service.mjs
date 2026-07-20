import { EventEmitter } from 'node:events';
import { createHash, verify as verifySignature } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const UPDATE_STATES = Object.freeze([
  'idle',
  'checking',
  'verifying-manifest',
  'up-to-date',
  'update-available',
  'downloading',
  'paused',
  'verifying-installer',
  'ready-to-install',
  'waiting-for-tasks',
  'installing',
  'restart-pending',
  'completed',
  'cancelled',
  'failed',
]);

const CANCELLABLE_STATES = new Set([
  'checking',
  'verifying-manifest',
  'downloading',
  'paused',
  'ready-to-install',
  'waiting-for-tasks',
]);
const DOWNLOAD_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'application/x-msdownload',
  'application/vnd.microsoft.portable-executable',
]);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_RETENTION_MS = 7 * ONE_DAY_MS;
const DEFAULT_MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STALL_TIMEOUT_MS = 120_000;

export class UpdateServiceError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UpdateServiceError';
    this.code = code;
  }
}

export class MonarchUpdateService extends EventEmitter {
  constructor({
    currentVersion,
    updaterVersion = currentVersion,
    launcherVersion = '1.0.0',
    endpoints,
    publicKeys,
    updateRoot,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    launchInstaller,
    maxInstallerBytes = DEFAULT_MAX_INSTALLER_BYTES,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    diskReserveBytes = 256 * 1024 * 1024,
  }) {
    super();
    if (!parseSemver(currentVersion)) {
      throw new UpdateServiceError('invalid-current-version', 'Current Monarch version is not valid semver.');
    }
    if (!parseSemver(updaterVersion)) {
      throw new UpdateServiceError('invalid-updater-version', 'Current updater version is not valid semver.');
    }
    if (!parseSemver(launcherVersion)) {
      throw new UpdateServiceError('invalid-launcher-version', 'Current launcher version is not valid semver.');
    }
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new UpdateServiceError('missing-endpoints', 'At least one trusted update endpoint is required.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new UpdateServiceError('missing-fetch', 'UpdateService requires a fetch implementation.');
    }
    if (!path.isAbsolute(updateRoot)) {
      throw new UpdateServiceError('invalid-update-root', 'Update cache path must be absolute.');
    }

    this.currentVersion = currentVersion;
    this.updaterVersion = updaterVersion;
    this.launcherVersion = launcherVersion;
    this.endpoints = endpoints.map(normalizeEndpoint);
    this.publicKeys = new Map(Object.entries(publicKeys || {}));
    this.updateRoot = path.resolve(updateRoot);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.launchInstaller = launchInstaller;
    this.maxInstallerBytes = maxInstallerBytes;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.diskReserveBytes = diskReserveBytes;

    this.statePath = path.join(this.updateRoot, 'update-state.json');
    this.checkpointPath = path.join(this.updateRoot, 'download-checkpoint.json');
    this.state = 'idle';
    this.release = null;
    this.manifestBytes = null;
    this.manifestDigest = null;
    this.progress = null;
    this.reason = null;
    this.error = null;
    this.sourceStatus = [];
    this.highestAcceptedSequence = 0;
    this.highestAcceptedVersion = null;
    this.highestAcceptedManifestDigest = null;
    this.activeAbortController = null;
    this.activeOperation = null;
    this.stopIntent = null;
    this.readyInstallerPath = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return this.snapshot();
    await mkdir(this.updateRoot, { recursive: true });
    const persisted = await readJsonIfExists(this.statePath);
    if (persisted?.schemaVersion === 1) {
      this.highestAcceptedSequence = safeInteger(persisted.highestAcceptedSequence, 0);
      this.highestAcceptedVersion = parseSemver(persisted.highestAcceptedVersion)
        ? persisted.highestAcceptedVersion
        : null;
      this.highestAcceptedManifestDigest = /^[a-f0-9]{64}$/.test(
        String(persisted.highestAcceptedManifestDigest || ''),
      )
        ? persisted.highestAcceptedManifestDigest
        : null;
    }
    this.initialized = true;
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      state: this.state,
      currentVersion: this.currentVersion,
      release: this.release ? Object.freeze({
        version: this.release.version,
        publishedAt: this.release.publishedAt,
        expiresAt: this.release.expiresAt,
        releaseNotesUrl: this.release.releaseNotesUrl,
        size: this.release.asset?.size ?? null,
        sha256: this.release.asset?.sha256 ?? null,
        fileName: this.release.asset?.fileName ?? null,
        sequence: this.release.sequence,
        source: this.release.source,
        revoked: this.release.revokedVersions.includes(this.currentVersion),
      }) : null,
      progress: this.progress ? Object.freeze({ ...this.progress }) : null,
      reason: this.reason,
      error: this.error ? Object.freeze({ ...this.error }) : null,
      sources: Object.freeze(this.sourceStatus.map((entry) => Object.freeze({ ...entry }))),
      canPause: this.state === 'downloading',
      canResume: this.state === 'paused',
      canCancel: CANCELLABLE_STATES.has(this.state),
      canDiscard: ['paused', 'cancelled', 'failed', 'ready-to-install'].includes(this.state),
    });
  }

  async check() {
    return this.#runExclusive('check', async () => {
      await this.initialize();
      this.stopIntent = null;
      this.#transition('checking', {
        release: null,
        manifestBytes: null,
        manifestDigest: null,
        readyInstallerPath: null,
        progress: null,
        reason: null,
        error: null,
        sourceStatus: [],
      });

      const controller = new AbortController();
      this.activeAbortController = controller;
      try {
        const settled = await Promise.all(this.endpoints.map(async (endpoint) => {
          try {
            const candidate = await this.#fetchCandidate(endpoint, controller.signal);
            return { endpoint, candidate };
          } catch (error) {
            return { endpoint, error: normalizeError(error) };
          }
        }));

        if (this.stopIntent) return this.#finishStoppedOperation();
        this.#transition('verifying-manifest');

        const valid = [];
        const sourceStatus = [];
        for (const result of settled) {
          if (result.candidate) {
            valid.push(result.candidate);
            sourceStatus.push({
              id: result.endpoint.id,
              status: 'valid',
              sequence: result.candidate.manifest.sequence,
            });
          } else {
            sourceStatus.push({
              id: result.endpoint.id,
              status: result.error.code,
            });
          }
        }
        this.sourceStatus = sourceStatus;
        if (valid.length === 0) {
          throw new UpdateServiceError('no-valid-manifest', 'No trusted update manifest is available.');
        }

        valid.sort((left, right) => {
          const sequenceDelta = right.manifest.sequence - left.manifest.sequence;
          if (sequenceDelta !== 0) return sequenceDelta;
          return endpointRank(left.endpoint) - endpointRank(right.endpoint);
        });
        const selected = valid[0];
        if (selected.manifest.sequence < this.highestAcceptedSequence) {
          throw new UpdateServiceError('manifest-replay', 'The newest valid manifest is older than the accepted update state.');
        }
        if (
          this.highestAcceptedVersion
          && selected.manifest.available
          && compareSemver(selected.manifest.version, this.highestAcceptedVersion) < 0
        ) {
          throw new UpdateServiceError('manifest-version-replay', 'Manifest version is older than the accepted release state.');
        }
        const selectedDigest = sha256(selected.bytes);
        if (
          selected.manifest.sequence === this.highestAcceptedSequence
          && this.highestAcceptedManifestDigest
          && selectedDigest !== this.highestAcceptedManifestDigest
        ) {
          throw new UpdateServiceError(
            'manifest-sequence-conflict',
            'A signed manifest reused an accepted sequence with different bytes.',
          );
        }

        this.release = Object.freeze({ ...selected.manifest, source: selected.endpoint.id });
        this.manifestBytes = selected.bytes;
        this.manifestDigest = selectedDigest;
        this.highestAcceptedSequence = Math.max(
          this.highestAcceptedSequence,
          selected.manifest.sequence,
        );
        this.highestAcceptedManifestDigest = selectedDigest;
        if (
          !this.highestAcceptedVersion
          || compareSemver(selected.manifest.version, this.highestAcceptedVersion) > 0
        ) {
          this.highestAcceptedVersion = selected.manifest.version;
        }
        await this.#persistAcceptedState();

        this.sourceStatus = sourceStatus.map((entry) => {
          if (
            entry.status === 'valid'
            && Number.isSafeInteger(entry.sequence)
            && entry.sequence < selected.manifest.sequence
          ) {
            return { ...entry, status: 'stale-mirror' };
          }
          return entry;
        });

        if (!selected.manifest.available) {
          return this.#transition('up-to-date', {
            reason: selected.manifest.withdrawnReason || 'release-withdrawn',
          });
        }
        if (compareSemver(this.updaterVersion, selected.manifest.minimumUpdaterVersion) < 0) {
          return this.#transition('failed', {
            reason: 'updater-version-unsupported',
            error: {
              code: 'updater-version-unsupported',
              message: 'This release requires a newer Monarch updater.',
            },
          });
        }
        if (compareSemver(this.launcherVersion, selected.manifest.minimumLauncherVersion) < 0) {
          return this.#transition('failed', {
            reason: 'launcher-version-unsupported',
            error: {
              code: 'launcher-version-unsupported',
              message: 'This release requires a newer Monarch bootstrap installer.',
            },
          });
        }
        if (compareSemver(selected.manifest.version, this.currentVersion) <= 0) {
          return this.#transition('up-to-date', {
            reason: selected.manifest.revokedVersions.includes(this.currentVersion)
              ? 'current-version-revoked'
              : 'latest-version-installed',
          });
        }
        return this.#transition('update-available');
      } catch (error) {
        if (this.stopIntent || error?.name === 'AbortError') {
          return this.#finishStoppedOperation();
        }
        return this.#fail(error);
      } finally {
        if (this.activeAbortController === controller) this.activeAbortController = null;
      }
    });
  }

  async download() {
    return this.#runExclusive('download', async () => this.#downloadImpl(false));
  }

  pause() {
    if (this.state !== 'downloading') return this.#invalidIntent('pause');
    this.stopIntent = 'pause';
    this.activeAbortController?.abort();
    return this.snapshot();
  }

  async resume() {
    if (this.state !== 'paused' && this.state !== 'cancelled') {
      return this.#invalidIntent('resume');
    }
    if (this.state === 'cancelled' && this.readyInstallerPath) {
      return this.#transition('ready-to-install', {
        reason: null,
        error: null,
      });
    }
    return this.#runExclusive('resume', async () => this.#downloadImpl(true));
  }

  cancel() {
    if (!CANCELLABLE_STATES.has(this.state)) return this.#invalidIntent('cancel');
    this.stopIntent = 'cancel';
    if (this.state === 'paused' || this.state === 'ready-to-install') {
      return this.#transition('cancelled', { reason: 'cancelled-by-user' });
    }
    this.activeAbortController?.abort();
    return this.snapshot();
  }

  async discard() {
    await this.initialize();
    if (!['paused', 'cancelled', 'failed', 'ready-to-install'].includes(this.state)) {
      return this.#invalidIntent('discard');
    }
    const checkpoint = await readJsonIfExists(this.checkpointPath);
    await Promise.all([
      removeIfExists(this.checkpointPath),
      checkpoint?.partialPath && isPathInside(this.updateRoot, checkpoint.partialPath)
        ? removeIfExists(checkpoint.partialPath)
        : Promise.resolve(),
      this.readyInstallerPath && isPathInside(this.updateRoot, this.readyInstallerPath)
        ? removeIfExists(this.readyInstallerPath)
        : Promise.resolve(),
    ]);
    this.readyInstallerPath = null;
    this.progress = null;
    return this.#transition('idle', { reason: 'download-discarded', error: null });
  }

  async install() {
    if (this.state === 'update-available') {
      await this.download();
    } else if (this.state === 'paused' || this.state === 'cancelled') {
      await this.resume();
    }
    if (this.state !== 'ready-to-install' || !this.readyInstallerPath || !this.release) {
      return this.#invalidIntent('install');
    }
    return this.#runExclusive('install', async () => {
      if (typeof this.launchInstaller !== 'function') {
        return this.#fail(new UpdateServiceError(
          'installer-coordinator-unavailable',
          'The trusted installer coordinator is not configured.',
        ));
      }

      const controller = new AbortController();
      this.activeAbortController = controller;
      this.stopIntent = null;
      try {
        this.#transition('waiting-for-tasks');
        const launchResult = await this.launchInstaller({
          installerPath: this.readyInstallerPath,
          manifest: this.release,
          signal: controller.signal,
          beginInstallation: () => {
            if (controller.signal.aborted || this.stopIntent === 'cancel') {
              throw abortError();
            }
            this.activeAbortController = null;
            this.stopIntent = null;
            this.#transition('installing');
          },
        });
        if (controller.signal.aborted || this.stopIntent) return this.#finishStoppedOperation();
        if (launchResult?.cancelled) {
          return this.#transition('cancelled', {
            reason: launchResult.reason || 'installation-cancelled',
          });
        }
        if (this.state !== 'installing') this.#transition('installing');
        return this.#transition('restart-pending');
      } catch (error) {
        if (controller.signal.aborted || this.stopIntent || error?.name === 'AbortError') {
          return this.#finishStoppedOperation();
        }
        return this.#fail(error);
      } finally {
        if (this.activeAbortController === controller) this.activeAbortController = null;
      }
    });
  }

  async #downloadImpl(allowResume) {
    await this.initialize();
    if (!this.release?.asset || !this.manifestDigest) {
      return this.#invalidIntent(allowResume ? 'resume' : 'download');
    }
    if (!allowResume && this.state !== 'update-available') {
      return this.#invalidIntent('download');
    }

    this.stopIntent = null;
    const controller = new AbortController();
    this.activeAbortController = controller;
    const safeName = readSafeInstallerName(this.release.asset.fileName);
    const partialPath = path.join(this.updateRoot, `${safeName}.partial`);
    const installerPath = path.join(this.updateRoot, safeName);
    let responseEtag = null;

    try {
      await this.#assertDiskSpace(this.release.asset.size);
      let offset = 0;
      let checkpoint = allowResume ? await readJsonIfExists(this.checkpointPath) : null;
      if (
        checkpoint?.schemaVersion === 1
        && checkpoint.manifestDigest === this.manifestDigest
        && checkpoint.expectedSize === this.release.asset.size
        && checkpoint.partialPath === partialPath
        && checkpointIsFresh(checkpoint, this.now())
      ) {
        const partialStat = await stat(partialPath).catch(() => null);
        if (partialStat?.isFile() && partialStat.size === checkpoint.downloaded) {
          offset = checkpoint.downloaded;
        } else {
          checkpoint = null;
        }
      } else {
        checkpoint = null;
      }
      if (!checkpoint) {
        await removeIfExists(partialPath);
        await removeIfExists(this.checkpointPath);
        offset = 0;
      }

      this.#transition('downloading', {
        progress: downloadProgress(offset, this.release.asset.size),
        reason: null,
        error: null,
      });

      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      let response = await this.#fetchWithRedirects(this.release.asset.url, {
        signal: controller.signal,
        headers,
        kind: 'asset',
      });
      let etag = response.headers.get('etag');
      responseEtag = etag;

      if (offset > 0) {
        const contentRange = parseContentRange(response.headers.get('content-range'));
        const resumeIsValid = response.status === 206
          && contentRange?.start === offset
          && contentRange.total === this.release.asset.size
          && Boolean(checkpoint?.etag)
          && etag === checkpoint.etag;
        if (!resumeIsValid) {
          await response.body?.cancel().catch(() => undefined);
          await removeIfExists(partialPath);
          await removeIfExists(this.checkpointPath);
          offset = 0;
          checkpoint = null;
          response = await this.#fetchWithRedirects(this.release.asset.url, {
            signal: controller.signal,
            kind: 'asset',
          });
          etag = response.headers.get('etag');
          responseEtag = etag;
        }
      }

      if ((offset === 0 && response.status !== 200) || (offset > 0 && response.status !== 206)) {
        throw new UpdateServiceError('download-http-error', `Installer returned HTTP ${response.status}.`);
      }
      const contentType = String(response.headers.get('content-type') || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (contentType && !DOWNLOAD_CONTENT_TYPES.has(contentType)) {
        throw new UpdateServiceError('invalid-installer-content-type', 'Installer response has an unsafe content type.');
      }
      const remainingLength = readContentLength(response.headers.get('content-length'));
      if (
        remainingLength !== null
        && remainingLength !== this.release.asset.size - offset
      ) {
        throw new UpdateServiceError('installer-size-mismatch', 'Installer response size does not match the signed manifest.');
      }
      if (!response.body) {
        throw new UpdateServiceError('empty-installer-response', 'Installer response has no body.');
      }

      const file = await open(partialPath, offset > 0 ? 'a' : 'w');
      const reader = response.body.getReader();
      let downloaded = offset;
      let lastCheckpointAt = this.now();
      let checkpointBytes = offset;
      try {
        while (true) {
          const result = await readStreamChunk(reader, this.stallTimeoutMs);
          if (result.done) break;
          const chunkValue = result.value;
          if (this.stopIntent) throw abortError();
          const chunk = Buffer.from(chunkValue);
          downloaded += chunk.length;
          if (downloaded > this.release.asset.size || downloaded > this.maxInstallerBytes) {
            throw new UpdateServiceError('installer-too-large', 'Installer exceeded its signed maximum size.');
          }
          await file.write(chunk);
          this.progress = downloadProgress(downloaded, this.release.asset.size);
          this.#emitState();
          if (
            downloaded - checkpointBytes >= 1024 * 1024
            || this.now() - lastCheckpointAt >= 2_000
          ) {
            await this.#writeCheckpoint({
              manifestDigest: this.manifestDigest,
              partialPath,
              expectedSize: this.release.asset.size,
              downloaded,
              etag,
            });
            checkpointBytes = downloaded;
            lastCheckpointAt = this.now();
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        await file.close();
      }

      await this.#writeCheckpoint({
        manifestDigest: this.manifestDigest,
        partialPath,
        expectedSize: this.release.asset.size,
        downloaded,
        etag,
      });
      if (downloaded !== this.release.asset.size) {
        throw new UpdateServiceError('installer-size-mismatch', 'Downloaded installer is incomplete.');
      }

      this.#transition('verifying-installer');
      await verifyInstallerFile(partialPath, this.release.asset, this.maxInstallerBytes);
      await removeIfExists(installerPath);
      await rename(partialPath, installerPath);
      await removeIfExists(this.checkpointPath);
      this.readyInstallerPath = installerPath;
      return this.#transition('ready-to-install', {
        progress: downloadProgress(this.release.asset.size, this.release.asset.size),
      });
    } catch (error) {
      if (this.stopIntent) {
        const partialStat = await stat(partialPath).catch(() => null);
        if (partialStat?.isFile()) {
          const existing = await readJsonIfExists(this.checkpointPath);
          await this.#writeCheckpoint({
            manifestDigest: this.manifestDigest,
            partialPath,
            expectedSize: this.release.asset.size,
            downloaded: partialStat.size,
            etag: responseEtag || existing?.etag || null,
          });
        }
        return this.#finishStoppedOperation();
      }
      if (error?.name === 'AbortError') {
        return this.#fail(new UpdateServiceError('network-error', 'Installer download was interrupted.', error));
      }
      if ([
        'installer-size-mismatch',
        'installer-hash-mismatch',
        'invalid-installer-format',
        'installer-too-large',
      ].includes(error?.code)) {
        await Promise.all([
          removeIfExists(partialPath),
          removeIfExists(this.checkpointPath),
        ]);
      }
      return this.#fail(error);
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = null;
    }
  }

  async #fetchCandidate(endpoint, signal) {
    const [manifestResponse, signatureResponse] = await Promise.all([
      this.#fetchWithRedirects(endpoint.manifestUrl, { signal, kind: 'metadata', endpoint }),
      this.#fetchWithRedirects(endpoint.signatureUrl, { signal, kind: 'metadata', endpoint }),
    ]);
    if (!manifestResponse.ok || !signatureResponse.ok) {
      throw new UpdateServiceError(
        'manifest-http-error',
        `Update metadata returned HTTP ${manifestResponse.status}/${signatureResponse.status}.`,
      );
    }
    const manifestBytes = await readBoundedResponse(manifestResponse, 1024 * 1024, 'manifest-too-large');
    const signatureBytes = await readBoundedResponse(signatureResponse, 16 * 1024, 'signature-too-large');
    const manifest = verifySignedManifest({
      bytes: manifestBytes,
      signatureBytes,
      publicKeys: this.publicKeys,
      now: this.now(),
      expectedChannel: 'stable',
      maxInstallerBytes: this.maxInstallerBytes,
    });
    return { endpoint, manifest, bytes: manifestBytes };
  }

  async #fetchWithRedirects(urlValue, { signal, headers = {}, kind, endpoint }) {
    let currentUrl = new URL(urlValue);
    const initialUrl = new URL(urlValue);
    let redirects = 0;
    while (true) {
      const timeoutController = new AbortController();
      const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
      const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
      let response;
      try {
        response = await this.fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers,
          signal: combinedSignal,
        });
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (timeoutController.signal.aborted) {
          throw new UpdateServiceError('request-timeout', 'Update request timed out.', error);
        }
        throw new UpdateServiceError('network-error', 'Update request failed.', error);
      } finally {
        clearTimeout(timeout);
      }

      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects >= 3) {
        throw new UpdateServiceError('too-many-redirects', 'Update request exceeded the redirect limit.');
      }
      const location = response.headers.get('location');
      if (!location) throw new UpdateServiceError('invalid-redirect', 'Update redirect is missing a location.');
      const nextUrl = new URL(location, currentUrl);
      const allowed = kind === 'asset'
        ? isAllowedAssetRedirect(initialUrl, currentUrl, nextUrl)
        : isAllowedMetadataRedirect(initialUrl, currentUrl, nextUrl, endpoint);
      if (!allowed) {
        throw new UpdateServiceError('unsafe-redirect', 'Update request was redirected to an untrusted origin.');
      }
      currentUrl = nextUrl;
      redirects += 1;
    }
  }

  async #assertDiskSpace(assetSize) {
    const available = await statfs(this.updateRoot).then(
      (value) => Number(value.bavail) * Number(value.bsize),
      () => null,
    );
    if (available !== null && available < assetSize + this.diskReserveBytes) {
      throw new UpdateServiceError('insufficient-disk-space', 'Not enough free space for the update.');
    }
  }

  async #writeCheckpoint(value) {
    await atomicWriteJson(this.checkpointPath, {
      schemaVersion: 1,
      ...value,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  async #persistAcceptedState() {
    await atomicWriteJson(this.statePath, {
      schemaVersion: 1,
      highestAcceptedSequence: this.highestAcceptedSequence,
      highestAcceptedVersion: this.highestAcceptedVersion,
      highestAcceptedManifestDigest: this.highestAcceptedManifestDigest,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  #runExclusive(name, operation) {
    if (this.activeOperation) {
      return Promise.resolve(this.#invalidIntent(name, 'operation-in-progress'));
    }
    const active = Promise.resolve().then(operation);
    this.activeOperation = active;
    return active.finally(() => {
      if (this.activeOperation === active) this.activeOperation = null;
    });
  }

  #finishStoppedOperation() {
    const intent = this.stopIntent;
    this.stopIntent = null;
    return this.#transition(intent === 'pause' ? 'paused' : 'cancelled', {
      reason: intent === 'pause' ? 'paused-by-user' : 'cancelled-by-user',
      error: null,
    });
  }

  #invalidIntent(intent, code = 'invalid-update-state') {
    return Object.freeze({
      ...this.snapshot(),
      intentError: Object.freeze({ code, intent, state: this.state }),
    });
  }

  #fail(error) {
    const normalized = normalizeError(error);
    return this.#transition('failed', {
      error: normalized,
      reason: normalized.code,
    });
  }

  #transition(state, patch = {}) {
    if (!UPDATE_STATES.includes(state)) {
      throw new UpdateServiceError('invalid-update-state', `Unknown update state: ${state}`);
    }
    this.state = state;
    for (const [key, value] of Object.entries(patch)) this[key] = value;
    return this.#emitState();
  }

  #emitState() {
    const snapshot = this.snapshot();
    this.emit('state', snapshot);
    return snapshot;
  }
}

export function verifySignedManifest({
  bytes,
  signatureBytes,
  publicKeys,
  now = Date.now(),
  expectedChannel = 'stable',
  maxInstallerBytes = DEFAULT_MAX_INSTALLER_BYTES,
}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const untrusted = parseJson(bytes, 'invalid-manifest-json');
  const keyId = readBoundedString(untrusted?.keyId, 'keyId', 96);
  const publicKey = publicKeys instanceof Map ? publicKeys.get(keyId) : publicKeys?.[keyId];
  if (!publicKey) throw new UpdateServiceError('unknown-signing-key', 'Manifest uses an unknown signing key.');
  const signature = decodeSignature(signatureBytes);
  let valid = false;
  try {
    valid = verifySignature(null, bytes, publicKey, signature);
  } catch (error) {
    throw new UpdateServiceError('invalid-signature', 'Manifest signature could not be verified.', error);
  }
  if (!valid) throw new UpdateServiceError('invalid-signature', 'Manifest signature is invalid.');
  return validateManifest(untrusted, { now, expectedChannel, maxInstallerBytes });
}

export async function verifyInstallerFile(filePath, asset, maxInstallerBytes = DEFAULT_MAX_INSTALLER_BYTES) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size !== asset.size || fileStat.size > maxInstallerBytes) {
    throw new UpdateServiceError('installer-size-mismatch', 'Installer size does not match the signed manifest.');
  }
  const handle = await open(filePath, 'r');
  try {
    const magic = Buffer.alloc(2);
    const { bytesRead } = await handle.read(magic, 0, 2, 0);
    if (bytesRead !== 2 || magic.toString('ascii') !== 'MZ') {
      throw new UpdateServiceError('invalid-installer-format', 'Downloaded file is not a Windows executable.');
    }
  } finally {
    await handle.close();
  }
  const digest = createHash('sha256');
  const input = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < fileStat.size) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await input.close();
  }
  if (digest.digest('hex') !== asset.sha256) {
    throw new UpdateServiceError('installer-hash-mismatch', 'Installer SHA-256 does not match the signed manifest.');
  }
  return true;
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new UpdateServiceError('invalid-semver', 'Version is not valid stable semver.');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function isAllowedAssetRedirect(initialUrl, currentUrl, nextUrl) {
  if (nextUrl.protocol !== 'https:') return false;
  if (nextUrl.origin === currentUrl.origin) return true;
  if (
    initialUrl.hostname === 'github.com'
    && /^\/MrPastio\/monarch-releases\/releases\/download\//.test(initialUrl.pathname)
  ) {
    return [
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
      'github-releases.githubusercontent.com',
    ].includes(nextUrl.hostname);
  }
  return false;
}

function normalizeEndpoint(value) {
  const id = readBoundedString(value?.id, 'endpoint.id', 32);
  if (!['github', 'sites'].includes(id)) {
    throw new UpdateServiceError('invalid-endpoint', 'Update endpoint must be github or sites.');
  }
  const manifestUrl = readHttpsUrl(value?.manifestUrl, 'endpoint.manifestUrl');
  const signatureUrl = readHttpsUrl(value?.signatureUrl, 'endpoint.signatureUrl');
  return Object.freeze({ id, manifestUrl, signatureUrl });
}

function validateManifest(value, { now, expectedChannel, maxInstallerBytes }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpdateServiceError('invalid-manifest', 'Manifest must be an object.');
  }
  if (value.schemaVersion !== 1) {
    throw new UpdateServiceError('unsupported-manifest-schema', 'Manifest schema is not supported.');
  }
  const sequence = safeInteger(value.sequence, -1);
  if (sequence < 0) throw new UpdateServiceError('invalid-manifest', 'Manifest sequence must not be negative.');
  const channel = readBoundedString(value.channel, 'channel', 32);
  if (channel !== expectedChannel) throw new UpdateServiceError('wrong-channel', 'Manifest channel is not trusted.');
  const version = readBoundedString(value.version, 'version', 64);
  if (!parseSemver(version)) throw new UpdateServiceError('invalid-semver', 'Manifest version is not stable semver.');
  const publishedAt = readIsoDate(value.publishedAt, 'publishedAt');
  const expiresAt = readIsoDate(value.expiresAt, 'expiresAt');
  if (expiresAt.time + ONE_DAY_MS < now) {
    throw new UpdateServiceError('manifest-expired', 'Manifest has expired.');
  }
  if (publishedAt.time - ONE_DAY_MS > now) {
    throw new UpdateServiceError('clock-invalid', 'System clock is too far behind the signed manifest.');
  }
  const minimumUpdaterVersion = readBoundedString(value.minimumUpdaterVersion, 'minimumUpdaterVersion', 64);
  const minimumLauncherVersion = readBoundedString(value.minimumLauncherVersion, 'minimumLauncherVersion', 64);
  if (!parseSemver(minimumUpdaterVersion) || !parseSemver(minimumLauncherVersion)) {
    throw new UpdateServiceError('invalid-manifest', 'Manifest minimum versions are invalid.');
  }
  const available = value.available === true;
  if (value.available !== true && value.available !== false) {
    throw new UpdateServiceError('invalid-manifest', 'Manifest availability must be boolean.');
  }
  const withdrawnReason = value.withdrawnReason === null
    ? null
    : readBoundedString(value.withdrawnReason, 'withdrawnReason', 512);
  const revokedVersions = Array.isArray(value.revokedVersions)
    ? value.revokedVersions.map((entry) => {
      const item = readBoundedString(entry, 'revokedVersions', 64);
      if (!parseSemver(item)) throw new UpdateServiceError('invalid-manifest', 'Revoked version is invalid.');
      return item;
    })
    : null;
  if (!revokedVersions || revokedVersions.length > 128) {
    throw new UpdateServiceError('invalid-manifest', 'Revoked versions list is invalid.');
  }
  const releaseNotesUrl = readHttpsUrl(value.releaseNotesUrl, 'releaseNotesUrl');
  const compatibility = validateCompatibility(value.compatibility);
  const asset = value.asset === null && !available
    ? null
    : validateAsset(value.asset, maxInstallerBytes);
  if (available && !asset) {
    throw new UpdateServiceError('invalid-manifest', 'Available release must include an installer asset.');
  }
  const keyId = readBoundedString(value.keyId, 'keyId', 96);
  return Object.freeze({
    schemaVersion: 1,
    sequence,
    channel,
    version,
    publishedAt: publishedAt.iso,
    expiresAt: expiresAt.iso,
    minimumUpdaterVersion,
    minimumLauncherVersion,
    available,
    withdrawnReason,
    revokedVersions: Object.freeze(revokedVersions),
    releaseNotesUrl,
    compatibility,
    asset,
    keyId,
  });
}

function validateCompatibility(value) {
  if (!value || typeof value !== 'object') {
    throw new UpdateServiceError('invalid-manifest', 'Compatibility descriptor is missing.');
  }
  const result = {
    runtimeVersion: readBoundedString(value.runtimeVersion, 'runtimeVersion', 96),
    backendEnvironment: readBoundedString(value.backendEnvironment, 'backendEnvironment', 96),
    dataSchemaVersion: safeInteger(value.dataSchemaVersion, -1),
    minimumReadableDataSchema: safeInteger(value.minimumReadableDataSchema, -1),
    maximumReadableDataSchema: safeInteger(value.maximumReadableDataSchema, -1),
    minimumModelCatalogSchema: safeInteger(value.minimumModelCatalogSchema, -1),
    maximumModelCatalogSchema: safeInteger(value.maximumModelCatalogSchema, -1),
  };
  if (
    Object.values(result).some((entry) => typeof entry === 'number' && entry < 0)
    || result.minimumReadableDataSchema > result.dataSchemaVersion
    || result.dataSchemaVersion > result.maximumReadableDataSchema
    || result.minimumModelCatalogSchema > result.maximumModelCatalogSchema
  ) {
    throw new UpdateServiceError('invalid-manifest', 'Compatibility ranges are invalid.');
  }
  return Object.freeze(result);
}

function validateAsset(value, maxInstallerBytes) {
  if (!value || typeof value !== 'object') {
    throw new UpdateServiceError('invalid-manifest', 'Installer asset is missing.');
  }
  const url = readHttpsUrl(value.url, 'asset.url');
  const parsedUrl = new URL(url);
  if (
    parsedUrl.hostname !== 'github.com'
    || !/^\/MrPastio\/monarch-releases\/releases\/download\/v[^/]+\//.test(parsedUrl.pathname)
  ) {
    throw new UpdateServiceError('untrusted-asset-origin', 'Installer must use the trusted GitHub release path.');
  }
  const size = safeInteger(value.size, -1);
  if (size < 2 || size > maxInstallerBytes) {
    throw new UpdateServiceError('invalid-manifest', 'Installer size is outside the accepted range.');
  }
  const sha256Value = readBoundedString(value.sha256, 'asset.sha256', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256Value)) {
    throw new UpdateServiceError('invalid-manifest', 'Installer SHA-256 is invalid.');
  }
  const fileName = readSafeInstallerName(value.fileName);
  if (!decodeURIComponent(parsedUrl.pathname).endsWith(`/${fileName}`)) {
    throw new UpdateServiceError('invalid-manifest', 'Installer URL and file name do not match.');
  }
  const mirrors = Array.isArray(value.mirrors) ? value.mirrors : [];
  if (mirrors.length > 4) throw new UpdateServiceError('invalid-manifest', 'Too many installer mirrors.');
  return Object.freeze({
    url,
    mirrors: Object.freeze(mirrors.map((entry) => readHttpsUrl(entry, 'asset.mirrors'))),
    size,
    sha256: sha256Value,
    fileName,
  });
}

function isAllowedMetadataRedirect(initialUrl, currentUrl, nextUrl, endpoint) {
  if (nextUrl.protocol !== 'https:') return false;
  if (nextUrl.origin !== currentUrl.origin) return false;
  if (!endpoint) return nextUrl.origin === initialUrl.origin;
  return nextUrl.origin === new URL(endpoint.manifestUrl).origin
    || nextUrl.origin === new URL(endpoint.signatureUrl).origin;
}

async function readBoundedResponse(response, maxBytes, code) {
  const declared = readContentLength(response.headers.get('content-length'));
  if (declared !== null && declared > maxBytes) {
    throw new UpdateServiceError(code, 'Update metadata response exceeded its size limit.');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new UpdateServiceError(code, 'Update metadata response exceeded its size limit.');
  }
  return buffer;
}

function decodeSignature(value) {
  const text = Buffer.from(value).toString('ascii').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new UpdateServiceError('invalid-signature', 'Manifest signature encoding is invalid.');
  }
  const signature = Buffer.from(text, 'base64');
  if (signature.length !== 64) {
    throw new UpdateServiceError('invalid-signature', 'Manifest signature length is invalid.');
  }
  return signature;
}

function parseSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value || ''));
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function readIsoDate(value, field) {
  const iso = readBoundedString(value, field, 64);
  const time = Date.parse(iso);
  if (
    !Number.isFinite(time)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(iso)
  ) {
    throw new UpdateServiceError('invalid-manifest', `Manifest ${field} is not valid UTC RFC3339.`);
  }
  return { iso, time };
}

function readHttpsUrl(value, field) {
  const text = readBoundedString(value, field, 2048);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new UpdateServiceError('invalid-manifest', `${field} is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new UpdateServiceError('invalid-manifest', `${field} must be an HTTPS URL without credentials.`);
  }
  return parsed.href;
}

function readBoundedString(value, field, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new UpdateServiceError('invalid-manifest', `${field} is invalid.`);
  }
  return value;
}

function readSafeInstallerName(value) {
  const fileName = readBoundedString(value, 'asset.fileName', 160);
  if (
    path.basename(fileName) !== fileName
    || !/^Monarch-Setup-\d+\.\d+\.\d+\.exe$/i.test(fileName)
  ) {
    throw new UpdateServiceError('invalid-manifest', 'Installer file name is unsafe.');
  }
  return fileName;
}

function safeInteger(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function readContentLength(value) {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  const [, start, end, total] = match.map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

function checkpointIsFresh(checkpoint, now) {
  const updatedAt = Date.parse(String(checkpoint?.updatedAt || ''));
  return Number.isFinite(updatedAt)
    && updatedAt <= now + ONE_DAY_MS
    && now - updatedAt <= CHECKPOINT_RETENTION_MS;
}

function endpointRank(endpoint) {
  return endpoint.id === 'github' ? 0 : 1;
}

function downloadProgress(downloaded, total) {
  return Object.freeze({
    downloaded,
    total,
    percent: total > 0 ? Math.min(100, Math.round((downloaded / total) * 10_000) / 100) : 0,
  });
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new UpdateServiceError(code, 'Update metadata is not valid JSON.', error);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeError(error) {
  return Object.freeze({
    code: typeof error?.code === 'string' ? error.code : 'update-error',
    message: error instanceof Error ? error.message : String(error),
  });
}

function abortError() {
  const error = new Error('Update operation was interrupted.');
  error.name = 'AbortError';
  return error;
}

async function readJsonIfExists(filePath) {
  const previousPath = `${filePath}.previous`;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    try {
      return JSON.parse(await readFile(previousPath, 'utf8'));
    } catch (fallbackError) {
      if (fallbackError?.code === 'ENOENT' || fallbackError instanceof SyntaxError) return null;
      throw fallbackError;
    }
  }
}

async function atomicWriteJson(filePath, value) {
  const nextPath = `${filePath}.next`;
  const previousPath = `${filePath}.previous`;
  await writeFile(nextPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await removeIfExists(previousPath);
  try {
    await rename(filePath, previousPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(nextPath, filePath);
    await removeIfExists(previousPath);
  } catch (error) {
    try {
      await rename(previousPath, filePath);
    } catch {
      // readJsonIfExists also accepts the previous sibling after interruption.
    }
    throw error;
  }
}

async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function isPathInside(root, candidate) {
  if (!path.isAbsolute(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readStreamChunk(reader, timeoutMs) {
  let timer;
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new UpdateServiceError('download-stalled', 'Installer download stopped making progress.'));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
