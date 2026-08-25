import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeviceModule } from '../src/modules/device';
import { createMonarchId, nowIso, type MonarchExecutionRequest } from '../src/core';

const root = path.resolve(
  process.env.MONARCH_DEVICE_APP_QA_ROOT
    || path.join('E:\\MonarchQA', 'device-application-resolution', new Date().toISOString().replace(/[:.]/gu, '-')),
);
const launchEnabled = process.env.MONARCH_DEVICE_APP_QA_LAUNCH !== '0';
const launchQuery = String(process.env.MONARCH_DEVICE_APP_QA_LAUNCH_QUERY || 'пеинт').trim();
const matrix = readMatrix(process.env.MONARCH_DEVICE_APP_QA_MATRIX);
const events: Array<{ type: string; moduleId: string; payload: unknown }> = [];
const module = new DeviceModule();
const context = {
  emit: async (type: string, moduleId: string, payload: unknown) => {
    events.push({ type, moduleId, payload });
  },
} as any;

await mkdir(root, { recursive: true });
const startedAt = Date.now();
const resolutions = [];
for (const entry of matrix) {
  const queryStartedAt = Date.now();
  const result = await module.executeCapability(request('device.apps.search', { query: entry.query }), context);
  const output = result.output && typeof result.output === 'object'
    ? result.output as Record<string, unknown>
    : {};
  const matches = Array.isArray(output.matches) ? output.matches as Array<Record<string, unknown>> : [];
  const selectedName = typeof matches[0]?.name === 'string' ? matches[0].name : '';
  resolutions.push({
    query: entry.query,
    expectedName: entry.expectedName,
    durationMs: Date.now() - queryStartedAt,
    selectedName,
    executionOk: result.ok,
    executionError: result.error || null,
    executionSummary: result.summary,
    resolution: output.resolution || null,
    matches,
    ok: result.ok === true
      && output.resolution === 'unique'
      && selectedName.toLocaleLowerCase('en-US') === entry.expectedName.toLocaleLowerCase('en-US'),
  });
}

const launch = launchEnabled
  ? await module.executeCapability(request('device.app.open', { app: launchQuery }, true), context)
  : null;
const launchOutput = launch?.output && typeof launch.output === 'object'
  ? launch.output as Record<string, unknown>
  : {};
const serializedPublicEvidence = JSON.stringify({ resolutions, launch });
const report = {
  schemaVersion: 1,
  generatedAt: nowIso(),
  durationMs: Date.now() - startedAt,
  platform: process.platform,
  matrix: resolutions,
  launch: launchEnabled ? {
    query: launchQuery,
    ok: launch?.ok === true
      && launchOutput.opened === true
      && launchOutput.verified === true
      && launchOutput.authoritative === true,
    result: launch,
  } : { skipped: true },
  publicReceiptLeaksLaunchTarget: /(?:shell:AppsFolder|\\.exe(?:"|\\|$)|_8wekyb3d8bbwe!App)/iu.test(serializedPublicEvidence),
  events,
};
const ok = process.platform === 'win32'
  && resolutions.every((entry) => entry.ok)
  && (!launchEnabled || report.launch.ok === true)
  && report.publicReceiptLeaksLaunchTarget === false;
const evidence = { ok, root, ...report };
await writeFile(path.join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (!ok) process.exitCode = 1;

function request(
  capabilityId: 'device.apps.search' | 'device.app.open',
  input: Record<string, unknown>,
  confirmed = false,
): MonarchExecutionRequest {
  return {
    id: createMonarchId('exec_device_app_qa'),
    intentId: createMonarchId('intent_device_app_qa'),
    moduleId: 'device',
    capabilityId,
    input,
    createdAt: nowIso(),
    requestedBy: 'device-application-resolution-acceptance',
    source: 'smoke',
    confirmed,
  };
}

function readMatrix(value: string | undefined): Array<{ query: string; expectedName: string }> {
  if (value) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('MONARCH_DEVICE_APP_QA_MATRIX must be a JSON array.');
    const matrix = parsed.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid QA matrix entry.');
      const record = entry as Record<string, unknown>;
      const query = String(record.query || '').trim();
      const expectedName = String(record.expectedName || '').trim();
      if (!query || !expectedName) throw new Error('QA matrix entries require query and expectedName.');
      return { query, expectedName };
    });
    if (matrix.length === 0 || matrix.length > 50) throw new Error('QA matrix must contain 1-50 entries.');
    return matrix;
  }
  return [
    { query: 'пеинт', expectedName: 'Paint' },
    { query: 'логитеч хаб', expectedName: 'Logitech G HUB' },
    { query: 'фигму', expectedName: 'Figma' },
    { query: 'калькулятор', expectedName: 'Калькулятор' },
    { query: 'ыеуфь', expectedName: 'Steam' },
  ];
}
