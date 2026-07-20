#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  CHANNEL_MANIFEST_LIFETIME_DAYS,
  encodeManifest,
  generateReleaseKeyPair,
  getExpiryStatus,
  parseAndValidateManifestBytes,
  prepareManifest,
  publicKeyFromPrivate,
  refreshManifest,
  resolveKeyringPublicKey,
  sha256File,
  signManifestBytes,
  validateChannelManifest,
  verifyManifestSignature,
} from '../release/lib/channel-manifest.mjs';

function usage() {
  console.error(`Usage:
  node scripts/release-manifest.mjs validate --manifest <path>
  node scripts/release-manifest.mjs generate-key --private-key <path> --public-key <path> --keyring <path> --key-id <id>
  node scripts/release-manifest.mjs sign --manifest <path> --private-key <path> --signature <path> [--expected-key-id <id>]
  node scripts/release-manifest.mjs verify --manifest <path> --signature <path> (--public-key <path> | --keyring <path>) [--expected-key-id <id>]
  node scripts/release-manifest.mjs prepare --spec <path> --installer <path> --output <path> --sequence <n> --published-at <ISO> [--expires-at <ISO>]
  node scripts/release-manifest.mjs refresh --manifest <path> --signature <path> --public-key <path> --private-key <path> --output-manifest <path> --output-signature <path> [--now <ISO>]
  node scripts/release-manifest.mjs expiry-status --manifest <path> [--now <ISO>]
  node scripts/release-manifest.mjs field --manifest <path> --name <sequence|version|keyId>
  node scripts/release-manifest.mjs verify-assets --manifest <path> --signature <path> --public-key <path> --installer <path> [--expected-key-id <id>]
  node scripts/release-manifest.mjs compare-files --expected <path> --actual <path>`);
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (!token?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${token ?? '<end>'}.`);
    }
    if (options.has(token.slice(2))) throw new Error(`Duplicate argument: ${token}`);
    options.set(token.slice(2), value);
  }
  return { command, options };
}

function required(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function assertOnly(options, allowed) {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new Error(`Unsupported option: --${name}`);
  }
}

async function readManifest(manifestPath) {
  const bytes = await readFile(manifestPath);
  return { bytes, manifest: parseAndValidateManifestBytes(bytes) };
}

async function writeExclusive(filePath, bytes) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
}

async function writeOutput(filePath, bytes) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, bytes);
}

async function publicKeyFor(options, manifest) {
  const publicKeyPath = options.get('public-key');
  const keyringPath = options.get('keyring');
  if (Boolean(publicKeyPath) === Boolean(keyringPath)) {
    throw new Error('Specify exactly one of --public-key or --keyring.');
  }
  if (publicKeyPath) return readFile(publicKeyPath, 'utf8');
  const keyring = JSON.parse(await readFile(keyringPath, 'utf8'));
  return resolveKeyringPublicKey(keyring, manifest.keyId);
}

async function verifyAssets({
  manifestPath,
  signaturePath,
  publicKeyPath,
  installerPath,
  expectedKeyId,
}) {
  const bytes = await readFile(manifestPath);
  const manifest = parseAndValidateManifestBytes(bytes);
  const signature = await readFile(signaturePath, 'utf8');
  const publicKey = await readFile(publicKeyPath, 'utf8');
  verifyManifestSignature(bytes, signature, publicKey);
  if (expectedKeyId && manifest.keyId !== expectedKeyId) {
    throw new Error(`Manifest keyId is ${manifest.keyId}, expected ${expectedKeyId}.`);
  }
  if (!manifest.available || !manifest.asset) {
    throw new Error('Cannot verify installer assets for an unavailable manifest.');
  }
  const installer = await stat(installerPath);
  if (installer.size !== manifest.asset.size) {
    throw new Error(`Installer size mismatch: expected ${manifest.asset.size}, received ${installer.size}.`);
  }
  const digest = await sha256File(installerPath);
  if (digest !== manifest.asset.sha256) {
    throw new Error(`Installer SHA-256 mismatch: expected ${manifest.asset.sha256}, received ${digest}.`);
  }
  if (path.basename(installerPath) !== manifest.asset.fileName) {
    throw new Error(`Installer filename must be ${manifest.asset.fileName}.`);
  }
  return manifest;
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  switch (command) {
    case 'validate': {
      assertOnly(options, ['manifest']);
      const { manifest } = await readManifest(required(options, 'manifest'));
      console.log(JSON.stringify({ valid: true, sequence: manifest.sequence, version: manifest.version }));
      return;
    }
    case 'generate-key': {
      assertOnly(options, ['private-key', 'public-key', 'keyring', 'key-id']);
      const generated = generateReleaseKeyPair(required(options, 'key-id'));
      await writeExclusive(required(options, 'private-key'), generated.privateKey);
      await writeExclusive(required(options, 'public-key'), generated.publicKey);
      await writeExclusive(
        required(options, 'keyring'),
        `${JSON.stringify(generated.keyring, null, 2)}\n`,
      );
      console.log(JSON.stringify({ generated: true, keyId: generated.keyId }));
      return;
    }
    case 'sign': {
      assertOnly(options, ['manifest', 'private-key', 'signature', 'expected-key-id']);
      const { bytes, manifest } = await readManifest(required(options, 'manifest'));
      const expectedKeyId = options.get('expected-key-id');
      if (expectedKeyId && manifest.keyId !== expectedKeyId) {
        throw new Error(`Manifest keyId is ${manifest.keyId}, expected ${expectedKeyId}.`);
      }
      const privateKey = await readFile(required(options, 'private-key'), 'utf8');
      const signature = signManifestBytes(bytes, privateKey);
      await writeOutput(required(options, 'signature'), `${signature}\n`);
      console.log(JSON.stringify({ signed: true, keyId: manifest.keyId }));
      return;
    }
    case 'verify': {
      assertOnly(options, ['manifest', 'signature', 'public-key', 'keyring', 'expected-key-id']);
      const { bytes, manifest } = await readManifest(required(options, 'manifest'));
      const signature = await readFile(required(options, 'signature'), 'utf8');
      const publicKey = await publicKeyFor(options, manifest);
      verifyManifestSignature(bytes, signature, publicKey);
      const expectedKeyId = options.get('expected-key-id');
      if (expectedKeyId && manifest.keyId !== expectedKeyId) {
        throw new Error(`Manifest keyId is ${manifest.keyId}, expected ${expectedKeyId}.`);
      }
      console.log(JSON.stringify({ verified: true, sequence: manifest.sequence, version: manifest.version }));
      return;
    }
    case 'prepare': {
      assertOnly(options, [
        'spec',
        'installer',
        'output',
        'sequence',
        'published-at',
        'expires-at',
      ]);
      const spec = JSON.parse(await readFile(required(options, 'spec'), 'utf8'));
      const sequence = Number(required(options, 'sequence'));
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('--sequence must be a positive integer.');
      const publishedAt = new Date(required(options, 'published-at'));
      if (Number.isNaN(publishedAt.valueOf())) throw new Error('--published-at is invalid.');
      const expiresAt = options.has('expires-at')
        ? new Date(required(options, 'expires-at'))
        : new Date(publishedAt.valueOf() + CHANNEL_MANIFEST_LIFETIME_DAYS * 86_400_000);
      if (Number.isNaN(expiresAt.valueOf())) throw new Error('--expires-at is invalid.');
      const manifest = await prepareManifest({
        spec,
        installerPath: required(options, 'installer'),
        sequence,
        publishedAt: publishedAt.toISOString().replace('.000Z', 'Z'),
        expiresAt: expiresAt.toISOString().replace('.000Z', 'Z'),
      });
      await writeOutput(required(options, 'output'), encodeManifest(manifest));
      console.log(JSON.stringify({ prepared: true, sequence, version: manifest.version }));
      return;
    }
    case 'refresh': {
      assertOnly(options, [
        'manifest',
        'signature',
        'public-key',
        'private-key',
        'output-manifest',
        'output-signature',
        'now',
      ]);
      const { bytes, manifest } = await readManifest(required(options, 'manifest'));
      const oldSignature = await readFile(required(options, 'signature'), 'utf8');
      const publicKey = await readFile(required(options, 'public-key'), 'utf8');
      verifyManifestSignature(bytes, oldSignature, publicKey);
      const privateKey = await readFile(required(options, 'private-key'), 'utf8');
      const derivedPublicKey = publicKeyFromPrivate(privateKey);
      if (
        !timingSafeEqual(
          Buffer.from(derivedPublicKey.replace(/\s/g, '')),
          Buffer.from(publicKey.replace(/\s/g, '')),
        )
      ) {
        throw new Error('Release private key does not match the configured public key.');
      }
      const now = options.has('now') ? new Date(required(options, 'now')) : new Date();
      const refreshed = refreshManifest(manifest, now);
      const refreshedBytes = encodeManifest(refreshed);
      const refreshedSignature = signManifestBytes(refreshedBytes, privateKey);
      verifyManifestSignature(refreshedBytes, refreshedSignature, publicKey);
      await writeOutput(required(options, 'output-manifest'), refreshedBytes);
      await writeOutput(required(options, 'output-signature'), `${refreshedSignature}\n`);
      console.log(JSON.stringify({ refreshed: true, sequence: refreshed.sequence }));
      return;
    }
    case 'expiry-status': {
      assertOnly(options, ['manifest', 'now']);
      const { manifest } = await readManifest(required(options, 'manifest'));
      const now = options.has('now') ? new Date(required(options, 'now')) : new Date();
      console.log(JSON.stringify(getExpiryStatus(manifest, now)));
      return;
    }
    case 'field': {
      assertOnly(options, ['manifest', 'name']);
      const { manifest } = await readManifest(required(options, 'manifest'));
      const name = required(options, 'name');
      if (!['sequence', 'version', 'keyId'].includes(name)) throw new Error('Unsupported manifest field.');
      console.log(String(manifest[name]));
      return;
    }
    case 'verify-assets': {
      assertOnly(options, [
        'manifest',
        'signature',
        'public-key',
        'installer',
        'expected-key-id',
      ]);
      const manifest = await verifyAssets({
        manifestPath: required(options, 'manifest'),
        signaturePath: required(options, 'signature'),
        publicKeyPath: required(options, 'public-key'),
        installerPath: required(options, 'installer'),
        expectedKeyId: options.get('expected-key-id'),
      });
      console.log(JSON.stringify({ verified: true, version: manifest.version }));
      return;
    }
    case 'compare-files': {
      assertOnly(options, ['expected', 'actual']);
      const expected = await readFile(required(options, 'expected'));
      const actual = await readFile(required(options, 'actual'));
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        throw new Error('Files differ byte-for-byte.');
      }
      console.log(JSON.stringify({ identical: true, bytes: expected.length }));
      return;
    }
    default:
      usage();
      throw new Error(`Unknown command: ${command ?? '<none>'}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
