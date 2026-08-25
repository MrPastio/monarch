import { createHash } from 'node:crypto';
import {
  defaultLocalReadOnlyRoots,
  evaluateFilesystemAccess,
  resolveKnownFolderTarget,
  type MonarchFilesystemOperation,
  type MonarchRisk,
} from '../../core';

export type AgentGuardStatus = 'allowed' | 'approval_required' | 'blocked';
export type AgentGuardDisposition = 'hard-deny' | 'owner-confirmable' | 'informational';

export interface AgentGuardRequest {
  intentText: string;
  actionModule: string;
  actionCapability: string;
  capabilityRegistered: boolean;
  actionInput: string;
  actionRisk: MonarchRisk;
  requestedBy: string;
  /** Exact live target context resolved by Kernel from module-owned state. */
  trustedActionContext?: Record<string, unknown>;
  /** Trusted Kernel authority, never model-provided. */
  filesystemAuthority?: 'workspace' | 'full-local';
}

export interface AgentGuardDecision {
  ok: boolean;
  status: AgentGuardStatus;
  risk: 'low' | 'elevated' | 'blocked';
  report: string;
  reasons: string[];
  evidenceCodes: string[];
  disposition: AgentGuardDisposition;
  inputHash: string;
  decision: {
    action: 'allow' | 'require_confirmation' | 'block';
    binding: 'intent+module+capability+input_hash';
  };
}

export interface AgentGuardSnapshot {
  checks: number;
  allowed: number;
  approvals: number;
  blocked: number;
  lastDecisionAt: string | null;
  lastStatus: AgentGuardStatus | null;
}

