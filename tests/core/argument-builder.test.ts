import { describe, expect, it } from 'vitest';
import { buildWorkspaceFileArguments, classifyIntentText, extractWorkspaceObjectName } from '../../src/core';

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

  it('classifies a complete atomic write as a tool operation', () => {
    const classification = classifyIntentText('Создай main.py и напиши print("Hello World")');
    expect(classification.kind).toBe('file_operation');
    if (classification.kind === 'file_operation') {
      expect(classification.toolRoutingAllowed).toBe(true);
    }
  });
});
