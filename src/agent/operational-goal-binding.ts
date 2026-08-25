import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseExactWorkspaceFileWrites } from '../core/argument-builder';
import { sameCanonicalFilesystemPath } from '../core/known-folder-target';
import { parseKnownFolderFileRequest } from '../core/known-folder-target';
import { isComputerUseInvocation } from '../core/oscar-function-invocation';
import {
  normalizeApplicationRequest,
  normalizeBrowserRequest,
  resolveDeviceIntentAction,
} from '../modules/device';
import {
  isWorkspaceRootRequest,
  parseWorkspaceStorageAuditRequest,
} from '../modules/workspace';

export interface AgentOperationalRequirement {
  capabilityId: string;
  input: Record<string, unknown>;
  effectful: boolean;
}

/** Deterministic, runtime-owned requirements derived from the original user text. */
export function resolveAgentOperationalRequirements(requestText: string): AgentOperationalRequirement[] {
  const request = String(requestText || '').trim();
  if (!request) return [];
  // Explicit Computer Use owns the effect path end-to-end. A coincidental
  // phrase such as "открой Steam" must not also create a hidden direct Device
  // requirement that could bypass the visible cursor route.
  if (isComputerUseInvocation(request)) return [];
  const requirements: AgentOperationalRequirement[] = [];
  const knownFolderWrite = parseKnownFolderFileRequest(request);
  const audit = parseWorkspaceStorageAuditRequest(request);
  if (audit) requirements.push({ capabilityId: 'workspace.storage.audit', input: audit, effectful: false });
  if (isWorkspaceRootRequest(request.toLowerCase())) {
    requirements.push({ capabilityId: 'workspace.root.get', input: {}, effectful: false });
  }
  if (knownFolderWrite) {
    requirements.push({
      capabilityId: 'workspace.known-folder.write',
      input: { ...knownFolderWrite },
      effectful: true,
    });
  } else {
    for (const write of parseExactWorkspaceFileWrites(request)) {
      requirements.push({ capabilityId: 'workspace.files.write', input: { ...write }, effectful: true });
    }
  }

  // Device intent classifiers operate on one bounded clause at a time. Feeding
  // the whole multi-clause request to every domain lets an affirmative verb or
  // numeric slot leak into an unrelated/negated clause (for example,
  // "set brightness to 37. Do not change volume" becoming volume=37).
  const clauses = request
    .split(/\s*(?:,?\s+(?:then|then\s+also|and\s+then|затем|потом|после\s+этого)|\s+(?:и|and)\s+(?=(?:постав|установ|измени|увелич|уменьш|открой|закрой|запусти|яркост|громкост|экран|браузер|set|change|increase|decrease|open|close|launch|volume|brightness)\p{L}*)|[;\n]|[.!?]\s+(?=(?:постав|установ|измени|увелич|уменьш|открой|закрой|запусти|не\s+|яркост|громкост|экран|браузер|set|change|increase|decrease|open|close|launch|do\s+not\s+|volume|brightness)\p{L}*)|,\s+(?=(?:не\s+|do\s+not\s+|яркост|громкост|volume|brightness)\p{L}*))\s*/iu)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const action = resolveDeviceIntentAction(clause);
    if (action) requirements.push({
      capabilityId: action.capabilityId,
      input: action.input,
      effectful: action.risk !== 'read',
    });
  }

  const deduplicated = new Map<string, AgentOperationalRequirement>();
  for (const requirement of requirements) {
    const key = `${requirement.capabilityId}\u0000${stableInput(requirement.input)}`;
    deduplicated.set(key, requirement);
  }
  return [...deduplicated.values()];
}

