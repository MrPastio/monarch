import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoderHostPolicy } from '../../src/modules/coder/policy';

describe('Coder command policy', () => {
  const monarchRoot = path.resolve('E:/Monarch');
  const policy = new CoderHostPolicy({ monarchRoot });
  const cwd = path.join(monarchRoot, 'Workspace Coder', 'demo');

  it('treats a sibling folder that only shares the name prefix as outside Monarch', () => {
    expect(() => policy.validateCommand('git', ['-c', 'core.hooksPath=E:/MonarchCoderSandbox/empty-git-hooks', 'status'], cwd))
      .not.toThrow();
    expect(() => policy.validateCommand('python', ['E:\\MonarchApp-data\\tool.py'], cwd)).not.toThrow();
  });

  it('still refuses arguments that name Monarch itself or a file inside it', () => {
    expect(() => policy.validateCommand('python', ['E:\\Monarch\\src\\main.ts'], cwd)).toThrow(/Monarch system files/u);
    expect(() => policy.validateCommand('git', ['-C', 'E:/Monarch', 'status'], cwd)).toThrow(/Monarch system files/u);
    expect(() => policy.validateCommand('cmd', ['/c', 'type "E:\\Monarch"'], cwd)).toThrow();
  });

  it('allows the project folders inside Workspace Coder', () => {
    expect(() => policy.validateCommand('python', [path.join(cwd, 'hello.py')], cwd)).not.toThrow();
  });
});
