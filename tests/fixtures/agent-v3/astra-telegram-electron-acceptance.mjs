import { app, BrowserWindow, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAstraProductRendererGuard, pickAstraTelegramTarget } from '../../../desktop/electron/astra-product-host.mjs';
import { ASTRA_RUNTIME_PILOT_MODE, ASTRA_TELEGRAM_PILOT_MODE } from '../../../desktop/electron/astra-pilot-policy.mjs';

async function main() {
const root = path.resolve(process.argv[2] || '');
const selectedPath = path.resolve(process.argv[3] || '');
if (!path.isAbsolute(root) || !path.isAbsolute(selectedPath) || path.dirname(selectedPath) !== root) {
  throw Error('electron-acceptance:fixture-boundary');
}
mkdirSync(path.join(root, 'user-data'), { recursive: true });
app.setPath('userData', path.join(root, 'user-data'));

const desktopAttestationToken = randomBytes(32).toString('base64url');
const hostToken = randomBytes(32).toString('base64url');
const alias = { targetAlias: 'astra_remote_alias_' + 'e'.repeat(32), expiresAt: Date.now() + 60_000,
  authority: 'read-only', authorizesCreate: false, authorizesComputer: false };
let receivedExactPath = false;

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>Astra Telegram IPC acceptance</title><body>pending<script>
      addEventListener('DOMContentLoaded', async () => {
        try {
          const result = await window.monarchDesktop.astraPilot.pickTelegramTarget({
            version: 1, chatId: -1001, userId: 2002, requestId: 'electron_acceptance', ttlMs: 60000
          });
          document.body.textContent = JSON.stringify(result);
        } catch (error) { document.body.textContent = JSON.stringify({ status: 'error', error: String(error) }); }
      });
    </script>`);
    return;
  }
  if (request.method === 'POST' && request.url === '/api/astra/v3/host/telegram-target-aliases') {
    let body = '', rejected = false; request.setEncoding('utf8'); request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 16 * 1024) { rejected = true; request.destroy(); }
    }); request.on('end', () => {
      if (rejected) return;
      try {
        const parsed = JSON.parse(body);
        receivedExactPath = parsed.selectedPath === selectedPath && parsed.chatId === -1001 && parsed.userId === 2002
          && request.headers['x-monarch-desktop-attestation'] === desktopAttestationToken
          && request.headers['x-monarch-astra-host-token'] === hostToken;
        if (!receivedExactPath) throw Error('electron-acceptance:host-binding');
        response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, alias }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: String(error) }));
      }
    });
    return;
  }
  response.writeHead(404); response.end();
});

await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw Error('electron-acceptance:server-address');
const runtimeUrl = `http://127.0.0.1:${address.port}`;
await app.whenReady();
const preload = fileURLToPath(new URL('../../../desktop/electron/preload.cjs', import.meta.url));
const window = new BrowserWindow({ show: false, webPreferences: {
  preload, contextIsolation: true, nodeIntegration: false, sandbox: false,
} });
let rendererDiagnostic = '';
window.webContents.on('preload-error', (_event, _preloadPath, error) => {
  rendererDiagnostic = `preload-error:${error?.stack || error}`;
});
window.webContents.on('did-fail-load', (_event, code, description, url) => {
  rendererDiagnostic = `did-fail-load:${code}:${description}:${url}`;
});

function assertTrustedRenderer(event) {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || new URL(event.senderFrame.url).origin !== runtimeUrl) throw Error('electron-acceptance:untrusted-renderer');
}

ipcMain.handle('monarch:astra-product-pick-telegram-target', async (event, request) => {
  const guard = acquireAstraProductRendererGuard({ window, runtimeUrl, event, assertTrustedRenderer });
  try {
    return await pickAstraTelegramTarget({ mode: ASTRA_RUNTIME_PILOT_MODE, telegramMode: ASTRA_TELEGRAM_PILOT_MODE,
      request, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }) }, window,
      runtimeUrl, defaultDirectory: root, desktopAttestationToken, hostToken, fetchImpl: fetch, assertRenderer: guard.assert });
  } finally { guard.dispose(); }
});

const timeout = Date.now() + 15_000;
let exitCode = 0;
try {
  await window.loadURL(runtimeUrl);
  let text = '';
  while (Date.now() < timeout) {
    text = await window.webContents.executeJavaScript('document.body.textContent');
    if (String(text).startsWith('{')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const result = JSON.parse(String(text));
  if (result.status !== 'selected' || result.alias?.targetAlias !== alias.targetAlias || !receivedExactPath
    || JSON.stringify(result).includes(selectedPath)) throw Error('electron-acceptance:result');
  process.stdout.write('ASTRA_ELECTRON_ACCEPTANCE ' + JSON.stringify({ ok: true, actualPreloadIpc: true,
    hostBinding: true, rawPathReturned: false, authority: result.alias.authority }) + '\n');
} catch (error) {
  exitCode = 1;
  process.stderr.write(`ASTRA_ELECTRON_ACCEPTANCE_ERROR ${error?.stack || error} ${rendererDiagnostic}\n`);
} finally {
  ipcMain.removeHandler('monarch:astra-product-pick-telegram-target');
  if (!window.isDestroyed()) window.destroy();
  await new Promise(resolve => server.close(resolve));
  app.exit(exitCode);
}
}

// Electron's ESM loader must finish before app.ready can progress.
void main().catch(error => {
  process.stderr.write(`ASTRA_ELECTRON_ACCEPTANCE_ERROR ${error?.stack || error}\n`);
  app.exit(1);
});
