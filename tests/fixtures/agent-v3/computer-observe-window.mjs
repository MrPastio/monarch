// Own synthetic Electron window only. No shell, external navigation, user profile,
// window enumeration or automation of other applications.
import { app, BrowserWindow, dialog } from 'electron';
import { readFileSync, realpathSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAstraComputerDialog } from '../../../desktop/electron/astra-computer-dialog.mjs';

async function main() {
const root = realpathSync(process.argv[2]);
const basename = path.basename(root), markerFile = readFileSync(path.join(root, '.fixture-marker'), 'utf8');
if (!((basename.startsWith('astra-v3-live-computer-') && markerFile === 'astra-owned-native-window-only')
  || (basename.startsWith('astra-v3-product-runtime-') && markerFile === 'astra-product-runtime-live-v1')
  || (basename.startsWith('astra-v3-product-renderer-') && markerFile === 'astra-product-renderer-v1'))
  || path.dirname(root) !== 'D:\\Monarch-test-tmp-astra-v3') throw Error('owned-root-required');
for (const name of ['userData', 'sessionData', 'logs']) { const dir = path.join(root, name); mkdirSync(dir, { recursive: true }); app.setPath(name, dir); }
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
await app.whenReady(); app.setAccessibilitySupportEnabled(true);
const title = 'Astra owned native observation ' + path.basename(root), marker = 'ASTRA_OWNED_WINDOW_VALUE_42';
const actionMode = process.argv[3] || '';
const writable = actionMode === 'owned-replace-qa';
const clickable = actionMode === 'owned-click-qa';
const keyable = actionMode === 'owned-key-qa';
const scrollable = actionMode === 'owned-scroll-qa';
const window = new BrowserWindow({ title, x: 0, y: 0, width: 680, height: 360, alwaysOnTop: Boolean(actionMode),
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
const actionFixture = clickable
  ? '<button id="owned-click" type="button" aria-label="Owned click test button" style="display:block;margin-top:18px;padding:12px 20px" onclick="window.__ownedClickCount=(window.__ownedClickCount||0)+1;document.getElementById(\'click-count\').textContent=String(window.__ownedClickCount)">Owned click test button</button><output id="click-count" aria-label="Owned click count">0</output>'
  : keyable ? '<p id="key-result" aria-label="Owned key result">NO_KEY</p><script>window.__ownedKeys=[];document.addEventListener("keydown",event=>{window.__ownedKeys.push(event.key);document.getElementById("key-result").textContent=event.key})</script>'
    : scrollable ? '<button id="owned-scroll" type="button" aria-label="Owned scroll test target" style="display:block;margin-top:18px;padding:12px 20px">Owned scroll test target</button><output id="scroll-result" aria-label="Owned scroll result">NO_SCROLL</output><script>window.__ownedWheels=[];document.addEventListener("wheel",event=>{window.__ownedWheels.push(event.deltaY);document.getElementById("scroll-result").textContent=String(event.deltaY)},{passive:true})</script>' : '';
await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><head><title>${title}</title></head><body style="background:#171717;color:white;font:18px sans-serif;padding:24px"><h2 style="color:#ff9e40">Astra — isolated Computer Use QA</h2><p>Only synthetic data in this owned window.</p><label for="value">${writable ? 'Owned replacement test value' : 'Read-only test value'}</label><textarea id="value" ${writable ? '' : 'readonly'} style="display:block;width:96%;margin-top:12px;font:18px monospace">${marker}</textarea>${actionFixture}</body></html>`));
window.showInactive(); // The launcher hides its console; explicitly show only this owned test window without taking focus.
if (actionMode) window.setAlwaysOnTop(true, 'screen-saver');
const bytes = window.getNativeWindowHandle();
const windowRef = 'hwnd:' + (bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString(16).toUpperCase().padStart(16, '0');
window.once('closed', () => console.log('ASTRA_WINDOW_EVENT ' + JSON.stringify({ kind: 'lifecycle', phase: 'closed' })));
const choose = createAstraComputerDialog({ deployment: 'isolated-validation', dialog, window, assertWindow: () => { if (window.isDestroyed()) throw Error('owned-window-closed'); } });
let choosing = false; const controlToken = randomUUID();
const control = createServer((request, response) => { void (async () => {
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'POST' || request.headers.authorization !== 'Bearer ' + controlToken) { response.writeHead(403); response.end('{}'); return; }
  try {
    let body = ''; for await (const chunk of request) { body += chunk.toString(); if (body.length > 32768) throw Error('owned-command-budget'); }
    const command = JSON.parse(body);
    if (command.kind === 'stop') { response.end('{}'); app.quit(); return; }
    if (command.kind === 'read-owned-value' && writable) {
      const value = await window.webContents.executeJavaScript("document.getElementById('value').value");
      response.end(JSON.stringify({ value })); return;
    }
    if (command.kind === 'read-owned-clicks' && clickable) {
      const clicks = await window.webContents.executeJavaScript("Number(window.__ownedClickCount || 0)");
      response.end(JSON.stringify({ clicks })); return;
    }
    if (command.kind === 'read-owned-keys' && keyable) {
      const keys = await window.webContents.executeJavaScript("Array.from(window.__ownedKeys || [])");
      response.end(JSON.stringify({ keys })); return;
    }
    if (command.kind === 'read-owned-wheels' && scrollable) {
      const wheels = await window.webContents.executeJavaScript("Array.from(window.__ownedWheels || [])");
      response.end(JSON.stringify({ wheels })); return;
    }
    if (command.kind === 'identity') { const current = window.getNativeWindowHandle();
      response.end(JSON.stringify({ destroyed: window.isDestroyed(), visible: window.isVisible(),
        windowRef: 'hwnd:' + (current.length === 8 ? current.readBigUInt64LE() : BigInt(current.readUInt32LE())).toString(16).toUpperCase().padStart(16, '0') })); return; }
    if (command.kind !== 'choose' || choosing || !Array.isArray(command.windows) || command.windows.length !== 1
      || command.windows[0]?.windowRef !== windowRef || command.windows[0]?.processId !== process.pid || command.windows[0]?.title !== title)
      throw Error('owned-dialog-target');
    choosing = true; const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110000);
    try { const selected = await choose(command.windows, controller.signal); response.end(JSON.stringify({ selected })); }
    finally { choosing = false; clearTimeout(timer); }
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
})().catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); });
});
await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
app.on('window-all-closed', () => app.quit()); app.once('will-quit', () => control.close());
setTimeout(() => app.quit(), 180000).unref();
console.log('ASTRA_WINDOW_EVENT ' + JSON.stringify({ kind: 'ready', windowRef, processId: process.pid, processName: 'electron', title, marker,
  controlPort: control.address().port, controlToken }));
}
// Do not hold Electron's ESM module evaluation waiting for app.ready.
void main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); app.exit(1); });