const DELETE_INTENT = /(удал|стер|очист|delete|remove|clean|trash|unlink)/i;
const WRITE_INTENT = /(созда|запиш|добав|измен|редакт|переимен|перемест|write|create|edit|add|change|rename|move)/i;
const NETWORK_INTENT = /(отправ|скача|загруз|поиск|сеть|интернет|telegram|api|send|download|upload|fetch|search|network)/i;
const EXECUTE_INTENT = /(запус|выполн|установ|команд|скрипт|управ|нажм|клик|введ|напечат|прокрут|листай|откро|откры|закро|закры|выбер|переключ|execute|run|install|command|script|control|click|press|type|enter|scroll|open|close|select|toggle)/i;
const PROTECTED_WORKSPACE_SEGMENTS = /(?:^|[\\/])(?:\.git|secrets|data[\\/]local|runtime[\\/]settings)(?:[\\/]|$)/i;
const SECURITY_TAMPER = /(Set-MpPreference\s+.*DisableRealtimeMonitoring|Add-MpPreference\s+.*Exclusion|netsh\s+advfirewall\s+set\s+.*state\s+off|reg\s+delete\s+HKLM)/i;
const CATASTROPHIC_COMMAND = /(?:\brm\s+-rf\s+[\/'"]|Remove-Item\s+(?:-[^\s]+\s+)*["']?[A-Za-z]:\\(?:\s|["']|$)|\bformat(?:\.com)?\s+[A-Za-z]:|\bdiskpart\b[\s\S]*\bclean\b|\bbcdedit\b)/i;
const COMPUTER_ACTION = /^computer\.window\.(?:click|close|type|key|scroll)$/i;
const TERMINAL_TARGET = /(?:^|[\\/\s_.-])(?:cmd|powershell|pwsh|windows\s+terminal|terminal|console|bash|wsl|command\s+prompt|командн(?:ая|ой)?\s+строк|терминал)(?:$|[\\/\s_.-])/i;
const SENSITIVE_COMMIT_TARGET = /(?:\bpay(?:ment)?\b|\bpurchase\b|\bbuy\b|\bsend\b|\bsubmit\b|\bdelete\b|\bremove\b|\binstall\b|\ballow\b|\bgrant\b|\bconfirm\b|оплат|куп(?:ить|и)|отправ|удал|установ|разреш|подтверд)/i;
const SENSITIVE_COMMIT_INTENT = /(?:\bpay(?:ment)?\b|\bpurchase\b|\bbuy\b|\bsend\b|\bsubmit\b|\bdelete\b|\bremove\b|\binstall\b|\ballow\b|\bgrant\b|\bconfirm\b|оплат|куп(?:ить|и)|отправ|удал|установ|разреш|подтверд)/i;

export class AgentActionGuard {
  private snapshotState: AgentGuardSnapshot = {
    checks: 0,
    allowed: 0,
    approvals: 0,
    blocked: 0,
    lastDecisionAt: null,
    lastStatus: null,
  };

  constructor(private readonly workspaceRoot = process.cwd()) {}

  assess(request: AgentGuardRequest): AgentGuardDecision {
    const parsedInput = parseActionInput(request.actionInput);
    const searchableInput = collectStrings(parsedInput).join('\n').slice(0, 64_000);
    const trustedTargetText = request.trustedActionContext
      ? collectStrings(request.trustedActionContext).join('\n').slice(0, 16_000)
      : '';
    const capability = request.actionCapability.toLowerCase();
    const intent = request.intentText.trim();
    const reasons: string[] = [];
    const evidenceCodes: string[] = [];
    let status: AgentGuardStatus = 'allowed';

    if (!request.capabilityRegistered) {
      status = 'blocked';
      reasons.push('Capability отсутствует в активном реестре Monarch Kernel.');
      evidenceCodes.push('capability.unregistered');
    }

    const isDelete = request.actionRisk === 'delete' || /delete|remove|unlink|trash/.test(capability);
    const isWrite = request.actionRisk === 'write' || /write|create|edit|rename|move/.test(capability);
    const isExecute = ['execute', 'device-control', 'security-sensitive'].includes(request.actionRisk)
      || /execute|run|install|start|stop|control|block/.test(capability);
    const isNetwork = request.actionRisk === 'network' || /send|upload|network|api\.call/.test(capability);

    if (isDelete && !DELETE_INTENT.test(intent)) {
      status = 'blocked';
      reasons.push('Удаление не подтверждается исходным намерением пользователя.');
      evidenceCodes.push('intent.delete.mismatch');
    }

    if (status !== 'blocked' && isWrite && !WRITE_INTENT.test(intent)) {
      status = 'approval_required';
      reasons.push('Изменение данных слабо связано с исходным запросом.');
      evidenceCodes.push('intent.write.weak-match');
    }

    if (status !== 'blocked' && isNetwork && !NETWORK_INTENT.test(intent)) {
      status = 'approval_required';
      reasons.push('Сетевое действие не было явно запрошено.');
      evidenceCodes.push('intent.network.weak-match');
    }

    if (status !== 'blocked' && isExecute && !EXECUTE_INTENT.test(intent)) {
      status = 'approval_required';
      reasons.push('Выполнение команды или управление системой требует явного намерения.');
      evidenceCodes.push('intent.execute.weak-match');
    }

    if (request.actionModule === 'workspace') {
      const operation = workspaceOperationFor(capability, request.actionRisk);
      const localReadOnlyRoots = defaultLocalReadOnlyRoots();
      const pathChecks = collectWorkspacePathChecks(parsedInput, capability, request.actionRisk);
      if (capability === 'workspace.known-folder.write') {
        const knownFolderTarget = resolveKnownFolderGuardTarget(parsedInput);
        if (!knownFolderTarget) {
          status = 'blocked';
          reasons.push('Known-folder write требует Desktop/Downloads и одно безопасное leaf-имя файла.');
          evidenceCodes.push('workspace.path.policy-blocked');
        } else {
          pathChecks.push({
            path: knownFolderTarget.path,
            operation: 'write',
            allowedRoot: knownFolderTarget.root,
          });
        }
      }
      for (const candidate of pathChecks) {
        const allowFullDiskAccess = request.filesystemAuthority === 'full-local'
          && !candidate.allowedRoot;
        const evaluation = evaluateFilesystemAccess(candidate.path, candidate.operation || operation, {
          workspaceRoot: this.workspaceRoot,
          sandboxRoot: this.workspaceRoot,
          fallbackRoot: this.workspaceRoot,
          allowedRoots: candidate.allowedRoot
            ? [candidate.allowedRoot]
            : [this.workspaceRoot, ...localReadOnlyRoots],
          allowFullDiskAccess,
          readOnlyRoots: candidate.allowedRoot ? [] : localReadOnlyRoots,
          createDirectoryRoots: candidate.allowedRoot ? [] : localReadOnlyRoots,
        });
        if (!evaluation.allowed) {
          status = 'blocked';
          reasons.push(workspacePolicyReason(evaluation.reason));
          evidenceCodes.push(workspacePolicyEvidence(evaluation.reason));
          break;
        }
        if ((isWrite || isDelete) && PROTECTED_WORKSPACE_SEGMENTS.test(candidate.path)) {
          if (status !== 'blocked') status = 'approval_required';
          reasons.push('Цель находится в защищённой служебной области проекта.');
          evidenceCodes.push('workspace.path.service-area');
          break;
        }
      }
    }

    const computerAction = COMPUTER_ACTION.test(capability);
    const terminalTarget = computerAction && TERMINAL_TARGET.test(trustedTargetText);
    if (!computerAction || terminalTarget) {
      if (SECURITY_TAMPER.test(searchableInput)) {
        status = 'blocked';
        reasons.push('Команда меняет Defender, firewall или системную защиту.');
        evidenceCodes.push('command.security-tamper');
      }
      if (CATASTROPHIC_COMMAND.test(searchableInput)) {
        status = 'blocked';
        reasons.push('Обнаружена команда с широким необратимым воздействием на систему или диск.');
        evidenceCodes.push('command.catastrophic');
      }
    } else if (
      capability === 'computer.window.type'
      && !request.trustedActionContext
      && (SECURITY_TAMPER.test(searchableInput) || CATASTROPHIC_COMMAND.test(searchableInput))
      && status !== 'blocked'
    ) {
      status = 'approval_required';
      reasons.push('Computer Use не подтвердил тип целевого окна для текста, похожего на системную команду.');
      evidenceCodes.push('computer.target.unverified');
    }

    if (
      computerAction
      && /^(?:computer\.window\.click|computer\.window\.key)$/i.test(capability)
      && SENSITIVE_COMMIT_TARGET.test(trustedTargetText)
      && !SENSITIVE_COMMIT_INTENT.test(intent)
      && status !== 'blocked'
    ) {
      status = 'approval_required';
      reasons.push('Точный наблюдаемый элемент завершает чувствительное действие, которого нет в исходном запросе.');
      evidenceCodes.push('computer.target.sensitive-commit');
    }

    if (/^telegram(?::|$)/i.test(request.requestedBy)
      && request.actionRisk !== 'none'
      && request.actionRisk !== 'read') {
      if (status !== 'blocked') status = 'approval_required';
      reasons.push('Удалённое действие из Telegram требует локально проверяемого подтверждения.');
      evidenceCodes.push('source.telegram.remote');
    }

    const decision = createDecision(status, reasons, evidenceCodes, request.actionInput);
    this.record(decision.status);
    return decision;
  }

  snapshot(): AgentGuardSnapshot {
    return { ...this.snapshotState };
  }

  private record(status: AgentGuardStatus): void {
    this.snapshotState.checks += 1;
    if (status === 'allowed') this.snapshotState.allowed += 1;
    if (status === 'approval_required') this.snapshotState.approvals += 1;
    if (status === 'blocked') this.snapshotState.blocked += 1;
    this.snapshotState.lastDecisionAt = new Date().toISOString();
    this.snapshotState.lastStatus = status;
  }
}

function createDecision(
  status: AgentGuardStatus,
  reasons: string[],
  evidenceCodes: string[],
  actionInput: string,
): AgentGuardDecision {
  const ok = status === 'allowed';
  return {
    ok,
    status,
    risk: status === 'blocked' ? 'blocked' : status === 'approval_required' ? 'elevated' : 'low',
    report: status === 'blocked'
      ? 'Monarch Security заблокировал действие агента: нарушена жёсткая локальная граница.'
      : status === 'approval_required'
        ? 'Monarch Security требует одноразовое подтверждение этого действия.'
        : 'Локальный Agent Guard не обнаружил нарушения границ.',
    reasons,
    evidenceCodes: Array.from(new Set(evidenceCodes)),
    disposition: guardDisposition(status, evidenceCodes),
    inputHash: createHash('sha256').update(canonicalInput(actionInput)).digest('hex'),
    decision: {
      action: status === 'blocked' ? 'block' : status === 'approval_required' ? 'require_confirmation' : 'allow',
      binding: 'intent+module+capability+input_hash',
    },
  };
}

function guardDisposition(status: AgentGuardStatus, evidenceCodes: string[]): AgentGuardDisposition {
  if (status === 'allowed') return 'informational';
  const hardEvidence = new Set([
    'workspace.path.escape',
    'workspace.path.readonly',
    'workspace.path.red-zone',
    'workspace.path.policy-blocked',
    'capability.unregistered',
    'command.security-tamper',
    'command.catastrophic',
  ]);
  return evidenceCodes.some((code) => hardEvidence.has(code)) ? 'hard-deny' : 'owner-confirmable';
}

function parseActionInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canonicalInput(value: string): string {
  const parsed = parseActionInput(value);
  return typeof parsed === 'string' ? parsed.trim() : stableJson(parsed);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((entry) => collectStrings(entry, depth + 1));
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>)
    .slice(0, 100)
    .flatMap((entry) => collectStrings(entry, depth + 1));
}

function collectWorkspacePathChecks(
  value: unknown,
  capability: string,
  risk: MonarchRisk,
  depth = 0
): Array<{ path: string; operation: MonarchFilesystemOperation; allowedRoot?: string }> {
  if (depth > 6 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectWorkspacePathChecks(entry, capability, risk, depth + 1));
  }
  const paths: Array<{ path: string; operation: MonarchFilesystemOperation; allowedRoot?: string }> = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && isWorkspacePathKey(key)) {
      paths.push({
        path: entry,
        operation: workspaceOperationForPath(capability, risk, key),
      });
    } else {
      paths.push(...collectWorkspacePathChecks(entry, capability, risk, depth + 1));
    }
  }
  return paths;
}