export function operationalRequirementMatches(
  requirement: AgentOperationalRequirement,
  capabilityId: string,
  outputValue: unknown,
): boolean {
  if (capabilityId !== requirement.capabilityId) return false;
  const output = asRecord(outputValue);
  if (!output) return false;
  switch (requirement.capabilityId) {
  case 'device.volume.set':
    return volumeOutputMatches(requirement.input, output);
  case 'device.volume.get':
    return output.verified === true
      && output.operation === 'get'
      && isPercent(output.level)
      && typeof output.muted === 'boolean';
  case 'device.brightness.set':
    return brightnessOutputMatches(requirement.input, output);
  case 'device.brightness.get':
    return output.verified === true
      && output.operation === 'get'
      && isPercent(output.level);
  case 'device.app.open':
    return output.opened === true
      && output.verified === true
      && normalizedApplication(output.app) === normalizedApplication(requirement.input.app);
  case 'device.browser.open': {
    let expected: ReturnType<typeof normalizeBrowserRequest>;
    try {
      expected = normalizeBrowserRequest(requirement.input);
    } catch {
      return false;
    }
    return output.opened === true
      && output.verified === true
      && output.target === expected.target
      && output.browser === expected.browser
      && output.provider === expected.provider
      && (expected.query === undefined || output.query === expected.query);
  }
  case 'device.browser.close-active':
    return output.closed === true && output.verified === true;
  case 'device.recycle-bin.empty':
    return output.emptied === true && output.verified === true;
  case 'device.system.time.get':
    return output.verified === true && output.kind === requirement.input.kind;
  case 'workspace.root.get':
    return typeof output.workspaceRoot === 'string' && output.workspaceRoot.trim().length > 0;
  case 'workspace.storage.audit': {
    if (output.observationVerified !== true) return false;
    const audit = asRecord(output.audit);
    if (!audit || typeof audit.root !== 'string' || !audit.root.trim()) return false;
    const expectedRoot = typeof requirement.input.root === 'string' ? requirement.input.root.trim() : '';
    return !expectedRoot || sameStorageRoot(audit.root, expectedRoot);
  }
  case 'workspace.files.write': {
    const expectedPath = typeof requirement.input.path === 'string' ? requirement.input.path : '';
    const expectedContent = typeof requirement.input.content === 'string' ? requirement.input.content : '';
    const expectedBytes = Buffer.from(expectedContent, 'utf8');
    return output.verified === true
      && typeof output.path === 'string'
      && sameRequirementPath(output.path, expectedPath)
      && output.bytes === expectedBytes.byteLength
      && output.readbackSha256 === createHash('sha256').update(expectedBytes).digest('hex');
  }
  case 'workspace.known-folder.write': {
    const expectedContent = typeof requirement.input.content === 'string' ? requirement.input.content : '';
    const expectedBytes = Buffer.from(expectedContent, 'utf8');
    return output.verified === true
      && output.knownFolder === requirement.input.knownFolder
      && output.basename === requirement.input.basename
      && output.bytes === expectedBytes.byteLength
      && output.readbackSha256 === createHash('sha256').update(expectedBytes).digest('hex');
  }
  default:
    return false;
  }
}

