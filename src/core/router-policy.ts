import type {
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
