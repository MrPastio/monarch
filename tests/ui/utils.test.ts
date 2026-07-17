import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  formatOscarContent,
  parseCodeCanvasesFromText,
  readOscarSources,
  createThinkParser,
  createOscarMessage,
  extractOscarActionProposal,
  replacePendingOscarMessage,
  renderOscarMessage,
  formatOscarWorkDuration,
  summarizeOutput,
  looksLikeAgentAction,
  shouldPreDispatchAgentAction,
  executionNeedsAuthoritativeReceipt,
  looksLikeProtectedAgentAction,
  resolveContextualAgentAction,
  sanitizeVisibleAssistantContent,
  readUserFacingFailure,
} from '../../src/ui/public/modules/utils.js';
import { state } from '../../src/ui/public/modules/state.js';

describe('Oscar UI utils', () => {
  it('prefers the safe execution message over internal diagnostics', () => {
    expect(readUserFacingFailure({
      summary: 'Traceback: local secret',
      userFacing: { message: 'Безопасное сообщение.' },
    }, 'fallback')).toBe('Безопасное сообщение.');
  });

  describe('agent action pre-dispatch', () => {
    beforeEach(() => {
      (globalThis as any).__MONARCH_LEGACY_ACTION_MARKERS__ = true;
    });

    afterEach(() => {
      delete (globalThis as any).__MONARCH_LEGACY_ACTION_MARKERS__;
    });

    it('recognizes natural and explicit tool requests from saved chat regressions', () => {
      expect(looksLikeAgentAction('Просмотри какие названия папок в твоей корневой папке')).toBe(true);
      expect(looksLikeAgentAction('Ты можешь посмотреть какие java файлы находятся на рабочем столе?')).toBe(true);
      expect(looksLikeAgentAction('{"capability":"workspace.files.list","parameters":{"path":"E:\\\\Monarch"}}')).toBe(true);
      expect(looksLikeProtectedAgentAction('Просмотри названия папок в workspace')).toBe(true);
    });

    it('keeps exact workspace-path followups on the authoritative tool route', () => {
      const first = 'Где находится твое рабочее пространство?';
      const context = `${first}\nРабочее пространство находится в корневой директории Monarch Workspace.`;
      const second = resolveContextualAgentAction('укажи путь до него', context);
      const third = resolveContextualAgentAction('более точный путь', `${context}\n${second}`);

      expect(looksLikeAgentAction(first)).toBe(true);
      expect(second).toBe('Укажи точный путь рабочего пространства Monarch');
      expect(third).toBe('Укажи точный путь рабочего пространства Monarch');
      expect(looksLikeAgentAction(second)).toBe(true);
      expect(looksLikeAgentAction(third)).toBe(true);
    });

    it('resolves text-file followups against the last created directory', () => {
      const context = [
        '**Monarch Workspace**',
        'Created directory E:\\Monarch\\Новая папка.',
        '{"path":"E:\\\\Monarch\\\\Новая папка"}',
        'в этой папке сделай текстовый файл',
        'Какой текст ты хочешь поместить в новый текстовый файл?',
      ].join('\n');

      const createEmpty = resolveContextualAgentAction('в этой папке сделай текстовый файл', context);
      const createWithContent = resolveContextualAgentAction('тест валидации', context);

      expect(createEmpty).toBe('создай файл "E:\\Monarch\\Новая папка\\note.txt"');
      expect(createWithContent).toBe('создай файл "E:\\Monarch\\Новая папка\\note.txt" с текстом "тест валидации"');
      expect(looksLikeAgentAction(createWithContent)).toBe(true);
    });

    it('does not pre-dispatch ordinary conversation', () => {
      expect(looksLikeAgentAction('Расскажи, почему небо голубое')).toBe(false);
      expect(looksLikeProtectedAgentAction('Расскажи, почему небо голубое')).toBe(false);
    });

    it('lets Oscar plan natural multi-step actions while keeping explicit capabilities deterministic', () => {
      expect(shouldPreDispatchAgentAction('создай папку, а в папке создай текстовый файл')).toBe(false);
      expect(shouldPreDispatchAgentAction('Создай новую папку в твоем рабочем пространстве назови ее цветок.')).toBe(true);
      expect(shouldPreDispatchAgentAction('{"capability":"workspace.files.mkdir","parameters":{"path":"demo"}}')).toBe(true);
    });

    it('reserves mutation completion text for the verified Kernel receipt', () => {
      expect(executionNeedsAuthoritativeReceipt({
        ok: true,
        metadata: { policy: { riskVector: { effect: 'write' } } },
      })).toBe(true);
      expect(executionNeedsAuthoritativeReceipt({
        ok: true,
        metadata: { policy: { riskVector: { effect: 'read' } } },
      })).toBe(false);
      expect(executionNeedsAuthoritativeReceipt({
        ok: false,
        metadata: { policy: { riskVector: { effect: 'write' } } },
      })).toBe(false);
    });

    it('routes process-audit phrasing and proceed followups into the agent lane', () => {
      const audit = 'Можешь выдать мне аудит по всем текущим процессам на их безопасность.';
      const followup = resolveContextualAgentAction(
        'Приступайте к выполнению всему по очереди',
        `${audit}\nИспользую security.status, environment.inspect и diagnostics.project.report.`,
      );

      expect(looksLikeAgentAction(audit)).toBe(true);
      expect(followup).toContain('аудит безопасности текущих процессов');
      expect(looksLikeAgentAction(followup)).toBe(true);
    });

    it('accepts one flexible hidden Oscar command with a strict proposal envelope', () => {
      const accepted = extractOscarActionProposal('Начинаю. [[MONARCH_COMMAND:{"command":"проверь файл E:\\\\Downloads\\\\x.exe","reason":"пользователь запросил проверку"}]]');
      const rejected = extractOscarActionProposal('Test [[MONARCH_COMMAND:{"command":"удали всё","capabilityId":"workspace.delete"}]]');

      expect(accepted).toMatchObject({
        command: expect.stringContaining('проверь файл'),
        reason: 'пользователь запросил проверку',
        content: 'Начинаю.',
      });
      expect(rejected.command).toBe('');
      expect(rejected.rejected).toEqual(['invalid-command-schema']);
      expect(rejected.content).toBe('Test');

      const plan = extractOscarActionProposal('[[MONARCH_COMMAND:{"commands":[{"capability":"workspace.files.mkdir","parameters":{"path":"Тестовая папка"}},{"capability":"workspace.files.write","parameters":{"path":"Тестовая папка/note.txt","content":""}}],"reason":"Безопасный локальный план"}]]');
      expect(plan.commands.map((command) => JSON.parse(command))).toEqual([
        { capability: 'workspace.files.mkdir', parameters: { path: 'Тестовая папка' } },
        { capability: 'workspace.files.write', parameters: { path: 'Тестовая папка/note.txt', content: '' } },
      ]);
      expect(plan.command).toBe(plan.commands[0]);

      const emptyFilePlan = extractOscarActionProposal('[[MONARCH_COMMAND:{"commands":[{"capability":"workspace.files.mkdir","parameters":{"path":"qa"}},{"capability":"workspace.files.write","parameters":{"path":"qa/a.txt"}},{"capability":"workspace.files.write","parameters":{"path":"qa/b.txt","content":null}}],"reason":"qa"}]]');
      expect(emptyFilePlan.commands.map((command) => JSON.parse(command))).toEqual([
        { capability: 'workspace.files.mkdir', parameters: { path: 'qa' } },
        { capability: 'workspace.files.write', parameters: { path: 'qa/a.txt', content: '' } },
        { capability: 'workspace.files.write', parameters: { path: 'qa/b.txt', content: '' } },
      ]);

      const structuredSingle = extractOscarActionProposal('[[MONARCH_COMMAND:{"command":"workspace.files.mkdir","parameters":{"path":"Кларк"},"reason":"Создать рабочую папку"}]]');
      expect(structuredSingle.rejected).toEqual([]);
      expect(structuredSingle.commands.map((command) => JSON.parse(command))).toEqual([
        { capability: 'workspace.files.mkdir', parameters: { path: 'Кларк' } },
      ]);
    });

    it('never renders a complete or partial hidden Oscar command marker', () => {
      const complete = 'Проверяю статус.\n\n[[MONARCH_COMMAND:{"command":"security.status{}","reason":"Проверить защиту"}]]';
      const partial = 'Проверяю статус.\n\n[[MONARCH_COMMAND:{"command":"security.status';

      expect(sanitizeVisibleAssistantContent(complete).trim()).toBe('Проверяю статус.');
      expect(sanitizeVisibleAssistantContent(partial).trim()).toBe('Проверяю статус.');
      expect(renderOscarMessage(createOscarMessage('assistant', complete, 'Oscar'))).not.toContain('MONARCH_COMMAND');
    });
  });

  describe('formatOscarContent', () => {
    it('escapes HTML properly', () => {
      const input = '<div onclick="alert(1)">test</div>';
      const result = formatOscarContent(input);
      expect(result).not.toContain('<div onclick=');
      expect(result).toContain('&lt;div onclick=&quot;alert(1)&quot;&gt;test&lt;/div&gt;');
    });

    it('renders fenced code inline with a copy control', () => {
      const input = 'Here is code:\n```javascript\nconsole.log(1);\n```';
      const result = formatOscarContent(input);
      expect(result).toContain('<div class="oscar-code-block">');
      expect(result).toContain('javascript');
      expect(result).toContain('Скопировать');
      expect(result).toContain('console.log(1);');
      expect(result).not.toContain('Код вынесен');
    });

    it('renders unclosed streaming code blocks inline safely', () => {
      const input = '```javascript\nconsole.log(1);';
      const result = formatOscarContent(input);
      expect(result).toContain('<div class="oscar-code-block is-streaming">');
      expect(result).toContain('javascript · пишется');
      expect(result).toContain('Скопировать');
      expect(result).toContain('console.log(1);');
      expect(result).not.toContain('Код вынесен');
    });

    it('preserves explicit markdown line breaks in text', () => {
      const input = 'Line 1  \nLine 2';
      const result = formatOscarContent(input);
      expect(result).toContain('Line 1<br>Line 2');
    });

    it('renders headings and ordered and unordered lists as separate blocks', () => {
      const input = '## Физические основы\n\n#### Детали\n\n- Масса\n- Расстояние\n\n1. Первый закон\n2. Второй закон';
      const result = formatOscarContent(input);

      expect(result).toContain('<h2>Физические основы</h2>');
      expect(result).toContain('<h4>Детали</h4>');
      expect(result).toContain('<ul><li>Масса</li><li>Расстояние</li></ul>');
      expect(result).toContain('<ol><li>Первый закон</li><li>Второй закон</li></ol>');
    });

    it('repairs repeated one-markers across explanatory list paragraphs', () => {
      const input = '1. Первый уровень\n\nОписание первого.\n\n1. Второй уровень\n\nОписание второго.\n\n1. Третий уровень';
      const result = formatOscarContent(input);

      expect(result.match(/<ol(?:\s|>)/g)).toHaveLength(3);
      expect(result).toContain('<li>Первый уровень</li>');
      expect(result).toContain('<ol start="2"><li>Второй уровень</li></ol>');
      expect(result).toContain('<ol start="3"><li>Третий уровень</li></ol>');
      expect(result).toContain('<li>Второй уровень</li>');
      expect(result).toContain('<li>Третий уровень</li>');
      expect(result).not.toContain('1. Второй уровень');
    });

    it('formats display and inline math without exposing raw delimiters', () => {
      const input = 'Формула $r^2$:\n\n$$F = G \\frac{m_1 m_2}{r^2}, \\text{Н}$$';
      const result = formatOscarContent(input);

      expect(result).toContain('class="oscar-math-inline"');
      expect(result).toContain('class="oscar-math-block"');
      expect(result).toContain('class="oscar-math-frac"');
      expect(result).toContain('<sub>1</sub>');
      expect(result).toContain('<sup>2</sup>');
      expect(result).toContain('<span class="oscar-math-text">Н</span>');
      expect(result).not.toContain('$$');
    });

    it('upgrades plain quadratic formulas to a real fraction and math operators', () => {
      const result = formatOscarContent('x = (-b +/- sqrt(b^2 - 4*a*c)) / (2*a)');

      expect(result).toContain('class="oscar-math-block"');
      expect(result).toContain('class="oscar-math-frac"');
      expect(result).toContain('class="oscar-math-sqrt"');
      expect(result).toContain('±');
      expect(result).toContain('×');
      expect(result).not.toContain(' / ');
      expect(result).not.toContain('*');
    });

    it('renders nested LaTeX fractions and roots recursively', () => {
      const result = formatOscarContent('$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$');

      expect(result).toContain('class="oscar-math-frac"');
      expect(result).toContain('class="oscar-math-sqrt"');
      expect(result).toContain('<sup>2</sup>');
      expect(result).toContain('±');
    });

    it('renders markdown tables as accessible structured HTML', () => {
      const input = '| Система | Статус |\n|---|:---:|\n| Monarch Kernel | **Готов** |\n| Monarch Security | Проверка |';
      const result = formatOscarContent(input);

      expect(result).toContain('<table class="oscar-table">');
      expect(result).toContain('<th>Система</th>');
      expect(result).toContain('<td>Monarch Kernel</td>');
      expect(result).toContain('<td><strong>Готов</strong></td>');
      expect(result).not.toContain('|---|');
    });
  });

  it('shows the concrete model next to answer usage', () => {
    const message = createOscarMessage('assistant', 'Ответ', 'Medium', {
      usage: { model_tier: 'gemma4-balanced', total_tokens: 321, elapsed_ms: 2400 },
    });
    const html = renderOscarMessage(message);

    expect(html).toContain('Medium · 321 токен');
    expect(html).toContain('Завершено за 2с');
    expect(html).not.toContain('Medium · 321 токенов ·');
  });

  it('formats the live work timer from seconds through days', () => {
    expect(formatOscarWorkDuration(12_000)).toBe('12с');
    expect(formatOscarWorkDuration(188_000)).toBe('3м 08с');
    expect(formatOscarWorkDuration(3_840_000)).toBe('1ч 04м');
    expect(formatOscarWorkDuration(93_600_000)).toBe('1д 2ч');
  });

  describe('parseCodeCanvasesFromText', () => {
    it('extracts complete and streaming fenced code blocks', () => {
      const complete = parseCodeCanvasesFromText('```ts\nconst ok = true;\n```', 'Oscar');
      expect(complete).toEqual([
        {
          language: 'ts',
          code: 'const ok = true;\n',
          sourceLabel: 'Oscar',
          complete: true,
        },
      ]);

      const streaming = parseCodeCanvasesFromText('```python\nprint(1)', 'Oscar');
      expect(streaming[0]).toMatchObject({
        language: 'python',
        code: 'print(1)',
        complete: false,
      });
    });
  });

  describe('readOscarSources', () => {
    it('deduplicates sources by exact url or string', () => {
      const response = {
        sources: [
          'http://example.com/1',
          { url: 'http://example.com/1' },
          { url: 'http://example.com/2', title: 'Example 2' },
          'http://example.com/2'
        ]
      };
      const result = readOscarSources(response);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('http://example.com/1');
      expect(result[1]).toEqual({ url: 'http://example.com/2', title: 'Example 2' });
    });

    it('returns empty array if no sources', () => {
      expect(readOscarSources(null)).toEqual([]);
      expect(readOscarSources({})).toEqual([]);
    });
  });

  describe('createThinkParser', () => {
    it('parses full think block', () => {
      const parser = createThinkParser();
      parser.processChunk('<think>abc</think>hello');
      expect(parser.getReasoning(true)).toBe('abc');
      expect(parser.getContent(true)).toBe('hello');
    });

    it('parses split chunks', () => {
      const parser = createThinkParser();
      parser.processChunk('<thi');
      parser.processChunk('nk>abc');
      parser.processChunk('</think>hello');
      expect(parser.getReasoning(true)).toBe('abc');
      expect(parser.getContent(true)).toBe('hello');
    });

    it('handles unclosed think block', () => {
      const parser = createThinkParser();
      parser.processChunk('<think>abc');
      expect(parser.getReasoning(true)).toBe('abc');
      expect(parser.getContent(true)).toBe('');
    });

    it('handles normal answer', () => {
      const parser = createThinkParser();
      parser.processChunk('hello');
      expect(parser.getReasoning(true)).toBe('');
      expect(parser.getContent(true)).toBe('hello');
    });

    it('handles multiple blocks', () => {
      const parser = createThinkParser();
      parser.processChunk('1<think>a</think>2<think>b</think>3');
      expect(parser.getReasoning(true)).toBe('ab');
      expect(parser.getContent(true)).toBe('123');
    });
  });

  describe('renderOscarMessage', () => {
    it('preserves one message id across all pending stream updates', () => {
      const previousMessages = state.oscar.messages;
      const pending = createOscarMessage('assistant', '', 'Fast', { pending: true });
      state.oscar.messages = [pending];

      try {
        replacePendingOscarMessage(createOscarMessage('assistant', 'Первый фрагмент', 'Fast', { pending: true }));
        replacePendingOscarMessage(createOscarMessage('assistant', 'Второй фрагмент', 'Fast', { pending: true }));

        expect(state.oscar.messages).toHaveLength(1);
        expect(state.oscar.messages[0]?.id).toBe(pending.id);
        expect(state.oscar.messages[0]?.createdAt).toBe(pending.createdAt);
        expect(state.oscar.messages[0]?.content).toBe('Второй фрагмент');
      } finally {
        state.oscar.messages = previousMessages;
      }
    });

    it('renders reasoning block but excludes it from main content', () => {
      const msg = createOscarMessage('assistant', 'Main Answer', 'test', {
        reasoning: 'Deep thoughts',
        showTrace: true,
      });
      const html = renderOscarMessage(msg);
      
      // Should contain the details block
      expect(html).toContain('<details class="oscar-reasoning-block"');
      expect(html).toContain('Deep thoughts');
      
      // Should contain main answer
      expect(html).toContain('Main Answer');
      
      // The reasoning and main answer should be in different divs
      expect(html).toMatch(/<div class="oscar-reasoning-content"[^>]*>Deep thoughts<\/div>/);
      expect(html).toMatch(/<div class="message-text"[^>]*>.*Main Answer.*<\/div>/s);
    });

    it('keeps internal reasoning hidden in ordinary answers', () => {
      const msg = createOscarMessage('assistant', 'Краткий итог', 'test', {
        reasoning: 'Internal trace',
      });
      const html = renderOscarMessage(msg);

      expect(html).toContain('Краткий итог');
      expect(html).not.toContain('Internal trace');
      expect(html).not.toContain('oscar-reasoning-block');
    });

    it('renders quiet usage metrics plus copy and speech actions for completed answers', () => {
      const msg = createOscarMessage('assistant', 'Готовый ответ', 'test', {
        usage: { total_tokens: 1536, elapsed_ms: 2480, estimated: true },
      });
      const html = renderOscarMessage(msg);

      expect(html).toContain('data-message-copy');
      expect(html).toContain('Копировать ответ Oscar');
      expect(html).toContain(`data-message-speak="${msg.id}"`);
      expect(html).toContain('Озвучить весь ответ Oscar');
      expect(html).toContain('oscar-message-usage');
      expect(html).toContain('≈1\u00a0536 токенов');
      expect(html).toContain('Завершено за 2с');
    });

    it('renders copy and edit actions for a user message', () => {
      const msg = createOscarMessage('user', 'Исправь этот вопрос', 'ты');
      const html = renderOscarMessage(msg);

      expect(html).toContain('data-message-copy');
      expect(html).toContain('data-message-edit');
      expect(html).toContain('Редактировать сообщение');
    });

    it('renders pending stream events safely', () => {
      const msg = createOscarMessage('assistant', 'Жду ответ', 'test', {
        pending: true,
        showTrace: true,
        streamEvents: [
          {
            kind: 'status',
            label: '<img src=x onerror=alert(1)>',
            detail: 'bad" onmouseover="alert(1)'
          }
        ]
      });
      const html = renderOscarMessage(msg);

      expect(html).not.toContain('data-message-speak');
      expect(html).toContain('data-oscar-work-timer');
      expect(html).toContain('Работает ');
      expect(html).toContain('oscar-stream-trace');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('onmouseover="alert(1)');
    });

    it('renders bounded deep-research phases as visible activity, not hidden reasoning', () => {
      const phases = [
        ['research-reflect', 'Проверяю полноту', 'Ищу пробелы и противоречия'],
        ['research-revise', 'Пересобираю вывод', 'Уточняю ответ с новым контекстом'],
        ['research-finalize', 'Формирую итог', 'Собираю полный детальный ответ'],
        ['research-plan', 'Планирую исследование', 'Разделяю вопрос на проверяемые направления'],
        ['research-search', 'Исследую источники', 'Ищу независимые подтверждения'],
        ['research-read', 'Читаю материалы', 'Собираю факты и противоречия'],
        ['research-synthesize', 'Синтезирую вывод', 'Отделяю факты от сценариев'],
        ['research-verify', 'Проверяю вывод', 'Сверяю утверждения и ссылки'],
      ];

      for (const [streamPhase, label, hint] of phases) {
        const html = renderOscarMessage(createOscarMessage('assistant', '', 'Pro', {
          pending: true,
          streamPhase,
          streamEvents: [{ kind: streamPhase, label }],
        }));
        expect(html).toContain(`data-stream-phase="${streamPhase}"`);
        expect(html).toContain(label);
        expect(html).toContain(hint);
        expect(html).not.toContain('oscar-reasoning-block');
      }
    });

    it('renders route consent inside the pending Oscar answer with the full research timeline', () => {
      const html = renderOscarMessage(createOscarMessage('assistant', '', 'Oscar', {
        pending: true,
        streamPhase: 'research-consent',
        researchFlow: true,
        routeConsent: {
          webSearch: true,
          pro: false,
          title: 'Нужно интернет-исследование',
          description: 'Oscar проверит вывод в несколько проходов.',
          denyLabel: 'Ответить без исследования',
          allowLabel: 'Начать исследование',
          state: 'waiting',
        },
      }));

      expect(html).toContain('route-consent research-flow');
      expect(html).toContain('oscar-inline-consent');
      expect(html).toContain('data-oscar-route-decision="deny"');
      expect(html).toContain('data-oscar-route-decision="allow"');
      expect(html).toContain('aria-label="Этапы исследования"');
      expect(html).toContain('Публичные источники');
      expect(html).toContain('Только один ответ');
      expect(html).not.toContain('aria-modal="true"');
    });

    it('keeps completed, current and upcoming research stages visible in one stable card', () => {
      const html = renderOscarMessage(createOscarMessage('assistant', '', 'Medium', {
        pending: true,
        researchFlow: true,
        streamPhase: 'research-reflect',
      }));

      expect(html).toContain('assistant pending  research-flow');
      expect(html).toContain('data-step-state="complete"');
      expect(html).toContain('data-step-state="current" aria-current="step"');
      expect(html).toContain('data-step-state="upcoming"');
      expect(html).toContain('Проверяю полноту');
      expect(html).toContain('План');
      expect(html).toContain('Итог');
    });

    it('renders an explicit Security override action when a block is removable', () => {
      const msg = createOscarMessage('assistant', 'Security заблокировал действие.', 'Monarch Security', {
        action: {
          text: 'выполни команду',
          confirmationToken: 'token',
          risk: 'blocked',
          label: 'Снять блокировку и продолжить',
        },
      });
      const html = renderOscarMessage(msg);

      expect(html).toContain('Снять блокировку и продолжить');
      expect(html).toContain('data-oscar-confirm-action');
    });

    it('keeps pending answer text in one stable plain-text node until the stream finishes', () => {
      const pending = createOscarMessage('assistant', '**Пишется ответ**\n<script>alert(1)</script>', 'Fast', {
        pending: true,
      });
      const completed = createOscarMessage('assistant', '**Готовый ответ**', 'Fast');

      const pendingHtml = renderOscarMessage(pending);
      const completedHtml = renderOscarMessage(completed);

      expect(pendingHtml).toContain('oscar-streaming-text');
      expect(pendingHtml).toContain('**Пишется ответ**\n&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(pendingHtml).not.toContain('<strong>Пишется ответ</strong>');
      expect(completedHtml).not.toContain('oscar-streaming-text');
      expect(completedHtml).toContain('<strong>Готовый ответ</strong>');
    });

    it('hides unfenced service JSON in assistant messages', () => {
      const msg = createOscarMessage('assistant', [
        'Monarch Skills',
        '',
        '{ "mode": "planned-local-bridge", "oscar": { "projectRoot": "E:\\\\Monarch\\\\oscar", "apiBase": "http://127.0.0.1:7861", "knownEndpoints": ["GET /api/health"] }, "monarch": { "astraCapabilities": ["astra.skills.index"] } }',
      ].join('\n'), 'test');
      const html = renderOscarMessage(msg);

      expect(html).toContain('Monarch Skills');
      expect(html).toContain('Служебные детали скрыты.');
      expect(html).not.toContain('planned-local-bridge');
      expect(html).not.toContain('apiBase');
      expect(html).not.toContain('knownEndpoints');
      expect(html).not.toContain('astraCapabilities');
    });

    it('hides truncated service JSON in assistant messages', () => {
      const msg = createOscarMessage('assistant', [
        'Astra/Oscar bridge contract described.',
        '',
        '{ "mode": "planned-local-bridge", "oscar": { "projectRoot": "E:\\\\Monarch\\\\oscar", "apiBase": "http://127.0.0.1:7861", "knownEndpoints": ["GET /api/health"] }, "monarch": { "astraCapabilities": ["astra.skills.index"',
      ].join('\n'), 'test');
      const html = renderOscarMessage(msg);

      expect(html).toContain('Astra/Oscar bridge contract described.');
      expect(html).toContain('Служебные детали скрыты.');
      expect(html).not.toContain('planned-local-bridge');
      expect(html).not.toContain('apiBase');
      expect(html).not.toContain('knownEndpoints');
      expect(html).not.toContain('astraCapabilities');
    });

    it('keeps fenced JSON code visible', () => {
      const msg = createOscarMessage('assistant', '```json\n{ "apiBase": "http://127.0.0.1:7861" }\n```', 'test');
      const html = renderOscarMessage(msg);

      expect(html).toContain('apiBase');
      expect(html).toContain('oscar-code-block');
      expect(html).not.toContain('Служебные детали скрыты.');
    });
  });

  describe('summarizeOutput', () => {
    it('turns Security status payloads into a readable Russian summary', () => {
      const summary = summarizeOutput({ payload: {
        running: true,
        protection_state: 'protected',
        profile: { level: 'balanced', label: 'Средний' },
        heartbeat: { sensor_count: 8 },
        incidents: { open: 0, decision_required: 0 },
        model_policy: { enabled: true, confirmation_mode: 'adaptive' },
      } });

      expect(summary).toContain('Monarch Security работает штатно');
      expect(summary).toContain('Профиль: Средний');
      expect(summary).toContain('Активных датчиков: 8');
      expect(summary).toContain('Открытых инцидентов: 0');
      expect(summary).toContain('Команды Oscar: разрешены · подтверждение по уровню риска');
      expect(summary).not.toContain('"payload"');
    });
  });

  describe('summarizeOutput', () => {
    it('summarizes Security Network Center without exposing raw connection records', () => {
      const result = summarizeOutput({
        payload: {
          summary: {
            active_connections: 36,
            listeners: 33,
            neighbors: 1,
            profiles: 3,
            untrusted_profiles: 3,
            high_attention: 0,
          },
          connections: [{ facts: { remote_address: '203.0.113.5' } }],
        },
      });

      expect(result).toContain('Опасных сетевых подключений с высоким уровнем риска не обнаружено.');
      expect(result).toContain('Активных подключений: 36');
      expect(result).not.toContain('203.0.113.5');
      expect(result).not.toContain('remote_address');
    });

    it('summarizes a process system scan without dumping assessments or command lines', () => {
      const result = summarizeOutput({
        payload: {
          summary: { events: 12, high_or_higher: 1 },
          scans: [{
            name: 'processes', events: 2,
            results: [
              { assessment: { score: 5, event: { subject: 'C:\\Windows\\explorer.exe' } } },
              { assessment: { score: 70, event: { subject: 'C:\\Temp\\suspicious.exe', facts: { cmdline: ['secret'] } } } },
            ],
          }],
        },
      });

      expect(result).toContain('Обнаружены процессы, требующие дополнительной проверки.');
      expect(result).toContain('Проверено текущих процессов: 2');
      expect(result).toContain('suspicious.exe');
      expect(result).not.toContain('cmdline');
      expect(result).not.toContain('secret');
    });


    it('summarizes capability lists without dumping raw JSON', () => {
      const result = summarizeOutput({
        capabilities: [
          { id: 'workspace.files.read', risk: 'read' },
          { id: 'diagnostics.capabilities.list', risk: 'read' },
        ],
      });

      expect(result).toContain('2 возможности');
      expect(result).toContain('- workspace.files.read · read');
      expect(result).not.toContain('"inputSchema"');
    });

    it('summarizes workspace search and file read outputs', () => {
      const search = summarizeOutput({
        query: 'AssistantModule',
        matches: [
          { path: 'E:\\Monarch\\src\\modules\\assistant\\index.ts', line: 12, preview: 'class AssistantModule' },
        ],
      });
      const read = summarizeOutput({
        path: 'E:\\Monarch\\package.json',
        sizeBytes: 42,
        content: '{"name":"monarch"}',
      });

      expect(search).toContain('1 совпадение по "AssistantModule"');
      expect(search).toContain('src/modules/assistant/index.ts:12');
      expect(read).toContain('Файл: Monarch/package.json · 42 байт');
      expect(read).toContain('{"name":"monarch"}');
    });

    it('renders the authoritative workspace root without raw JSON', () => {
      const result = summarizeOutput({ workspaceRoot: 'E:\\Monarch' });

      expect(result).toBe('Точный путь рабочего пространства: `E:\\Monarch`');
      expect(result).not.toContain('"workspaceRoot"');
    });

    it('summarizes path-only workspace outputs without raw JSON', () => {
      const result = summarizeOutput({ path: 'E:\\Monarch\\Новая папка', bytes: 0 });

      expect(result).toContain('Путь: `E:\\Monarch\\Новая папка`');
      expect(result).toContain('0 байт');
      expect(result).not.toContain('"path"');
    });
  });
});
