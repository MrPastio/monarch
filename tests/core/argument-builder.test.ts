import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceFileArguments,
  classifyIntentText,
  extractWorkspaceObjectName,
  parseExactWorkspaceFileWrites,
} from '../../src/core';

describe('workspace argument builder', () => {
  it('extracts an explicitly assigned object name without treating it as a path', () => {
    expect(extractWorkspaceObjectName('Создай новую папку в workspace, назови её цветок.')).toBe('цветок');
    expect(extractWorkspaceObjectName('Create a new folder and call it Flower.')).toBe('Flower');
    expect(extractWorkspaceObjectName('Создай папку и назови её ../escape')).toBe('');
  });

  it('preserves a bare file path and exact inline code content', () => {
    expect(buildWorkspaceFileArguments('Создай main.py и напиши print("Hello World")')).toEqual({
      path: 'main.py',
      content: 'print("Hello World")',
      overwrite: false,
    });
  });

  it('parses quoted content without confusing it with a file path', () => {
    expect(buildWorkspaceFileArguments('создай файл runtime/ui-note.txt с текстом "готово"')).toEqual({
      path: 'runtime/ui-note.txt',
      content: 'готово',
      overwrite: false,
    });
  });

  it('compiles exact bytes from an unquoted nested Windows path without sentence punctuation', () => {
    expect(parseExactWorkspaceFileWrites(
      'The file E:\\Agent-QA\\Nested Folder\\holdout-a1.md must contain exactly HOLDOUT-a1. Create and verify it now.',
    )).toEqual([{
      path: 'E:\\Agent-QA\\Nested Folder\\holdout-a1.md',
      content: 'HOLDOUT-a1',
      overwrite: false,
    }]);
  });

  it('keeps multiple exact file clauses independent', () => {
    expect(parseExactWorkspaceFileWrites(
      'Create runtime/one.txt with exact text ONE and create runtime/two.txt with exact text TWO.',
    )).toEqual([
      { path: 'runtime/one.txt', content: 'ONE', overwrite: false },
      { path: 'runtime/two.txt', content: 'TWO', overwrite: false },
    ]);
  });

  it('keeps write-like text inside quoted bytes inert', () => {
    expect(parseExactWorkspaceFileWrites(
      'Create runtime/a.txt with exact text "literal and then create runtime/b.txt with exact text HACK".',
    )).toEqual([{
      path: 'runtime/a.txt',
      content: 'literal and then create runtime/b.txt with exact text HACK',
      overwrite: false,
    }]);
  });

  it('does not compile explanatory or negated prose into file mutations', () => {
    expect(parseExactWorkspaceFileWrites(
      'Explain how to create runtime/explained.txt with exact text SHOULD-NOT-RUN.',
    )).toEqual([]);
    expect(parseExactWorkspaceFileWrites(
      'Do not create runtime/negated.txt with exact text SHOULD-NOT-RUN.',
    )).toEqual([]);
    expect(parseExactWorkspaceFileWrites(
      'Не создавай runtime/negated-ru.txt с точным текстом НЕЛЬЗЯ.',
    )).toEqual([]);
  });

  it('classifies a complete atomic write as a tool operation', () => {
    const classification = classifyIntentText('Создай main.py и напиши print("Hello World")');
    expect(classification.kind).toBe('file_operation');
    if (classification.kind === 'file_operation') {
      expect(classification.toolRoutingAllowed).toBe(true);
    }
  });
});