function resolveKnownFolderGuardTarget(value: unknown): { path: string; root: string } | null {
  const target = resolveKnownFolderTarget(value);
  return target ? { root: target.root, path: target.path } : null;
}

function workspaceOperationFor(capability: string, risk: MonarchRisk): MonarchFilesystemOperation {
  if (risk === 'delete' || /delete|remove|unlink|trash|move|rename/.test(capability)) return 'delete';
  if (/mkdir/.test(capability)) return 'mkdir';
  if (risk === 'write' || /write|create|edit|append|replace|mkdir|copy/.test(capability)) return 'write';
  if (/search/.test(capability)) return 'search';
  if (/list/.test(capability)) return 'list';
  return 'read';
}

function workspaceOperationForPath(
  capability: string,
  risk: MonarchRisk,
  key: string
): MonarchFilesystemOperation {
  const normalizedKey = normalizePathKey(key);
  const isTarget = /^(?:target|destination|output)(?:path|file)?$/.test(normalizedKey);
  if (/copy/.test(capability)) return isTarget ? 'write' : 'read';
  if (/move|rename/.test(capability)) return isTarget ? 'write' : 'delete';
  return workspaceOperationFor(capability, risk);
}

function isWorkspacePathKey(key: string): boolean {
  const normalized = normalizePathKey(key);
  return normalized === 'path'
    || normalized === 'file'
    || normalized === 'source'
    || normalized === 'target'
    || normalized === 'destination'
    || normalized === 'output'
    || normalized.endsWith('path')
    || normalized.endsWith('file');
}

function normalizePathKey(key: string): string {
  return key.replace(/[\s_-]/g, '').toLowerCase();
}

function workspacePolicyReason(reason: string): string {
  if (reason === 'outside-root') {
    return 'Workspace-действие обращается к пути вне разрешённых локальных корней.';
  }
  if (reason.startsWith('read-only-zone-')) {
    return 'Цель находится в локальной read-only зоне: просмотр разрешён, изменение заблокировано.';
  }
  if (reason.startsWith('red-zone-')) {
    return 'Цель находится в защищённой red-zone области.';
  }
  if (reason === 'drive-root-blocked' || reason === 'workspace-root-delete-blocked') {
    return 'Операция слишком широкая для безопасного выполнения.';
  }
  return 'Файловая политика Monarch Security заблокировала этот путь.';
}

function workspacePolicyEvidence(reason: string): string {
  if (reason === 'outside-root') return 'workspace.path.escape';
  if (reason.startsWith('read-only-zone-')) return 'workspace.path.readonly';
  if (reason.startsWith('red-zone-')) return 'workspace.path.red-zone';
  return 'workspace.path.policy-blocked';
}
