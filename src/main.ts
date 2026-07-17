import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MonarchApplication } from './app/application';
import { startMonarchHttpServer } from './app/http-server';
import type { MonarchIntentSource } from './core';
import { readModelCatalog } from './modules/models/model-catalog';
import { createModelRuntimeReport } from './modules/models/runtime-adapters';

const workspaceRoot = process.cwd();

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const command = (process.argv[2] || 'serve').toLowerCase();

  switch (command) {
  case 'serve':
  case 'server':
  case 'ui':
    await runServe();
    return;
  case 'status':
  case 'health':
    await runStatus();
    return;
  case 'intent':
  case 'ask':
  case 'run':
    await runIntent();
    return;
  case 'system':
  case 'profile':
    await runSystemProfile();
    return;
  case 'check-models':
  case 'check':
    await runCheckModels();
    return;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    return;
  default:
    throw new Error(`Unknown Monarch command: ${command}. Run "npm run start -- help".`);
  }
}

async function runServe(): Promise<void> {
  const app = new MonarchApplication({ workspaceRoot });
  const requestedPort = readNumberFlag('--port') || Number(process.env.MONARCH_UI_PORT || process.env.PORT || 4317);
  const host = readStringFlag('--host') || process.env.MONARCH_HOST || '127.0.0.1';
  const publicDirectory = fileURLToPath(new URL('./ui/public', import.meta.url));
  const handle = await startServeWithPortFallback(app, publicDirectory, host, requestedPort);

  console.log(`Monarch listening at ${handle.url}`);

  const shutdown = async (): Promise<void> => {
    await handle.close().catch(() => undefined);
    await app.stop().catch(() => undefined);
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

async function startServeWithPortFallback(
  app: MonarchApplication,
  publicDirectory: string,
  host: string,
  requestedPort: number
): ReturnType<typeof startMonarchHttpServer> {
  let lastError: unknown = null;

  for (const port of portCandidates(requestedPort)) {
    try {
      return await startMonarchHttpServer({
        app,
        publicDirectory,
        host,
        port,
      });
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }

  await app.stop().catch(() => undefined);
  throw lastError || new Error('Could not start Monarch server.');
}

async function runStatus(): Promise<void> {
  await withApplication(async (app) => {
    const state = await app.getState();
    console.log(JSON.stringify({
      ok: state.runtime.health.ok,
      app: state.app,
      modules: {
        active: state.runtime.snapshot.modules.filter((record) => record.status === 'active').length,
        total: state.runtime.snapshot.modules.length,
      },
      capabilities: state.runtime.snapshot.capabilities.length,
      events: state.runtime.snapshot.events.length,
      models: {
        available: state.models.models.filter((model) => model.status === 'available').length,
        total: state.models.models.length,
      },
      loadRecords: state.runtime.loadRecords,
    }, null, 2));
  });
}

async function runIntent(): Promise<void> {
  const text = readPositionalText(3);
  if (!text) {
    throw new Error('Intent text is required. Example: npm run intent -- "Покажи плагины"');
  }

  await withApplication(async (app) => {
    const result = await app.submitIntent({
      text,
      source: readSourceFlag(),
      confirmed: hasFlag('--confirm') || hasFlag('--confirmed'),
    });
    console.log(JSON.stringify(result, null, 2));
  });
}

async function runSystemProfile(): Promise<void> {
  await withApplication(async (app) => {
    console.log(JSON.stringify(app.getSystemProfile(), null, 2));
  });
}

async function runCheckModels(): Promise<void> {
  const catalog = await readModelCatalog(workspaceRoot);
  const runtimeReport = createModelRuntimeReport(catalog);

  console.log(`Model Check Summary:`);
  console.log(`====================`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Model directory: ${catalog.root}`);
  console.log(`Directory exists: ${catalog.exists ? 'Yes' : 'No'}\n`);

  let hasMissing = false;

  for (const entry of runtimeReport.entries) {
    const model = catalog.models.find(m => m.role === entry.role);
    const modelPath = model ? model.modelPath : 'unknown';
    const totalSize = model ? model.totalSize : '0 B';
    const status = entry.runnerStatus;
    const canInfer = entry.canInfer;

    console.log(`- Role: ${entry.role}`);
    console.log(`  Label: ${entry.label}`);
    console.log(`  Path: ${modelPath}`);
    console.log(`  Current Size: ${totalSize}`);
    console.log(`  Status: ${status}`);
    console.log(`  Can Infer: ${canInfer ? 'Yes' : 'No'}`);
    console.log(`  Detail: ${entry.detail}`);

    if (status === 'missing' || status === 'model-missing') {
      hasMissing = true;
      console.log(`  ⚠️  Model weights are missing.`);
      console.log(`  Step-by-step instructions to resolve:`);
      const modelRoot = model?.role.startsWith('gemma4-') ? workspaceRoot : catalog.root;
      console.log(`    1. Ensure directory exists: ${path.dirname(path.join(modelRoot, modelPath))}`);
      console.log(`    2. Download model file for ${entry.label}`);
      console.log(`    3. Place download at: ${path.join(modelRoot, modelPath)}`);
    } else if (status === 'unhealthy') {
      console.log(`  ⚠️  Model weights exist but failed health check (invalid size or unreadable).`);
    } else if (status === 'loading') {
      console.log(`  ⏳ Model is currently downloading (.crdownload file present).`);
    } else if (status === 'disabled') {
      console.log(`  🚫 Model is disabled in settings.`);
    } else if (status === 'experimental') {
      console.log(`  🔬 Model is present and ready (experimental).`);
    } else {
      console.log(`  ✅ Model is present and ready.`);
    }
    console.log('');
  }

  if (hasMissing) {
    console.error(`Error: One or more models are missing.`);
    process.exitCode = 1;
  } else {
    console.log(`All models verified successfully.`);
  }
}

async function withApplication(
  task: (app: MonarchApplication) => Promise<void>
): Promise<void> {
  const app = new MonarchApplication({ workspaceRoot });
  await app.start();
  try {
    await task(app);
  } finally {
    await app.stop();
  }
}

function printHelp(): void {
  console.log(`Monarch commands:
  serve                     Start the local Monarch HTTP/UI program.
  status                    Print runtime health and registry summary.
  intent <text> [--confirm] Route and execute one intent.
  system                    Print the agent system profile.
  check-models              List model files, check size, detect missing models, and print instructions.

Examples:
  npm start
  npm run status
  npm run intent -- "Покажи плагины"
  npm run intent -- "Проверь Security"`);
}

function readPositionalText(startIndex: number): string {
  return process.argv
    .slice(startIndex)
    .filter((value) => !value.startsWith('--'))
    .join(' ')
    .trim();
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readStringFlag(name: string): string {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length).trim();
  }

  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return (process.argv[index + 1] || '').trim();
  }

  return '';
}

function readNumberFlag(name: string): number {
  const value = readStringFlag(name);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readSourceFlag(): MonarchIntentSource {
  const value = readStringFlag('--source').toLowerCase();
  switch (value) {
  case 'voice':
  case 'api':
  case 'system':
  case 'desktop':
    return value;
  default:
    return 'desktop';
  }
}

function portCandidates(requestedPort: number): number[] {
  const normalizedPort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 4317;
  if (/^(1|true|yes)$/i.test(process.env.MONARCH_STRICT_PORT || '')) {
    return [normalizedPort];
  }

  return Array.from({ length: 20 }, (_value, index) => normalizedPort + index);
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}
