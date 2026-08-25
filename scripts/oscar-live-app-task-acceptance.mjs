import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const debugPort = Number(process.env.MONARCH_UI_QA_DEBUG_PORT || 9224);
const outputRoot = path.resolve(process.env.MONARCH_UI_QA_ROOT || 'E:\\MonarchQA\\oscar-live-app-task');
const prompt = String(process.env.MONARCH_UI_QA_PROMPT || 'открой Figma').trim();
const expectedApp = String(process.env.MONARCH_UI_QA_EXPECTED_APP || 'Figma').trim();
const expectedAnswerText = String(process.env.MONARCH_UI_QA_EXPECTED_TEXT || expectedApp).trim();
const timeoutMs = Number(process.env.MONARCH_UI_QA_TIMEOUT_MS || 90_000);
const startNewChat = process.env.MONARCH_UI_QA_NEW_CHAT !== '0';

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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 984,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(async () => Boolean(await evaluate(cdp, `Boolean(document.querySelector('#oscar-input') && document.readyState === 'complete')`)), 20_000);
  await evaluate(cdp, `(() => {
    const startup = document.querySelector('#startup-motion');
    if (startup) startup.style.display = 'none';
    document.querySelector('[data-view="oscar-section"]')?.click();
    return true;
  })()`);
  if (startNewChat) {
    await evaluate(cdp, `(() => {
      document.querySelector('#oscar-clear')?.click();
      return true;
    })()`);
    await delay(500);
  }

  const permission = await evaluate(cdp, `(async () => {
    const target = document.querySelector('[data-computer-use-permission="full"]');
    target?.click();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && target?.getAttribute('aria-checked') !== 'true') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const token = document.querySelector('meta[name="monarch-api-token"]')?.getAttribute('content') || '';
    const response = await fetch('/api/permissions', { headers: {
      ...(token ? { Authorization: 'Bearer ' + token, 'X-Monarch-Session': token } : {}),
    } });
    const payload = await response.json();
    return {
      status: response.status,
      sandboxMode: payload?.profile?.sandboxMode || '',
      approvalPolicy: payload?.profile?.approvalPolicy || '',
      autonomyMode: payload?.profile?.autonomyMode || '',
    };
  })()`);

  const baseline = await evaluate(cdp, `({
    userCount: document.querySelectorAll('.oscar-message.user').length,
    assistantCount: document.querySelectorAll('.oscar-message.assistant').length,
  })`);
  const startedAt = Date.now();
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#oscar-input');
    const form = document.querySelector('#oscar-composer');
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: document.querySelector('#oscar-send') }));
    return true;
  })()`);

  await waitFor(async () => evaluate(cdp, `(() => {
    const users = [...document.querySelectorAll('.oscar-message.user .message-text')];
    const submitted = users.length > ${baseline.userCount}
      && users.at(-1)?.textContent.trim() === ${JSON.stringify(prompt)};
    const assistants = [...document.querySelectorAll('.oscar-message.assistant')];
    const last = assistants.at(-1);
    return submitted
      && assistants.length > ${baseline.assistantCount}
      && Boolean(last && !last.classList.contains('pending'));
  })()`), timeoutMs);

  const result = await evaluate(cdp, `(() => {
    const assistants = [...document.querySelectorAll('.oscar-message.assistant')];
    const last = assistants.at(-1);
    const control = document.querySelector('#computer-use-control');
    return {
      answer: last?.querySelector('.message-text')?.textContent?.trim() || '',
      error: last?.classList.contains('error') || false,
      pending: last?.classList.contains('pending') || false,
      provenance: last?.querySelector('.message-provenance, .oscar-provenance')?.textContent?.trim() || '',
      computerUseState: control?.dataset.state || '',
      computerUseVisible: Boolean(control && getComputedStyle(control).visibility !== 'hidden' && Number(getComputedStyle(control).opacity) > 0),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  })()`);
  const appSlug = expectedApp.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'app';
  const screenshot = path.join(outputRoot, `oscar-open-${appSlug}-result.png`);
  const capture = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(screenshot, Buffer.from(capture.data, 'base64'));

  const report = {
    ok: !result.error
      && !result.pending
      && result.answer.toLocaleLowerCase('en-US').includes(expectedAnswerText.toLocaleLowerCase('en-US')),
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    prompt,
    expectedApp,
    expectedAnswerText,
    startNewChat,
    permission,
    result,
    consoleMessages,
    screenshot,
    target: { title: target.title, url: target.url },
  };
  await writeFile(path.join(outputRoot, `evidence-${appSlug}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputRoot, 'evidence.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  cdp.close();
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

async function waitFor(predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out after ${timeout} ms.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data));
    if (payload.id) {
      const request = pending.get(payload.id);
      if (!request) return;
      pending.delete(payload.id);
      if (payload.error) request.reject(new Error(payload.error.message || 'CDP request failed.'));
      else request.resolve(payload.result || {});
      return;
    }
    for (const listener of listeners.get(payload.method) || []) listener(payload.params || {});
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
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
