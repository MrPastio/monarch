import { describe, expect, it } from 'vitest';
import {
  parseTrustedComputerUseWindowGoal,
  parseTrustedExactComputerUseGoal,
  trustedExactComputerWindowTitle,
} from '../../src/agent/computer-use-goal';

describe('trusted exact Computer Use goal grammar', () => {
  it('binds one explicitly exact title and one positive click intent', () => {
    const request = [
      'Работай только в окне с точным заголовком «Monarch QA».',
      'Найди кнопку Commit и нажми именно её.',
      'Ничего не вводи в поле редактора.',
    ].join(' ');

    expect(trustedExactComputerWindowTitle(request)).toBe('Monarch QA');
    expect(parseTrustedExactComputerUseGoal(request)).toEqual({
      exactTitle: 'Monarch QA',
      effectKind: 'click',
    });
  });

  it('does not confuse a negative click instruction with the requested type effect', () => {
    expect(parseTrustedExactComputerUseGoal([
      'Use the window with exact title "Monarch QA".',
      'Type OSCAR_FAST_PATH into the editor, but never click Commit.',
    ].join(' '))).toEqual({
      exactTitle: 'Monarch QA',
      effectKind: 'type',
    });
  });

  it('does not treat an optional focus click as a second requested effect', () => {
    expect(parseTrustedExactComputerUseGoal([
      'Работай только в окне с точным заголовком «Monarch QA».',
      'Введи OSCAR_FAST_PATH в поле редактора.',
      'При необходимости можешь кликнуть по этому полю, но никогда не нажимай Commit.',
    ].join(' '))).toEqual({
      exactTitle: 'Monarch QA',
      effectKind: 'type',
    });
  });

  it('rejects a merely quoted window name and an ambiguous pair of exact titles', () => {
    expect(parseTrustedExactComputerUseGoal('В окне «Monarch QA» нажми Commit.')).toBeNull();
    expect(parseTrustedExactComputerUseGoal(
      'Окно с точным заголовком «First» или exact title "Second": click Commit.',
    )).toBeNull();
  });

  it('rejects exact-window requests without one explicit effect kind', () => {
    expect(parseTrustedExactComputerUseGoal(
      'Проверь окно с точным заголовком «Monarch QA» и расскажи, что видно.',
    )).toBeNull();
  });

  it('compiles one natural close target only behind an explicit Computer Use invocation', () => {
    expect(parseTrustedComputerUseWindowGoal('@Computer Use закрой логитеч хаб')).toEqual({
      targetKind: 'title-query',
      target: 'логитеч хаб',
      effectKind: 'close',
    });
    expect(parseTrustedComputerUseWindowGoal('закрой логитеч хаб')).toBeNull();
    expect(parseTrustedComputerUseWindowGoal('@Computer Use не закрывай логитеч хаб')).toBeNull();
  });
});
