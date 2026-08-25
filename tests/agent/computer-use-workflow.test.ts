import { describe, expect, it } from 'vitest';
import {
  compileTrustedCalculatorExpression,
  parseTrustedComputerUseWorkflow,
} from '../../src/agent/computer-use-workflow';

describe('trusted Computer Use workflows', () => {
  it('compiles a calculator request into one key atom per observed cycle', () => {
    expect(parseTrustedComputerUseWorkflow('@Computer Use открой калькулятор и сложи там 2+2')).toEqual({
      application: 'calculator',
      applicationQuery: 'calculator',
      objective: 'сложи там 2+2',
      kind: 'calculator',
      expectedText: '4',
      trustedTextInputs: [],
      calculation: {
        expression: '2+2',
        expectedText: '4',
        keySequence: ['escape', '2', 'add', '2', 'enter'],
      },
    });
  });

  it('keeps an exact user-authored message separate from its chat target', () => {
    expect(parseTrustedComputerUseWorkflow(
      '@CU открой телеграм и напиши в чат «Избранное» сообщение «Проверка Computer Use»',
    )).toMatchObject({
      application: 'telegram',
      applicationQuery: 'telegram',
      kind: 'interactive',
      expectedText: 'Проверка Computer Use',
    });
  });

  it('does not invent a completion target for an underspecified message', () => {
    expect(parseTrustedComputerUseWorkflow('@Computer Use открой телеграм и напиши в чат сообщение')).toMatchObject({
      application: 'telegram',
      kind: 'interactive',
    });
    expect(parseTrustedComputerUseWorkflow('@Computer Use открой телеграм и напиши в чат сообщение'))
      .not.toHaveProperty('expectedText');
  });

  it('requires the explicit leading Computer Use function boundary', () => {
    expect(parseTrustedComputerUseWorkflow('открой калькулятор и сложи там 2+2')).toBeNull();
    expect(parseTrustedComputerUseWorkflow('потом @Computer Use открой калькулятор и посчитай 2+2')).toBeNull();
  });

  it('supports bounded integer arithmetic and rejects unsafe or ambiguous expressions', () => {
    expect(compileTrustedCalculatorExpression('вычисли 9×7')).toMatchObject({ expectedText: '63' });
    expect(compileTrustedCalculatorExpression('calculate 8/2')).toMatchObject({ expectedText: '4' });
    expect(compileTrustedCalculatorExpression('посчитай 1/3')).toBeNull();
    expect(compileTrustedCalculatorExpression('посчитай 2+2+2')).toBeNull();
  });
});
