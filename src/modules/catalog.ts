import type { MonarchModulePackage } from '../core';
import { assistantModulePackage } from './assistant';
import { artifactsModulePackage } from './artifacts';
import { astraModulePackage } from './astra';
import { diagnosticsModulePackage } from './diagnostics';
import { knowledgeModulePackage } from './knowledge';
import { memoryModulePackage } from './memory';
import { monarchModulesModulePackage } from './monarch-modules';
import { modelsModulePackage } from './models';
import { oscarModulePackage } from './oscar';
import { profileModulePackage } from './profile';
import { pluginsModulePackage } from './plugins';
import { securityModulePackage } from './security';
import { safeModulePackage } from './safe';
import { sharingModulePackage } from './sharing';
import { studioModulePackage } from './studio';
import { voiceModulePackage } from './voice';
import { workspaceModulePackage } from './workspace';
import { customToolsModulePackage } from './custom-tools';
import { telegramModulePackage } from './telegram';
import { deviceModulePackage } from './device';
import { coderModulePackage } from './coder';

export const builtInModulePackages: readonly MonarchModulePackage[] = [
  assistantModulePackage,
  workspaceModulePackage,
  artifactsModulePackage,
  knowledgeModulePackage,
  profileModulePackage,
  memoryModulePackage,
  monarchModulesModulePackage,
  studioModulePackage,
  astraModulePackage,
  diagnosticsModulePackage,
  pluginsModulePackage,
  modelsModulePackage,
  oscarModulePackage,
  securityModulePackage,
  safeModulePackage,
  sharingModulePackage,
  voiceModulePackage,
  telegramModulePackage,
  deviceModulePackage,
  customToolsModulePackage,
  coderModulePackage,
];
