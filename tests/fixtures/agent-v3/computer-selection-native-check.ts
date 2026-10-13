import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { ComputerUseNativeBridge, ComputerUseNativeError } from '../../../src/modules/computer/native-bridge';

async function main() {
  const parent = await realpath('.test-tmp');
  if (path.parse(parent).root.toUpperCase() !== 'D:\\') throw Error('owned-D-parent-required');
  const resume = process.argv[2];
  const root = await realpath(resume ?? await mkdtemp(path.join(parent, 'astra-v3-computer-native-')));
  if (path.dirname(root) !== parent || !path.basename(root).startsWith('astra-v3-computer-native-')) throw Error('owned-child-required');
  if (resume) {
    if (await readFile(path.join(root, '.fixture-marker'), 'utf8') !== 'astra-computer-native-binding-pure-check') throw Error('owned-marker-required');
  } else await writeFile(path.join(root, '.fixture-marker'), 'astra-computer-native-binding-pure-check', { flag: 'wx' });
  console.log('OWNED_NATIVE_BINDING_ROOT', root);
  const bridge = new ComputerUseNativeBridge({ monarchRoot: process.cwd(), runtimeRoot: path.join(root, 'native'),
    prebuiltBinaryPath: path.join(root, 'no-prebuilt.exe') });
  const status = await bridge.status(); if (status.available !== true) throw Error('native-compile-failed:' + JSON.stringify(status));
  const binary = await realpath(bridge.binaryPath);
  if (!binary.startsWith(root + path.sep)) throw Error('owned-binary-required');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.resolve('tests/fixtures/agent-v3/computer-selection-native-check.ps1');
  const report = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-NativeBinary', binary, '-FixtureRoot', root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); }, 15000);
    child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 32768) child.kill(); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(stdout.trim()); else reject(Error('native-validator:' + code + ':' + stderr)); });
  });
  const result = JSON.parse(report);
  // Actual helper/bridge envelope with an invalid epoch: rejected while parsing
  // ControlGuard arguments, BEFORE control-file read, ResolveWindow or any UI call.
  let nativePreflight = false;
  try {
    await bridge.act({ windowRef: 'hwnd:0000000000000042', expectedProcessId: 42, expectedTitle: 'Synthetic',
      expectedProcessInstanceId: `process:${'4'.repeat(64)}`,
      expectedBounds: { x: 0, y: 0, width: 1, height: 1 }, expectedStateFingerprint: 'synthetic', expectedPerceptualHash: '0'.repeat(16),
      action: { kind: 'close' }, afterScreenshotPath: path.join(root, 'never-created.png'), controlStatePath: path.join(root, 'never-read-control.json'),
      controlEpoch: 0, inputLeaseId: 'synthetic-preflight', cursorOrigin: { x: 0, y: 0 } });
  } catch (error) {
    if (!(error instanceof ComputerUseNativeError) || error.actionDispatchState !== 'not-dispatched') throw error;
    nativePreflight = true;
  }
  if (!nativePreflight) throw Error('invalid-native-epoch-was-not-rejected');
  result.results.push({ case: 'actual-bridge-invalid-epoch-preflight', result: 'not-dispatched', passed: true });
  await writeFile(path.join(root, 'native-binding-proof.json'), JSON.stringify({ ...result,
    sourceDigest: (await readFile(bridge.binaryPath + '.source.sha256', 'utf8')).trim(),
    binaryDigest: (await readFile(bridge.binaryPath + '.binary.sha256', 'utf8')).trim() }, null, 2), { flag: 'wx' });
  console.log('NATIVE_BINDING_PASS', JSON.stringify({ root, tests: result.results.length, nativeCapture: false, nativeInput: false }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
