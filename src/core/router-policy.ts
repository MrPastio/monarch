import type {
  MonarchCapability,
  MonarchPermissionMode,
  MonarchRisk,
} from './contracts';

export function permissionModeForRisk(risk: MonarchRisk | undefined): MonarchPermissionMode {
  switch (risk) {
  case 'none':
  case 'read':
    return 'allow';
  case 'money':
  case 'security-sensitive':
    return 'deny';
  default:
    return 'confirm';
  }
}

export function confidenceThresholdForRisk(risk: MonarchRisk | undefined): number {
  switch (risk) {
  case 'none':
    return 0.45;
  case 'read':
    return 0.5;
  case 'write':
  case 'network':
  case 'identity':
    return 0.7;
  case 'delete':
  case 'execute':
  case 'device-control':
    return 0.75;
  case 'money':
  case 'security-sensitive':
  default:
    return 0.95;
  }
}

export function findMissingRequiredInput(
  capability: MonarchCapability | undefined,
  input: unknown
): string[] {
  const required = capability?.inputSchema?.required || [];
  if (required.length === 0) {
    return [];
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [...required];
  }

  const record = input as Record<string, unknown>;
  return required.filter((key) => isMissingInputValue(
    record[key],
    capability?.id === 'workspace.files.write' && key === 'content',
  ));
}

function isMissingInputValue(value: unknown, allowEmptyString = false): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return !allowEmptyString && typeof value === 'string' && value.trim().length === 0;
}
