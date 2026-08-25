import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CURSOR_ASSETS = [
  ['idle', 'Idle'],
  ['hover', 'Hover'],
  ['pressed', 'Pressed'],
  ['moving', 'Moving'],
  ['busy', 'Busy'],
  ['text', 'Text'],
  ['disabled', 'Disabled'],
];

const options = parseArguments(process.argv.slice(2));
if (process.platform !== 'win32') throw new Error('Computer Use native helper can only be built on Windows.');

const projectRoot = path.resolve(options.projectRoot || process.cwd());
const outputPath = path.resolve(options.output || path.join(projectRoot, 'dist', 'native', 'monarch-computer-use.exe'));
const sourceRoot = path.join(projectRoot, 'tools', 'computer-use');
const sourcePath = path.join(sourceRoot, 'MonarchComputerUse.cs');
const animationPath = path.join(sourceRoot, 'OscarCursorAnimation.cs');
const assetPaths = CURSOR_ASSETS.map(([state]) => path.join(sourceRoot, 'assets', `oscar-cursor-${state}.png`));

for (const requiredPath of [sourcePath, animationPath, ...assetPaths]) {
  if (!existsSync(requiredPath)) throw new Error(`Computer Use native build input is missing: ${requiredPath}`);
}

const compiler = findFrameworkCompiler();
if (!compiler) throw new Error('Windows .NET Framework C# compiler is unavailable.');
const references = ['WindowsBase', 'UIAutomationClient', 'UIAutomationTypes'].map((name) => {
  const reference = findFrameworkReference(name);
  if (!reference) throw new Error(`Windows UI Automation reference assembly is unavailable: ${name}`);
  return reference;
});

const outputRoot = path.dirname(outputPath);
await mkdir(outputRoot, { recursive: true });
const temporaryPath = path.join(outputRoot, `.monarch-computer-use-${randomUUID()}.exe`);
try {
  await run(compiler, [
    '/nologo',
    '/optimize+',
    '/target:exe',
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll',
    ...references.map((reference) => `/reference:${reference}`),
    ...assetPaths.map((assetPath, index) => `/resource:${assetPath},MonarchComputerUse.OscarCursor.${CURSOR_ASSETS[index][1]}.png`),
    `/out:${temporaryPath}`,
    sourcePath,
    animationPath,
  ], projectRoot);
  const output = await stat(temporaryPath);
  if (!output.isFile() || output.size < 50_000) throw new Error(`Compiled Computer Use helper is invalid: ${temporaryPath}`);
  await rm(outputPath, { force: true });
  await rename(temporaryPath, outputPath);

  const [sourceHash, binaryHash] = await Promise.all([
    nativeSourceHash(sourcePath, animationPath, assetPaths),
    sha256(await readFile(outputPath)),
  ]);
  await writeFile(`${outputPath}.source.sha256`, `${sourceHash}\n`, 'utf8');
  await writeFile(`${outputPath}.binary.sha256`, `${binaryHash}\n`, 'utf8');
  process.stdout.write(`Built Computer Use native helper: ${outputPath} (${output.size} bytes)\n`);
} finally {
  await rm(temporaryPath, { force: true }).catch(() => undefined);
}

async function nativeSourceHash(source, animation, assets) {
  const hash = createHash('sha256')
    .update(await readFile(source))
    .update('\0oscar-cursor-animation\0')
    .update(await readFile(animation));
  for (let index = 0; index < assets.length; index += 1) {
    hash.update(`\0oscar-cursor-${CURSOR_ASSETS[index][0]}\0`).update(await readFile(assets[index]));
  }
  return hash.digest('hex');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--project-root') parsed.projectRoot = values[++index];
    else if (value === '--output') parsed.output = values[++index];
    else throw new Error(`Unknown Computer Use native build argument: ${value}`);
  }
  return parsed;
}

function findFrameworkCompiler() {
  const windowsRoot = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  return [
    path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((candidate) => existsSync(candidate)) || null;
}

function findFrameworkReference(name) {
  const windowsRoot = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(programFilesX86, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', 'v4.8', `${name}.dll`),
    path.join(programFilesX86, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', 'v4.7.2', `${name}.dll`),
    path.join(windowsRoot, 'Microsoft.NET', 'assembly', 'GAC_MSIL', name, 'v4.0_4.0.0.0__31bf3856ad364e35', `${name}.dll`),
  ].find((candidate) => existsSync(candidate)) || null;
}

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk) => { output = `${output}${chunk.toString('utf8')}`.slice(-32_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Computer Use native compiler failed (${code}): ${output.trim()}`));
    });
  });
}
