import { describe, expect, it } from 'vitest';
import { plainActivity } from '../../src/ui/public/modules/ui-language.js';
import { createOscarMessage, renderOscarMessage, resolveOscarLiveStatus } from '../../src/ui/public/modules/utils.js';

describe('plain user-facing status', () => {
  it.each([
    ['turn-routing', 'Думает'], ['turn-answer', 'Готовит ответ'],
    ['research-read', 'Изучает'], ['research-search', 'Ищет'],
    ['research-reflect', 'Проверяет'], ['approval-required', 'Ждёт разрешения'],
    ['failed', 'Нужно внимание'], ['cancelled', 'Останавливается'],
  ])('%s has a short truthful label', (phase, label) => expect(plainActivity(phase)).toBe(label));
  it('does not expose internal routing labels from the server', () => {
    const status = resolveOscarLiveStatus({ streamEvents: [{ label: 'Ответ · Локально', detail: 'Agent Runtime SHA256' }] }, 'turn-answer');
    expect(status.label).toBe('Готовит ответ');
    expect(status.detail).toBe('');
  });
  it('shows a running agent task as a plain-language step list', () => {
    const message = createOscarMessage('assistant', '', 'Oscar · Turn', { pending: true, streamPhase: 'agent-tool',
      streamEvents: [{ kind: 'agent-tool', label: 'Читаю файл package.json', activity: { operation: 'read', stepNumber: 3,
        subject: 'Читаю файл package.json', steps: [
          { title: 'Поискал «ASTRA_MAX»', state: 'done' },
          { title: 'Не получилось: переименовываю <b>x</b>', state: 'failed' },
          { title: 'Читаю файл package.json', state: 'active' }] } }] });
    const html = renderOscarMessage(message);
    expect(html).toContain('Oscar работает');
    expect(html).toContain('шаг 3');
    expect(html).toMatch(/is-done[\s\S]*Поискал «ASTRA_MAX»/u);
    expect(html).toMatch(/is-failed[\s\S]*&lt;b&gt;x&lt;\/b&gt;/u);
    expect(html).toMatch(/is-active is-fresh[\s\S]*Читаю файл package\.json/u);
  });
  it('names the running agent step and what it acts on', () => {
    const tool = resolveOscarLiveStatus({ streamEvents: [{ kind: 'agent-tool', label: 'Выполняет шаг 2',
      activity: { operation: 'write', subject: 'tmp/battery/plan.md' } }] }, 'agent-tool');
    expect(tool).toMatchObject({ label: 'Записывает', detail: 'tmp/battery/plan.md' });
    const search = resolveOscarLiveStatus({ streamEvents: [{ kind: 'agent-tool', label: 'Выполняет шаг 1',
      activity: { operation: 'search', subject: 'ASTRA_MAX_CLOUD_CONTEXT_TOKENS' } }] }, 'agent-tool');
    expect(search).toMatchObject({ label: 'Ищет', detail: 'ASTRA_MAX_CLOUD_CONTEXT_TOKENS' });
    const thinking = resolveOscarLiveStatus({ streamEvents: [{ kind: 'agent-thinking', label: 'Выбирает следующий шаг',
      activity: { operation: 'think', subject: 'Сделано шагов: 2' } }] }, 'agent-thinking');
    expect(thinking).toMatchObject({ label: 'Думает', detail: 'Сделано шагов: 2' });
  });
  it('groups memory hints without claiming external sources or hiding the answer', () => {
    const sources = [{ kind: 'memory', url: 'memory://1' }, { kind: 'memory', url: 'memory://2' }];
    const message = createOscarMessage('assistant', 'Токен — технический термин.', 'Oscar · Turn', {
      sources, provenance: { verification: 'source-grounded' }, usage: { total_tokens: 432, elapsed_ms: 2000 },
    });
    const html = renderOscarMessage(message);
    expect(html.match(/Учтена память/g)).toHaveLength(1);
    expect(html).not.toContain('С источниками');
    expect(html).not.toContain('432');
    expect(html).toContain('Токен — технический термин.');
    expect(html).toContain('Завершено за 2с');
    expect(message.sources).toHaveLength(2);
  });
  it('keeps a reloaded certified agent result labelled as confirmed', () => {
    // Persisted Astra results carry system-state provenance plus the certified
    // outcome; the reload used to relabel them as a vague "task state".
    const reloaded = renderOscarMessage(createOscarMessage('assistant', 'Файл создан и прочитан.', 'Oscar', {
      outcome: 'verified', provenance: { origin: 'system', verification: 'system-state' } }));
    expect(reloaded).toContain('Выполнение подтверждено');
    expect(reloaded).not.toContain('Состояние задачи');
    const stopped = renderOscarMessage(createOscarMessage('assistant', 'Задача остановлена.', 'Oscar', {
      outcome: 'cancelled', provenance: { origin: 'system', verification: 'system-state' } }));
    expect(stopped).toContain('Остановлено');
    const answered = renderOscarMessage(createOscarMessage('assistant', 'Мне жаль, что тебе грустно.', 'Oscar', {
      outcome: 'answered', provenance: { origin: 'system', verification: 'system-state' } }));
    expect(answered).toContain('Ответ модели');
    expect(answered).not.toContain('Выполнение подтверждено');
  });
  it('renders a recoverable runtime wait with explicit resume and cancel controls', () => {
    const message = createOscarMessage('assistant', 'Выбранная модель сейчас недоступна.', 'Oscar · ожидание', {
      turnId: 'oscar_turn_runtime_wait',
      outcome: 'waiting-for-runtime',
      action: {
        kind: 'runtime-retry',
        label: 'Повторить',
        agentTaskId: 'agent_task_runtime_wait',
        oscarTurnId: 'oscar_turn_runtime_wait',
      },
    });
    const html = renderOscarMessage(message);
    expect(html).toContain('Задача безопасно приостановлена');
    expect(html).toContain('data-oscar-runtime-action="resume"');
    expect(html).toContain('>Повторить</button>');
    expect(html).toContain('data-oscar-runtime-action="cancel"');
    expect(html).toContain('>Отменить задачу</button>');
  });
});
