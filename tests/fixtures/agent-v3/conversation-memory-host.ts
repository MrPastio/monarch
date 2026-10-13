import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { OscarClient } from '../../../src/modules/oscar/client';
import { persistCoordinatorMessage } from '../../../src/app/oscar-turn-runtime';
import type { OscarPersistedMessage } from '../../../src/oscar-turn/coordinator';
import { oscarBridgeMarker } from './oscar-bridge-host';

export interface ConversationHistory {
  id: string; title: string;
  messages: Array<{ id: string; role: string; content: string; client_message_id: string; turn_id: string;
    causal_parent_id: string | null; provenance: Record<string, unknown> }>;
  message_page: { limit: number; returned: number; has_more: boolean; next_before: number | null };
}

/** Real OscarClient -> existing Python append service -> existing SQLite Store.
 * Only the HTTP shell is fixture-specific. No backend/model startup or JSON sink. */
export async function conversationMemoryHost(root: string, additionalConversationIds: string[] = []) {
  const parent = await realpath('.test-tmp');
  if (await realpath(root) !== root || path.dirname(root) !== parent || path.parse(parent).root.toUpperCase() !== 'D:\\'
    || !path.basename(root).startsWith('astra-v3-oscar-') || await readFile(path.join(root, '.fixture-marker'), 'utf8') !== oscarBridgeMarker)
    throw Error('owned-oscar-fixture-required');
  if (additionalConversationIds.length > 16 || additionalConversationIds.some(id => !/^[A-Za-z0-9_]{1,64}$/.test(id)))
    throw Error('fixture-exact-conversation-cohort-required');
  const token = 'astra-synthetic-conversation-only';
  const tokenPath = path.join(root, 'oscar_token.txt');
  try { await writeFile(tokenPath, token, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(tokenPath, 'utf8') !== token) throw error; }
  const child = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', '-u',
    path.resolve('tests/fixtures/agent-v3/conversation-memory-host.py'), root, JSON.stringify(additionalConversationIds)],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEMP: root, TMP: root, PYTHONNOUSERSITE: '1' } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`conversation-memory-exit:${code}:${stderr}`)));
  });
  void exited.catch(() => {});
  let origin: string;
  try {
    origin = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      const timer = setTimeout(() => { child.kill(); reject(Error('conversation-memory-start-timeout:' + stderr)); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(Error('conversation-memory-start-exit:' + stderr)); });
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        if (stdout.length > 4096) { child.kill(); clearTimeout(timer); reject(Error('conversation-memory-start-output')); return; }
        if (!stdout.includes('\n')) return;
        clearTimeout(timer);
        try { const message = JSON.parse(stdout.trim()); const url = new URL(message.origin);
          if (message.marker !== 'synthetic-conversation-memory' || url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.origin !== message.origin)
            throw Error('conversation-memory-origin');
          resolve(message.origin);
        } catch (error) { reject(error); }
      });
    });
  } catch (error) { child.kill(); await exited.catch(() => {}); throw error; }
  const client = new OscarClient({ apiBase: origin, autoStart: false, timeoutMs: 3000,
    projectRoot: root, workspaceRoot: root, secretsRoot: root, logsRoot: root });
  let closePromise: Promise<void> | undefined;
  return { client, origin,
    persist: (message: OscarPersistedMessage) => persistCoordinatorMessage(client, message),
    history: (conversationId = 'conversation', messageLimit = 20, before?: number) =>
      client.getConversation(conversationId, { messageLimit, ...(before === undefined ? {} : { before }) }) as Promise<ConversationHistory>,
    evidence: async () => (await fetch(origin + '/__fixture/evidence', { headers: { Authorization: 'Bearer ' + token } })).json() as Promise<{ requests: string[]; productMainImported: boolean }>,
    close() { return closePromise ??= (async () => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.stdin.end('stop\n');
      try { await exited; } finally { clearTimeout(timer); }
    })(); },
  };
}
