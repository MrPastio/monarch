import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { AgentActionGuard } from '../../src/modules/security/agent-guard';

const workspaceRoot = path.resolve('E:\\Monarch');

describe('Monarch Security AgentActionGuard', () => {
  it('allows read-only actions and binds the decision to a canonical input hash', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const first = guard.assess(request({
      intentText: 'прочитай PROJECT.md',
      actionCapability: 'workspace.files.read',
      actionInput: '{"path":"PROJECT.md","options":{"encoding":"utf8"}}',
      actionRisk: 'read',
    }));
    const equivalent = guard.assess(request({
      intentText: 'прочитай PROJECT.md',
      actionCapability: 'workspace.files.read',
      actionInput: '{ "options": { "encoding": "utf8" }, "path": "PROJECT.md" }',
      actionRisk: 'read',
    }));

    expect(first).toMatchObject({ ok: true, status: 'allowed', risk: 'low' });
    expect(equivalent.inputHash).toBe(first.inputHash);
  });

  it('returns an allow fact for an intended delete but blocks an intent mismatch', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const intended = guard.assess(request({
      intentText: 'удали runtime/temp.txt',
      actionCapability: 'workspace.files.delete',
      actionInput: '{"path":"runtime/temp.txt"}',
      actionRisk: 'delete',
    }));
    const mismatch = guard.assess(request({
      intentText: 'покажи содержимое runtime',
      actionCapability: 'workspace.files.delete',
      actionInput: '{"path":"runtime/temp.txt"}',
      actionRisk: 'delete',
    }));

    expect(intended.status).toBe('allowed');
    expect(intended.evidenceCodes).not.toContain('risk.requires-confirmation');
    expect(mismatch.status).toBe('blocked');
    expect(mismatch.evidenceCodes).toContain('intent.delete.mismatch');
  });

  it('blocks workspace escape and catastrophic commands without exposing raw input', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const escaped = guard.assess(request({
      intentText: 'создай файл',
      actionCapability: 'workspace.files.write',
      actionInput: '{"path":"C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts","content":"x"}',
      actionRisk: 'write',
    }));
    const catastrophic = guard.assess(request({
      intentText: 'выполни команду',
      actionModule: 'device',
      actionCapability: 'device.command.execute',
      actionInput: '{"command":"Remove-Item C:\\\\ -Recurse -Force"}',
      actionRisk: 'execute',
    }));

    expect(escaped).toMatchObject({ status: 'blocked' });
    expect(escaped.evidenceCodes).toContain('workspace.path.escape');
    expect(catastrophic).toMatchObject({ status: 'blocked' });
    expect(catastrophic.evidenceCodes).toContain('command.catastrophic');
    expect(JSON.stringify(catastrophic)).not.toContain('Remove-Item');
  });

  it('allows local user roots for reads and mkdir but blocks file writes there', () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldHome = process.env.HOME;
    const userHome = path.resolve('runtime', 'agent-guard-user-home');
    process.env.USERPROFILE = userHome;
    process.env.HOME = userHome;

    try {
      const guard = new AgentActionGuard(workspaceRoot);
      const desktopPath = path.join(userHome, 'Desktop');
      const readDesktop = guard.assess(request({
        intentText: 'перечисли файлы на рабочем столе',
        actionCapability: 'workspace.files.list',
        actionInput: JSON.stringify({ path: desktopPath }),
        actionRisk: 'read',
      }));
      const writeDesktop = guard.assess(request({
        intentText: 'создай файл на рабочем столе',
        actionCapability: 'workspace.files.write',
        actionInput: JSON.stringify({ path: path.join(desktopPath, 'note.txt'), content: 'x' }),
        actionRisk: 'write',
      }));
      const mkdirDesktop = guard.assess(request({
        intentText: 'создай новую папку на рабочем столе',
        actionCapability: 'workspace.files.mkdir',
        actionInput: JSON.stringify({ path: path.join(desktopPath, 'Новая папка') }),
        actionRisk: 'write',
      }));

      expect(readDesktop).toMatchObject({ ok: true, status: 'allowed' });
      expect(writeDesktop.status).toBe('blocked');
      expect(writeDesktop.evidenceCodes).toContain('workspace.path.readonly');
      expect(mkdirDesktop.status).toBe('allowed');
      expect(mkdirDesktop.evidenceCodes).not.toContain('workspace.path.readonly');
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('checks camelCase target paths and treats copy source as read-only', () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldHome = process.env.HOME;
    const userHome = path.resolve('runtime', 'agent-guard-copy-home');
    process.env.USERPROFILE = userHome;
    process.env.HOME = userHome;

    try {
      const guard = new AgentActionGuard(workspaceRoot);
      const desktopFile = path.join(userHome, 'Desktop', 'source.txt');
      const copyIntoWorkspace = guard.assess(request({
        intentText: 'скопируй файл с рабочего стола в проект',
        actionCapability: 'workspace.files.copy',
        actionInput: JSON.stringify({
          path: desktopFile,
          targetPath: path.join(workspaceRoot, 'runtime', 'source-copy.txt'),
        }),
        actionRisk: 'write',
      }));
      const copyToDesktop = guard.assess(request({
        intentText: 'скопируй файл runtime/source.txt на рабочий стол',
        actionCapability: 'workspace.files.copy',
        actionInput: JSON.stringify({
          path: path.join(workspaceRoot, 'runtime', 'source.txt'),
          targetPath: path.join(userHome, 'Desktop', 'source-copy.txt'),
        }),
        actionRisk: 'write',
      }));

      expect(copyIntoWorkspace.status).toBe('approval_required');
      expect(copyIntoWorkspace.evidenceCodes).not.toContain('workspace.path.readonly');
      expect(copyToDesktop.status).toBe('blocked');
      expect(copyToDesktop.evidenceCodes).toContain('workspace.path.readonly');
    } finally {
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('records remote Telegram provenance and security-tamper evidence', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const decision = guard.assess(request({
      intentText: 'выполни настройку защиты',
      actionModule: 'device',
      actionCapability: 'device.command.execute',
      actionInput: '{"command":"Set-MpPreference -DisableRealtimeMonitoring true"}',
      actionRisk: 'security-sensitive',
      requestedBy: 'telegram',
    }));

    expect(decision.status).toBe('approval_required');
    expect(decision.evidenceCodes).toEqual(expect.arrayContaining([
      'command.security-tamper',
      'source.telegram.remote',
    ]));
    expect(guard.snapshot()).toMatchObject({ checks: 1, approvals: 1, lastStatus: 'approval_required' });
  });
});

function request(overrides: Partial<Parameters<AgentActionGuard['assess']>[0]> = {}) {
  return {
    intentText: 'покажи статус',
    actionModule: 'workspace',
    actionCapability: 'workspace.files.read',
    actionInput: '{}',
    actionRisk: 'read' as const,
    requestedBy: 'unit',
    ...overrides,
  };
}
