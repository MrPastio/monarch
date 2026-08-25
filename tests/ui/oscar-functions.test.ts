import { describe, expect, it } from 'vitest';
import {
  insertOscarFunctionInvocation,
  isComputerUseFunctionInvocation,
  listOscarFunctions,
  readOscarFunctionQuery,
} from '../../src/ui/public/modules/oscar-functions.js';

describe('Oscar @ function composer UX', () => {
  it('finds Computer Use and inserts its canonical invocation', () => {
    expect(readOscarFunctionQuery('пожалуйста @Comp')).toBe('Comp');
    expect(listOscarFunctions('comp')).toEqual([
      expect.objectContaining({ id: 'computer-use', invocation: '@Computer Use' }),
    ]);
    expect(insertOscarFunctionInvocation('пожалуйста @Comp', '@Computer Use'))
      .toBe('пожалуйста @Computer Use ');
    expect(isComputerUseFunctionInvocation('@Computer Use открой фигму')).toBe(true);
  });
});
