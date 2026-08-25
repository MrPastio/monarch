import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const debugPort = Number(process.env.MONARCH_UI_QA_DEBUG_PORT || 9224);
const outputRoot = path.resolve(process.env.MONARCH_UI_QA_ROOT || 'E:\\MonarchQA\\computer-use-ui-visual');
const referenceViewport = { width: 1176, height: 702, deviceScaleFactor: 1, mobile: false };

await mkdir(outputRoot, { recursive: true });
const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === 'page' && /^http:\/\/127\.0\.0\.1:/u.test(entry.url));
if (!target?.webSocketDebuggerUrl) throw new Error(`No Monarch page target on debug port ${debugPort}.`);

const cdp = await connectCdp(target.webSocketDebuggerUrl);
const consoleMessages = [];
cdp.on('Runtime.consoleAPICalled', (params) => {
  if (!['error', 'warning'].includes(params?.type)) return;
  consoleMessages.push({
    type: params.type,
    text: (params.args || []).map((entry) => String(entry.value ?? entry.description ?? '')).join(' ').slice(0, 1_000),
  });
});
cdp.on('Runtime.exceptionThrown', (params) => {
  consoleMessages.push({ type: 'exception', text: String(params?.exceptionDetails?.text || 'Renderer exception').slice(0, 1_000) });
});