export function operationalRequirementInputMatches(
  requirement: AgentOperationalRequirement,
  capabilityId: string,
  inputValue: unknown,
  workspaceRoot = process.cwd(),
): boolean {
  if (capabilityId !== requirement.capabilityId) return false;
  const input = asRecord(inputValue);
  if (!input) return false;
  switch (requirement.capabilityId) {
  case 'device.volume.set':
    return input.action === requirement.input.action
      && (input.action === 'set' ? input.value === requirement.input.value : true)
      && (input.action === 'change' ? input.delta === requirement.input.delta : true);
  case 'device.brightness.set':
    return input.operation === requirement.input.operation
      && (input.operation === 'set' ? input.value === requirement.input.value : true)
      && (input.operation === 'change' ? input.delta === requirement.input.delta : true);
  case 'device.app.open':
    try {
      return normalizeApplicationRequest(input.app) === normalizeApplicationRequest(requirement.input.app);
    } catch {
      return false;
    }
  case 'device.browser.open':
    try {
      const expected = normalizeBrowserRequest(requirement.input);
      const actual = normalizeBrowserRequest(input);
      return expected.target === actual.target
        && expected.browser === actual.browser
        && expected.provider === actual.provider
        && expected.query === actual.query;
    } catch {
      return false;
    }
  case 'workspace.storage.audit': {
    const expectedRoot = typeof requirement.input.root === 'string' ? requirement.input.root.trim() : '';
    const actualRoot = typeof input.root === 'string' ? input.root.trim() : '';
    return !expectedRoot || (Boolean(actualRoot) && sameStorageRoot(actualRoot, expectedRoot));
  }
  case 'workspace.files.write': {
    const expectedPath = typeof requirement.input.path === 'string' ? requirement.input.path : '';
    const actualPath = typeof input.path === 'string' ? input.path : '';
    return Boolean(expectedPath && actualPath)
      && sameRequirementPath(actualPath, expectedPath, workspaceRoot)
      && input.content === requirement.input.content
      && Boolean(input.overwrite) === Boolean(requirement.input.overwrite);
  }
  case 'workspace.known-folder.write':
    return input.knownFolder === requirement.input.knownFolder
      && input.basename === requirement.input.basename
      && input.content === requirement.input.content
      && input.overwrite === false;
  case 'device.volume.get':
  case 'device.brightness.get':
  case 'device.browser.close-active':
  case 'device.recycle-bin.empty':
  case 'device.system.time.get':
  case 'workspace.root.get':
    return Object.keys(input).every((key) => requirement.input[key] === input[key]);
  default:
    return false;
  }
}

function sameRequirementPath(left: string, right: string, workspaceRoot = process.cwd()): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(workspaceRoot, value).replace(/[\\/]+$/u, '');
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return Boolean(left && right) && normalize(left) === normalize(right);
}

function sameStorageRoot(left: string, right: string): boolean {
  const normalizeDrive = (value: string): string => (
    /^[a-z]:[\\/]?$/iu.test(value.trim()) ? `${value.trim().slice(0, 2)}\\` : value.trim()
  );
  return sameCanonicalFilesystemPath(normalizeDrive(left), normalizeDrive(right));
}

function volumeOutputMatches(input: Record<string, unknown>, output: Record<string, unknown>): boolean {
  const action = String(input.action || '');
  if (output.verified !== true || output.operation !== action || !isPercent(output.level)) return false;
  if (action === 'set') {
    const value = Number(input.value);
    return Number.isInteger(value)
      && output.requestedValue === value
      && Math.abs(Number(output.level) - value) <= 1;
  }
  if (action === 'change') {
    const delta = Number(input.delta);
    const before = Number(output.before);
    if (!Number.isInteger(delta) || !isPercent(before) || output.requestedDelta !== delta) return false;
    const expected = Math.max(0, Math.min(100, Math.round(before + delta)));
    return Math.abs(Number(output.level) - expected) <= 1;
  }
  if (action === 'mute') return output.muted === true;
  if (action === 'unmute') return output.muted === false;
  return false;
}

function brightnessOutputMatches(input: Record<string, unknown>, output: Record<string, unknown>): boolean {
  const operation = String(input.operation || '');
  if (output.verified !== true || output.operation !== operation || !isPercent(output.level)) return false;
  if (operation === 'set') {
    const value = Number(input.value);
    return Number.isInteger(value)
      && output.requested === value
      && Math.abs(Number(output.level) - value) <= 1;
  }
  if (operation === 'change') {
    const delta = Number(input.delta);
    const before = Number(output.before);
    if (!Number.isInteger(delta) || !isPercent(before)) return false;
    const expected = Math.max(0, Math.min(100, Math.round(before + delta)));
    return output.requested === expected && Math.abs(Number(output.level) - expected) <= 1;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedApplication(value: unknown): string {
  try {
    return normalizeApplicationRequest(value);
  } catch {
    return '';
  }
}

function isPercent(value: unknown): boolean {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
}

function stableInput(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}
