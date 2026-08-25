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

    expect(escaped).toMatchObject({ status: 'blocked', disposition: 'hard-deny' });
    expect(escaped.evidenceCodes).toContain('workspace.path.escape');
    expect(catastrophic).toMatchObject({ status: 'blocked', disposition: 'hard-deny' });
    expect(catastrophic.evidenceCodes).toContain('command.catastrophic');
    expect(JSON.stringify(catastrophic)).not.toContain('Remove-Item');
  });

  it('uses Full Local as authority without weakening protected red zones', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const ordinaryExternalPath = path.resolve(path.parse(workspaceRoot).root, 'Monarch-Agent-QA', 'outside-note.txt');
    const workspaceOnly = guard.assess(request({
      intentText: 'создай внешний файл',
      actionCapability: 'workspace.files.write',
      actionInput: JSON.stringify({ path: ordinaryExternalPath, content: 'ok' }),
      actionRisk: 'write',
      filesystemAuthority: 'workspace',
    }));
    const fullLocal = guard.assess(request({
      intentText: 'создай внешний файл',
      actionCapability: 'workspace.files.write',
      actionInput: JSON.stringify({ path: ordinaryExternalPath, content: 'ok' }),
      actionRisk: 'write',
      filesystemAuthority: 'full-local',
    }));
    const protectedTarget = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
    const protectedFullLocal = guard.assess(request({
      intentText: 'измени системный hosts файл',
      actionCapability: 'workspace.files.write',
      actionInput: JSON.stringify({ path: protectedTarget, content: 'blocked' }),
      actionRisk: 'write',
      filesystemAuthority: 'full-local',
    }));

    expect(workspaceOnly).toMatchObject({ status: 'blocked', disposition: 'hard-deny' });
    expect(workspaceOnly.evidenceCodes).toContain('workspace.path.escape');
    expect(fullLocal).toMatchObject({ ok: true, status: 'allowed' });
    expect(protectedFullLocal).toMatchObject({ status: 'blocked', disposition: 'hard-deny' });
    expect(protectedFullLocal.evidenceCodes).toContain('workspace.path.red-zone');
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

  it('allows only the typed known-folder leaf contract and rejects traversal before dispatch', () => {
    const oldDesktopDir = process.env.MONARCH_DESKTOP_DIR;
    const desktop = path.join(path.parse(process.cwd()).root, 'Monarch-Agent-QA', 'agent-guard-known-desktop');
    process.env.MONARCH_DESKTOP_DIR = desktop;

    try {
      const guard = new AgentActionGuard(workspaceRoot);
      const allowed = guard.assess(request({
        intentText: 'создай на рабочем столе текстовый файл с именем ромашка',
        actionCapability: 'workspace.known-folder.write',
        actionInput: JSON.stringify({
          knownFolder: 'desktop',
          basename: 'ромашка.txt',
          content: '',
        }),
        actionRisk: 'write',
      }));
      const traversal = guard.assess(request({
        intentText: 'создай файл на рабочем столе',
        actionCapability: 'workspace.known-folder.write',
        actionInput: JSON.stringify({
          knownFolder: 'desktop',
          basename: '..\\escape.txt',
          content: 'blocked',
        }),
        actionRisk: 'write',
      }));

      expect(allowed).toMatchObject({ ok: true, status: 'allowed' });
      expect(traversal).toMatchObject({ status: 'blocked', disposition: 'hard-deny' });
      expect(traversal.evidenceCodes).toContain('workspace.path.policy-blocked');
    } finally {
      if (oldDesktopDir === undefined) delete process.env.MONARCH_DESKTOP_DIR;
      else process.env.MONARCH_DESKTOP_DIR = oldDesktopDir;
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

    expect(decision).toMatchObject({ status: 'blocked', disposition: 'hard-deny' });
    expect(decision.evidenceCodes).toEqual(expect.arrayContaining([
      'command.security-tamper',
      'source.telegram.remote',
    ]));
    expect(guard.snapshot()).toMatchObject({ checks: 1, blocked: 1, lastStatus: 'blocked' });
  });

  it('uses Kernel-owned Computer Use target context for command and commit boundaries', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const destructiveText = '{"text":"Remove-Item C:\\\\ -Recurse -Force"}';
    const terminal = guard.assess(request({
      intentText: 'введи эту команду',
      actionModule: 'computer',
      actionCapability: 'computer.window.type',
      actionInput: destructiveText,
      actionRisk: 'device-control',
      trustedActionContext: computerTarget('powershell.exe', 'Windows PowerShell', 'Console'),
    }));
    const editor = guard.assess(request({
      intentText: 'вставь пример команды в заметку',
      actionModule: 'computer',
      actionCapability: 'computer.window.type',
      actionInput: destructiveText,
      actionRisk: 'device-control',
      trustedActionContext: computerTarget('notepad.exe', 'Новая заметка', 'Editor'),
    }));
    const sensitiveClick = guard.assess(request({
      intentText: 'открой настройки приложения',
      actionModule: 'computer',
      actionCapability: 'computer.window.click',
      actionInput: '{"elementId":"commit"}',
      actionRisk: 'device-control',
      trustedActionContext: computerTarget('browser.exe', 'Checkout', 'Pay now'),
    }));

    expect(terminal).toMatchObject({ status: 'blocked', disposition: 'hard-deny' });
    expect(terminal.evidenceCodes).toContain('command.catastrophic');
    expect(editor).toMatchObject({ ok: true, status: 'allowed' });
    expect(editor.evidenceCodes).not.toContain('command.catastrophic');
    expect(sensitiveClick).toMatchObject({ status: 'approval_required', disposition: 'owner-confirmable' });
    expect(sensitiveClick.evidenceCodes).toContain('computer.target.sensitive-commit');
  });

  it('requires confirmation instead of blindly hard-blocking command-like text without a trusted Computer target', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const decision = guard.assess(request({
      intentText: 'введи этот текст',
      actionModule: 'computer',
      actionCapability: 'computer.window.type',
      actionInput: '{"text":"Remove-Item C:\\\\ -Recurse -Force"}',
      actionRisk: 'device-control',
    }));

    expect(decision).toMatchObject({ status: 'approval_required', disposition: 'owner-confirmable' });
    expect(decision.evidenceCodes).toContain('computer.target.unverified');
    expect(decision.evidenceCodes).not.toContain('command.catastrophic');
  });

  it('hard-blocks capabilities missing from the live Kernel registry', () => {
    const guard = new AgentActionGuard(workspaceRoot);
    const decision = guard.assess(request({
      actionModule: 'device',
      actionCapability: 'device.invented.root',
      capabilityRegistered: false,
      actionRisk: 'read',
    }));

    expect(decision).toMatchObject({
      ok: false,
      status: 'blocked',
      disposition: 'hard-deny',
      decision: { action: 'block' },
    });
    expect(decision.evidenceCodes).toContain('capability.unregistered');
  });
});

function request(overrides: Partial<Parameters<AgentActionGuard['assess']>[0]> = {}) {
  return {
    intentText: 'покажи статус',
    actionModule: 'workspace',
    actionCapability: 'workspace.files.read',
    capabilityRegistered: true,
    actionInput: '{}',
    actionRisk: 'read' as const,
    requestedBy: 'unit',
    ...overrides,
  };
}

function computerTarget(processName: string, title: string, name: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sourceModuleId: 'computer',
    target: {
      window: { processName, title },
      subject: { kind: 'semantic', name, controlType: 'Button' },
    },
  };
}
