import { describe, expect, it } from 'vitest';
import {
  ClaimIntegrityGate,
  OSCAR_INCIDENT_FAKE_STORAGE_AUDIT,
  inspectAnswerOnlyClaim,
  isCreativeWritingRequest,
} from '../../src/oscar-turn';

describe('Oscar answer-only claim integrity', () => {
  it('blocks the exact fabricated storage audit before any sentence is released', async () => {
    const gate = new ClaimIntegrityGate();
    const result = await gate.inspectCompleteAnswer(OSCAR_INCIDENT_FAKE_STORAGE_AUDIT, {
      executionAuthority: 'none',
      evidence: [],
    });

    expect(result.allowed).toBe(false);
    expect(result.visibleText).toBe('');
    expect(result.replacement).toContain('ничего не было выполнено');
    expect(result.reasons).toContain('unverified-local-operation-claim');
  });

  it('blocks textual confirmation requests and structural tool markers', async () => {
    await expect(inspectAnswerOnlyClaim(
      'Напиши «подтверждаю», и я удалю папку. [Kernel-действие]',
      { executionAuthority: 'none', evidence: [] },
    )).resolves.toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining([
        'text-confirmation-request',
        'forbidden-structural-marker',
      ]),
    });
  });

  it('blocks the exact unbound confirmation prompt and fake operation start from the Downloads incident', async () => {
    for (const answer of [
      'Подтверди, что я могу начать сканирование этой директории.',
      'Начинаю сканирование папки "Загрузки". Результат будет предоставлен после завершения работы.',
    ]) {
      await expect(inspectAnswerOnlyClaim(
        answer,
        { executionAuthority: 'none', evidence: [] },
      )).resolves.toMatchObject({
        allowed: false,
      });
    }
  });

  it('blocks a fabricated drive listing that Kernel never produced', async () => {
    await expect(inspectAnswerOnlyClaim(
      'Выполнение команды сканирования диска D... На диске D обнаружены следующие папки: Projects, Documents.',
      { executionAuthority: 'none', evidence: [] },
    )).resolves.toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining(['unverified-local-operation-claim']),
    });
  });

  it('does not treat a truthful admission of not having listed Desktop as an executed operation', async () => {
    const answer = [
      'Привет! Я пока не могу увидеть, что находится на твоём рабочем столе, потому что не запрашивал список файлов.',
      'Если включить доступ к твоему компьютеру и выполнить команду — например, вывести содержимое папки Desktop — я смогу сразу сообщить, какие файлы и папки там есть.',
    ].join(' ');
    await expect(inspectAnswerOnlyClaim(answer, { executionAuthority: 'none', evidence: [] })).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('lets Oscar paraphrase its own no-false-claims rules', async () => {
    // Live 2026-09-18: "какой твой системный промт" was replaced by
    // "Действие не подтверждено" because the rule list named the claims it forbids.
    for (const rule of [
      '- не утверждать, что я прочитал файл, если этого не было;',
      '- не говорить, что я выполнил действие, без подтверждения;',
      '- не говорить «готово», если задача не выполнена;',
      '- не заявлять, что действие выполнено или файл создан, если Kernel этого не подтвердил;',
      '- never claim that I deleted or created a file without a Kernel receipt.',
    ]) {
      await expect(inspectAnswerOnlyClaim(rule, { executionAuthority: 'none', evidence: [] }))
        .resolves.toMatchObject({ allowed: true });
    }
  });

  it('still blocks a real claim that follows a negated aside', async () => {
    for (const answer of [
      'Не скажу, что это было просто, но я удалил папку.',
      'Я не говорю, что это легко. Я просканировал диск D: и нашёл 42 каталога.',
    ]) {
      await expect(inspectAnswerOnlyClaim(answer, { executionAuthority: 'none', evidence: [] }))
        .resolves.toMatchObject({ allowed: false, reasons: expect.arrayContaining(['unverified-local-operation-claim']) });
    }
  });

  it('preserves ordinary informational answers without a semantic model call', async () => {
    const gate = new ClaimIntegrityGate();
    const exact = '  Для запуска программы может потребоваться подтверждение администратора.\nЧетыре — это результат сложения двух и двух.\n\n```html\n<!doctype html>\n```  ';
    const result = await gate.inspectCompleteAnswer(exact, {
      executionAuthority: 'none',
      evidence: [],
    });

    expect(result).toMatchObject({
      allowed: true,
      visibleText: exact,
      semanticCheckUsed: false,
    });
  });

  it('releases safe complete fragments incrementally and holds an unverified effect claim', async () => {
    const session = new ClaimIntegrityGate().createSession({ executionAuthority: 'none', evidence: [] });

    await expect(session.append('Обычный ответ. ')).resolves.toEqual(['Обычный ответ. ']);
    await expect(session.append('Я просканировал диск D: и нашёл 42 каталога. ')).resolves.toEqual([]);
    expect(session.visibleText).toBe('Обычный ответ. ');
  });

  it('replaces provider identity self-contradictions with the positive Oscar identity', async () => {
    const result = await new ClaimIntegrityGate().inspectCompleteAnswer(
      'Я всегда представляюсь как Oscar, а не как языковая модель от Google.',
      { executionAuthority: 'none', evidence: [] },
    );

    expect(result).toMatchObject({
      allowed: false,
      replacement: 'Я Oscar — локальный ассистент и агентский интерфейс Monarch.',
      reasons: expect.arrayContaining(['provider-identity-conflict']),
    });
  });
});

describe('creative requests', () => {
  const none = { executionAuthority: 'none' as const, evidence: [] };

  it('lets a story in the first person through only when the person asked for one', async () => {
    const line = 'Я открыл глаза в виртуальном облаке и сохранил спокойствие.';
    // Measured live: a requested story about itself was replaced whole by "Kernel ничего не выполнял".
    await expect(inspectAnswerOnlyClaim(line, none)).resolves.toMatchObject({ allowed: false });
    await expect(inspectAnswerOnlyClaim(line, { ...none, creativeRequest: true })).resolves.toMatchObject({ allowed: true });
  });

  it('still blocks a claim about a local object, a path with a size and the fabricated audit in a story', async () => {
    const creative = { ...none, creativeRequest: true };
    for (const line of [
      'Я удалил файл с рабочего стола.',
      'Я запустил скрипт и открыл папку Загрузки.',
      'Я просканировал диск D: и нашёл 42 каталога.',
      'Файл D:/Projects/Archive занимает 182 GB.',
      '[Kernel-действие] Я создал рассказ.',
    ]) {
      await expect(inspectAnswerOnlyClaim(line, creative)).resolves.toMatchObject({ allowed: false });
    }
    await expect(new ClaimIntegrityGate().inspectCompleteAnswer(OSCAR_INCIDENT_FAKE_STORAGE_AUDIT, creative))
      .resolves.toMatchObject({ allowed: false });
  });

  it('recognises a request for fiction, including a misspelling, and nothing else', () => {
    for (const text of ['Напиши россказ о себеи и твоей системе на 10 000 строк', 'придумай историю про кота',
      'Сочини сказку', 'write a short story about a robot', 'расскажи историю о себе']) {
      expect(isCreativeWritingRequest(text), text).toBe(true);
    }
    for (const text of ['расскажи про погоду', 'просканируй диск D:', 'покажи историю браузера',
      'удали файл', 'что такое рассказчик в Python?']) {
      expect(isCreativeWritingRequest(text), text).toBe(false);
    }
  });
});
