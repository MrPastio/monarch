import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SherpaVoiceSttRuntime } from '../../src/modules/voice/voice-sherpa-runtime';

const cleanup: string[] = [];
const previousModelDir = process.env.MONARCH_SHERPA_MODEL_DIR;
const previousTtl = process.env.MONARCH_STT_STREAM_TTL_MS;

afterEach(async () => {
  restoreEnv('MONARCH_SHERPA_MODEL_DIR', previousModelDir);
  restoreEnv('MONARCH_STT_STREAM_TTL_MS', previousTtl);
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('SherpaVoiceSttRuntime process isolation', () => {
  it('enforces the pending cap across a concurrent cold start', async () => {
    const worker = await writeProtocolWorker(`
setTimeout(() => console.log(JSON.stringify({
  id: request.id, type: 'ready', engine: 'sherpa-onnx-t-one', model: 'fake',
  loadMs: 0, warm: true, pid: process.pid,
})), 80);
`);
    const runtime = new SherpaVoiceSttRuntime({
      workspaceRoot: process.cwd(),
      workerScriptPath: worker,
      maxPendingRequests: 2,
      requestTimeoutMs: 2_000,
    });
    try {
      const results = await Promise.allSettled([
        runtime.prepare(),
        runtime.prepare(),
        runtime.prepare(),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'voice-stt-queue-overflow' },
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('rejects pending work on crash and restarts the child for the next request', async () => {
    const markerDir = await mkdtemp(path.join(process.cwd(), 'runtime', 'voice-sherpa-marker-'));
    cleanup.push(markerDir);
    const marker = path.join(markerDir, 'crashed');
    const worker = await writeProtocolWorker(`
const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  process.exit(9);
}
console.log(JSON.stringify({
  id: request.id, type: 'ready', engine: 'sherpa-onnx-t-one', model: 'fake',
  loadMs: 0, warm: true, pid: process.pid,
}));
`);
    const runtime = new SherpaVoiceSttRuntime({
      workspaceRoot: process.cwd(),
      workerScriptPath: worker,
      requestTimeoutMs: 2_000,
    });
    try {
      await expect(runtime.prepare()).rejects.toMatchObject({ code: 'voice-stt-runtime-exited' });
      await expect(runtime.prepare()).resolves.toMatchObject({ engine: 'sherpa-onnx-t-one' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('expires idle streams inside the isolated worker even if the server cleanup is missed', async () => {
    const fixture = await writeFakeNativeWorkerFixture();
    process.env.MONARCH_SHERPA_MODEL_DIR = fixture.modelDir;
    process.env.MONARCH_STT_STREAM_TTL_MS = '100';
    const runtime = new SherpaVoiceSttRuntime({
      workspaceRoot: process.cwd(),
      workerScriptPath: fixture.workerPath,
      requestTimeoutMs: 2_000,
    });
    try {
      await runtime.startStream({ streamId: 'stream_ttl_12345', language: 'ru-RU', sampleRate: 16_000 });
      await new Promise((resolve) => setTimeout(resolve, 160));
      await expect(runtime.pushStream({
        streamId: 'stream_ttl_12345',
        sequence: 0,
        pcmBase64: Buffer.alloc(320).toString('base64'),
      })).rejects.toMatchObject({ code: 'voice-stt-stream-not-found' });
    } finally {
      await runtime.shutdown();
    }
  });

  it('refreshes the isolated worker expiry while long-form PCM is active', async () => {
    const fixture = await writeFakeNativeWorkerFixture();
    process.env.MONARCH_SHERPA_MODEL_DIR = fixture.modelDir;
    process.env.MONARCH_STT_STREAM_TTL_MS = '100';
    const runtime = new SherpaVoiceSttRuntime({
      workspaceRoot: process.cwd(),
      workerScriptPath: fixture.workerPath,
      requestTimeoutMs: 2_000,
    });
    try {
      await runtime.startStream({ streamId: 'stream_active_12345', language: 'ru-RU', sampleRate: 16_000 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await expect(runtime.pushStream({
        streamId: 'stream_active_12345',
        sequence: 0,
        pcmBase64: Buffer.alloc(320).toString('base64'),
      })).resolves.toMatchObject({ sequence: 0 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await expect(runtime.pushStream({
        streamId: 'stream_active_12345',
        sequence: 1,
        pcmBase64: Buffer.alloc(320).toString('base64'),
      })).resolves.toMatchObject({ sequence: 1 });
      await new Promise((resolve) => setTimeout(resolve, 130));
      await expect(runtime.pushStream({
        streamId: 'stream_active_12345',
        sequence: 2,
        pcmBase64: Buffer.alloc(320).toString('base64'),
      })).rejects.toMatchObject({ code: 'voice-stt-stream-not-found' });
    } finally {
      await runtime.shutdown();
    }
  });
});

async function writeProtocolWorker(body: string): Promise<string> {
  const root = path.join(process.cwd(), 'runtime');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'voice-sherpa-protocol-'));
  cleanup.push(dir);
  const worker = path.join(dir, 'worker.cjs');
  await writeFile(worker, `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'shutdown') process.exit(0);
  ${body}
});
`, 'utf8');
  return path.relative(process.cwd(), worker);
}

async function writeFakeNativeWorkerFixture(): Promise<{ workerPath: string; modelDir: string }> {
  const root = path.join(process.cwd(), 'runtime');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'voice-sherpa-native-'));
  cleanup.push(dir);
  const workerPath = path.join(dir, 'voice-sherpa-worker.cjs');
  await copyFile(path.join(process.cwd(), 'src', 'modules', 'voice', 'workers', 'voice-sherpa-worker.cjs'), workerPath);
  const packageDir = path.join(dir, 'node_modules', 'sherpa-onnx-node');
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'index.js'), `
class OnlineRecognizer {
  createStream() { return { acceptWaveform() {}, inputFinished() {} }; }
  isReady() { return false; }
  decode() {}
  getResult() { return { text: '' }; }
}
module.exports = { OnlineRecognizer };
`, 'utf8');
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'sherpa-onnx-node', main: 'index.js' }));
  const modelDir = path.join(dir, 'model');
  await mkdir(modelDir);
  await writeFile(path.join(modelDir, 'model.onnx'), 'fake');
  await writeFile(path.join(modelDir, 'tokens.txt'), 'fake');
  return { workerPath: path.relative(process.cwd(), workerPath), modelDir };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
