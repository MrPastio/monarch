import { describe, expect, it } from 'vitest';
import { isComputerUseInvocation, resolveOscarFunctionInvocation } from '../../src/core/oscar-function-invocation';

describe('Oscar explicit function invocation', () => {
  it('recognizes only a leading user-authored Computer Use function', () => {
    expect(resolveOscarFunctionInvocation('@Computer Use открой фигму')).toMatchObject({
      id: 'computer-use',
      mention: '@Computer Use',
      requestText: 'открой фигму',
    });
    expect(isComputerUseInvocation('  @CU нажми кнопку Продолжить')).toBe(true);
    expect(isComputerUseInvocation('расскажи про @Computer Use')).toBe(false);
    expect(isComputerUseInvocation('открой фигму')).toBe(false);
  });
});
