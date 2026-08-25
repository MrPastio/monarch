import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OscarClient } from '../src/modules/oscar/client';
import { buildOscarTurnAnswerRequest } from '../src/app/oscar-turn-runtime';

const root = path.resolve(process.env.MONARCH_OSCAR_SOCIAL_QA_ROOT || 'E:\\MonarchQA\\oscar-compact-social');
await mkdir(root, { recursive: true });
const prompt = 'Как тебе новый Computer Use?';
const client = new OscarClient({
  workspaceRoot: process.cwd(),
  projectRoot: path.join(process.cwd(), 'oscar'),
  chatTimeoutMs: 180_000,
});
const status = await client.status({ autoStart: true });
if (!status.connected) throw new Error(`Real Oscar backend is unavailable: ${status.error || 'unknown error'}`);

const startedAt = Date.now();
const turnId = `social_turn_${Date.now()}`;
const request = buildOscarTurnAnswerRequest({
  turn: {
    id: turnId,
    conversationId: `compact-social-qa-${Date.now()}`,
    inputMessageId: `social_message_${Date.now()}`,
    privacyMode: 'incognito',
    request: {
      text: prompt,
      history: [],
      attachmentIds: [],
      modifiers: {
        computerUseCapability: {
          schemaVersion: 1,
          available: true,
          enabled: false,
          surface: 'computer-use',
          invocation: '@Computer Use',
          ownCursor: true,
          observeAnalyzeAct: true,
          emergencyShortcut: 'Ctrl+Alt+Escape',
        },
      },
    },
  },
  attachments: [],
} as any);
request.reasoning_effort = 'low';
request.requested_model = 'gemma4-fast';
request.model_selection_source = 'user-explicit';
request.max_new_tokens = 256;
request.temperature = 0.2;
request.top_p = 0.9;
const payload = await client.chat(request) as Record<string, unknown>;
const answer = String(payload.answer || '').trim();
if (!answer) throw new Error('Real compact-social response was empty.');
if (answer.length > 700) throw new Error(`Compact-social response is unexpectedly long (${answer.length} chars).`);
if (/что именно (?:тебя интересует|ты хочешь)|что ты хочешь сделать|в этом новом использовании/iu.test(answer)) {
  throw new Error(`Compact-social response fell back to the former generic loop: ${answer}`);
}
if (/(?:я чувствую,? что|новые возможности)/iu.test(answer)) {
  throw new Error(`Compact-social response remained vague instead of giving a grounded opinion: ${answer}`);
}
const concreteFactGroups = [
  /(?:скрин\w*|сним\w*|наблюд\w*|анализ\w*|вид(?:ит|еть|им)\w*\s+(?:окн|экран))/iu,
  /(?:курсор\w*|клик\w*|ввод\w*|клавиш\w*|прокрут\w*|действ\w*)/iu,
  /(?:останов\w*|кнопк\w*\s+stop|ctrl\s*\+\s*alt|kernel\w*|action\s+guard|receipt\w*|провер\w*)/iu,
];
const groundedFactGroups = concreteFactGroups.filter((pattern) => pattern.test(answer)).length;
if (groundedFactGroups < 2) {
  throw new Error(`Compact-social response used only ${groundedFactGroups} concrete capability groups: ${answer}`);
}

const evidence = {
  ok: true,
  generatedAt: new Date().toISOString(),
  prompt,
  answer,
  answerChars: answer.length,
  groundedFactGroups,
  elapsedMs: Date.now() - startedAt,
  contextProfile: 'compact-social',
  useMemory: false,
  trustedComputerUseCapability: true,
  requestedModel: 'gemma4-fast',
  backend: {
    connected: status.connected,
    apiBase: status.apiBase,
    modelStatus: status.modelStatus,
  },
  usage: payload.usage || null,
  sources: Array.isArray(payload.sources) ? payload.sources.length : 0,
};
const evidencePath = path.join(root, `evidence-${Date.now()}.json`);
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath }, null, 2)}\n`);
