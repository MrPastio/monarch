import { fileURLToPath } from 'node:url';
import { MonarchApplication } from '../app/application';
import { startMonarchHttpServer } from '../app/http-server';

const workspaceRoot = process.cwd();
const publicDirectory = fileURLToPath(new URL('./public', import.meta.url));
const port = Number(process.env.MONARCH_UI_PORT || process.env.PORT || 4317);
const host = process.env.MONARCH_HOST || '127.0.0.1';
const app = new MonarchApplication({ workspaceRoot });
const server = await startMonarchHttpServer({
  app,
  publicDirectory,
  host,
  port,
});

console.log(`Monarch UI listening at ${server.url}`);

process.once('SIGINT', () => {
  void shutdown();
});

process.once('SIGTERM', () => {
  void shutdown();
});

async function shutdown(): Promise<void> {
  await server.close().catch(() => undefined);
  await app.stop().catch(() => undefined);
  process.exit(0);
}
