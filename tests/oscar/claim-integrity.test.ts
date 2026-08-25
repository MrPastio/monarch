import { describe, expect, it } from 'vitest';
import {
  ClaimIntegrityGate,
  OSCAR_INCIDENT_FAKE_STORAGE_AUDIT,
  inspectAnswerOnlyClaim,
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
