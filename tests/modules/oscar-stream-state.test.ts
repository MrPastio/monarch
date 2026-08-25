import { describe, expect, it } from 'vitest';
import { appendStreamEvent, appendStreamToken, finalizeStreamMessage, recoverUnfinishedStreamMessage } from '../../oscar/frontend/src/App';
import type { UiMessage } from '../../oscar/frontend/src/types';

describe('Oscar stream message state', () => {
  it('preserves partial content but never marks a stream without done as successful', () => {
    const recovered = recoverUnfinishedStreamMessage(createMessage('partial answer '));

    expect(recovered.pending).toBe(false);
    expect(recovered.streamStatus).toBe('не завершено');
    expect(recovered.streamOk).toBe(false);
    expect(recovered.content).toBe('partial answer');
    expect(recovered.streamEvents?.at(-1)).toMatchObject({
      kind: 'error',
      label: 'поток без финала',
    });
  });

  it('shows a fallback message when an unfinished stream has no content', () => {
    const recovered = recoverUnfinishedStreamMessage(createMessage(''));

    expect(recovered.pending).toBe(false);
    expect(recovered.content).toContain('Поток ответа завершился без финального события');
    expect(recovered.content).toContain('Можно повторить запрос');
    expect(recovered.streamEvents?.at(-1)?.label).toBe('поток без финала');
  });

  it('deduplicates repeated live trace events', () => {
    const started = appendStreamEvent(createMessage(''), { kind: 'status', label: 'Готовлю контекст' }, 1000);
    const updated = appendStreamEvent(started, { kind: 'status', label: 'Готовлю контекст' }, 2000);

    expect(updated.streamEvents).toHaveLength(1);
    expect(updated.streamEvents?.[0]).toMatchObject({
      label: 'Готовлю контекст',
      at: 2000,
      count: 2,
    });
  });

  it('keeps only the latest six live trace events', () => {
    let message = createMessage('');
    for (let index = 0; index < 8; index += 1) {
      message = appendStreamEvent(message, { kind: 'status', label: `step ${index}` }, 1000 + index);
    }

    expect(message.streamEvents).toHaveLength(6);
    expect(message.streamEvents?.[0].label).toBe('step 2');
    expect(message.streamEvents?.at(-1)?.label).toBe('step 7');
  });

  it('records the first visible token in live trace once', () => {
    const first = appendStreamToken(createMessage(''), 'Привет ');
    const second = appendStreamToken(first, 'мир');

    expect(second.content).toBe('Привет мир');
    expect(second.streamTokens).toBe(2);
    expect(second.streamEvents?.filter((event) => event.kind === 'token')).toHaveLength(1);
    expect(second.streamEvents?.[0].label).toBe('пошел текст');
  });

  it('marks a rejected stream as unfinished instead of calling it fallback', () => {
    const finalized = finalizeStreamMessage(createMessage('partial answer'), false, {
      generation_stop_reason: 'error',
      partial: true,
    });

    expect(finalized.pending).toBe(false);
    expect(finalized.streamOk).toBe(false);
    expect(finalized.streamStatus).toBe('не завершено');
    expect(finalized.content).toBe('partial answer');
    expect(finalized.streamEvents?.at(-1)).toMatchObject({
      kind: 'error',
      label: 'ответ не завершён',
      detail: 'локальная генерация завершилась с ошибкой',
    });
  });

  it('rejects contradictory ok=true when usage says the output hit its token limit', () => {
    const finalized = finalizeStreamMessage(createMessage('bounded answer'), true, {
      generation_stop_reason: 'length',
      likely_truncated: true,
    });

    expect(finalized.streamOk).toBe(false);
    expect(finalized.streamStatus).toBe('не завершено');
    expect(finalized.streamEvents?.at(-1)).toMatchObject({
      kind: 'error',
      detail: 'достигнут лимит генерации',
    });
  });

  it('renders an empty cancelled terminal as stopped without inventing an answer', () => {
    const finalized = finalizeStreamMessage(createMessage(''), false, {
      generation_stop_reason: 'cancelled',
    });

    expect(finalized.streamOk).toBe(false);
    expect(finalized.streamStatus).toBe('остановлено');
    expect(finalized.content).toBe('Остановлено.');
  });

  it('marks normal stream completion as ready', () => {
    const finalized = finalizeStreamMessage(createMessage('normal answer'), true);

    expect(finalized.pending).toBe(false);
    expect(finalized.streamOk).toBe(true);
    expect(finalized.streamStatus).toBe('готово');
    expect(finalized.streamEvents?.at(-1)).toMatchObject({
      kind: 'done',
      label: 'ответ готов',
    });
  });
});

function createMessage(content: string): UiMessage {
  return {
    id: 'assistant',
    role: 'assistant',
    content,
    pending: true,
  };
}