try {
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', referenceViewport);
  await waitFor(async () => Boolean(await evaluate(cdp, `Boolean(document.querySelector('#oscar-input') && document.readyState === 'complete')`)), 20_000);
  await delay(2_000);
  await evaluate(cdp, `(() => {
    const startup = document.querySelector('#startup-motion');
    if (startup) startup.style.display = 'none';
    document.querySelector('[data-view="oscar-section"]')?.click();
    return true;
  })()`);
  await delay(500);

  await evaluate(cdp, `(() => {
    const menu = document.querySelector('#oscar-composer-menu');
    menu.open = true;
    menu.querySelector('summary')?.setAttribute('aria-expanded', 'true');
    return true;
  })()`);
  await delay(500);
  const menuScreenshot = path.join(outputRoot, 'computer-use-plus-menu.png');
  await capturePage(cdp, menuScreenshot);
  const menuLayout = await evaluate(cdp, `(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      popover: rect('#oscar-composer-menu-popover'),
      computerUse: rect('#oscar-computer-use-toggle'),
      permissions: rect('.computer-use-permission-picker'),
      composer: rect('#oscar-composer'),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  })()`);
  const permissionTransitions = [];
  for (const preset of ['ask', 'full', 'guard']) {
    await evaluate(cdp, `document.querySelector('[data-computer-use-permission="${preset}"]')?.click()`);
    await waitFor(async () => evaluate(cdp, `document.querySelector('[data-computer-use-permission="${preset}"]')?.getAttribute('aria-checked') === 'true'`), 10_000);
    permissionTransitions.push(await evaluate(cdp, `(async () => {
      const token = document.querySelector('meta[name="monarch-api-token"]')?.getAttribute('content') || '';
      const response = await fetch('/api/permissions', { headers: {
        ...(token ? { Authorization: 'Bearer ' + token, 'X-Monarch-Session': token } : {}),
      } });
      const payload = await response.json();
      return {
        preset: '${preset}',
        status: response.status,
        sandboxMode: payload?.profile?.sandboxMode || '',
        approvalPolicy: payload?.profile?.approvalPolicy || '',
        autonomyMode: payload?.profile?.autonomyMode || '',
      };
    })()`));
  }

  await evaluate(cdp, `(() => {
    document.querySelector('#oscar-composer-menu')?.removeAttribute('open');
    const input = document.querySelector('#oscar-input');
    input.value = '@';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await delay(450);
  const functionScreenshot = path.join(outputRoot, 'computer-use-at-picker.png');
  await capturePage(cdp, functionScreenshot);
  const functionLayout = await evaluate(cdp, `(() => {
    const picker = document.querySelector('#oscar-function-picker');
    const item = picker?.querySelector('[data-oscar-function="computer-use"]');
    const rect = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null;
    return {
      visible: Boolean(picker && !picker.classList.contains('hidden')),
      invocation: item?.querySelector('span')?.textContent?.trim() || '',
      picker: rect(picker),
      item: rect(item),
    };
  })()`);

  await evaluate(cdp, `(() => {
    const input = document.querySelector('#oscar-input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-mode-standard')?.click();
    return true;
  })()`);
  await delay(350);
  const chatSwitchScreenshot = path.join(outputRoot, 'chat-mode-switch-chat.png');
  await captureElement(cdp, '.chat-mode-switch', chatSwitchScreenshot, 14);
  const chatSwitchLayout = await readSwitchLayout(cdp);

  await evaluate(cdp, `document.querySelector('#chat-mode-coder')?.click()`);
  await delay(450);
  const coderSwitchScreenshot = path.join(outputRoot, 'chat-mode-switch-coder.png');
  await captureElement(cdp, '.chat-mode-switch', coderSwitchScreenshot, 14);
  const coderSwitchLayout = await readSwitchLayout(cdp);
  await evaluate(cdp, `document.querySelector('#chat-mode-standard')?.click()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 984,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(400);
  const overallScreenshot = path.join(outputRoot, 'computer-use-overall-stopped.png');
  await capturePage(cdp, overallScreenshot);
  const overallState = await evaluate(cdp, `(() => {
    const control = document.querySelector('#computer-use-control');
    const rect = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return {
      computerUseState: control?.dataset.state || '',
      computerUseAriaHidden: control?.getAttribute('aria-hidden'),
      computerUseVisible: Boolean(control && getComputedStyle(control).visibility !== 'hidden' && Number(getComputedStyle(control).opacity) > 0),
      composer: rect(document.querySelector('#oscar-composer')),
      switch: rect(document.querySelector('.chat-mode-switch')),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  })()`);

  const report = {
    ok: true,
    capturedAt: new Date().toISOString(),
    target: { title: target.title, url: target.url },
    viewport: referenceViewport,
    screenshots: {
      menu: menuScreenshot,
      functionPicker: functionScreenshot,
      chatSwitch: chatSwitchScreenshot,
      coderSwitch: coderSwitchScreenshot,
      overall: overallScreenshot,
    },
    menuLayout,
    permissionTransitions,
    functionLayout,
    switchLayout: { chat: chatSwitchLayout, coder: coderSwitchLayout },
    overallState,
    consoleMessages,
  };
  await writeFile(path.join(outputRoot, 'computer-use-ui-qa-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  cdp.close();
}

async function readSwitchLayout(cdpClient) {
  return evaluate(cdpClient, `(() => {
    const host = document.querySelector('.chat-mode-switch');
    const chat = document.querySelector('#chat-mode-standard');
    const coder = document.querySelector('#chat-mode-coder');
    const rect = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const hostRect = rect(host);
    const active = host.dataset.activeMode;
    const activeRect = rect(active === 'coder' ? coder : chat);
    return {
      active,
      host: hostRect,
      chat: rect(chat),
      coder: rect(coder),
      activeInsetLeft: activeRect.x - hostRect.x,
      activeInsetRight: hostRect.x + hostRect.width - activeRect.x - activeRect.width,
      pseudoBoxSizing: getComputedStyle(host, '::before').boxSizing,
      pseudoWidth: getComputedStyle(host, '::before').width,
      pseudoTransform: getComputedStyle(host, '::before').transform,
    };
  })()`);
}

async function capturePage(cdpClient, outputPath) {
  const response = await cdpClient.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(outputPath, Buffer.from(response.data, 'base64'));
}

async function captureElement(cdpClient, selector, outputPath, margin = 0) {
  const clip = await evaluate(cdpClient, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return {
      x: Math.max(0, r.x - ${margin}),
      y: Math.max(0, r.y - ${margin}),
      width: Math.min(innerWidth, r.width + ${margin * 2}),
      height: Math.min(innerHeight, r.height + ${margin * 2}),
      scale: 1,
    };
  })()`);
  if (!clip) throw new Error(`Element not found: ${selector}`);
  const response = await cdpClient.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip });
  await writeFile(outputPath, Buffer.from(response.data, 'base64'));
}

async function evaluate(cdpClient, expression) {
  const result = await cdpClient.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed.');
  return result.result?.value;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out after ${timeoutMs} ms.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data || '{}'));
    if (message.id) {
      const deferred = pending.get(message.id);
      pending.delete(message.id);
      if (!deferred) return;
      if (message.error) deferred.reject(new Error(message.error.message || 'CDP command failed.'));
      else deferred.resolve(message.result || {});
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  return {
    send(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    on(method, listener) {
      const current = listeners.get(method) || [];
      current.push(listener);
      listeners.set(method, current);
    },
    close() {
      socket.close();
    },
  };
}
