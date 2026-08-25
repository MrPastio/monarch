import type {
  MonarchSettingsBackend,
  MonarchSettingsCommandPolicy,
  MonarchSettingsCommandRequestV1,
  MonarchSettingsReadRequestV1,
  MonarchSettingsReadResultV1,
  MonarchSettingsWriteReceiptV1,
} from './contracts';

export class MonarchSettingsCommandError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MonarchSettingsCommandError';
  }
}

export class SettingsCommandBus {
  constructor(
    private readonly backend: MonarchSettingsBackend,
    private readonly policy: MonarchSettingsCommandPolicy,
    private readonly authority: { tier: string; source: string } = { tier: 'public', source: 'default' },
  ) {}

  async read(
    request: MonarchSettingsReadRequestV1,
    source: 'desktop' | 'api',
  ): Promise<MonarchSettingsReadResultV1> {
    if (source !== 'desktop') {
      throw new MonarchSettingsCommandError(
        403,
        'settings-desktop-required',
        'Local context settings are available only to an attested Desktop session.',
      );
    }
    validateReadRequest(request);
    this.enforceOwnerDevAccess(request.kind);
    const result = await this.backend.read(request);
    validateReadBack(result, request);
    return result;
  }

  async execute(
    request: MonarchSettingsCommandRequestV1,
    source: 'desktop' | 'api',
  ): Promise<MonarchSettingsWriteReceiptV1> {
    if (source !== 'desktop') {
      throw new MonarchSettingsCommandError(
        403,
        'settings-desktop-required',
        'Local context settings can be changed only by an attested Desktop session.',
      );
    }
    validateCommandRequest(request);
    this.enforceOwnerDevAccess(request.command.split('.')[0] || '');
    const decision = this.policy.evaluateLocalSettingsCommand({
      source,
      command: request.command,
      scope: request.scope,
      payload: request.payload,
    });
    if (decision.outcome !== 'allow') {
      throw new MonarchSettingsCommandError(403, 'settings-policy-denied', decision.reason);
    }
    const receipt = await this.backend.execute({
      ...request,
      policyDecisionHash: decision.policyDecisionHash,
    });
    validateReceipt(receipt, request, decision.policyDecisionHash);
    return receipt;
  }

  private enforceOwnerDevAccess(kind: string): void {
    if (!['prompts', 'dev', 'owner-override'].includes(kind)) return;
    if (this.authority.tier === 'owner' && this.authority.source === 'signed-device-entitlement') return;
    throw new MonarchSettingsCommandError(
      403,
      'settings-owner-required',
      'Oscar DEV settings require a verified signed owner entitlement.',
    );
  }
}

function validateReadRequest(request: MonarchSettingsReadRequestV1): void {
  if (request.schemaVersion !== 1) invalid('Unsupported settings read schema version.');
  if (!['memory', 'profile', 'personality', 'voice', 'prompts', 'dev', 'owner-override'].includes(request.kind)) {
    invalid('Unknown settings context kind.');
  }
  validateScope(request.scope);
  if (['prompts', 'dev', 'owner-override'].includes(request.kind) && request.scope.type !== 'chat') {
    invalid('Owner DEV settings support only the global chat scope.');
  }
}

function validateCommandRequest(request: MonarchSettingsCommandRequestV1): void {
  if (request.schemaVersion !== 1) invalid('Unsupported settings command schema version.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.clientRequestId)) {
    invalid('clientRequestId is invalid.');
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    invalid('expectedRevision must be a non-negative integer.');
  }
  if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
    invalid('Settings command payload must be an object.');
  }
  validateScope(request.scope);
}

function validateScope(scope: MonarchSettingsReadRequestV1['scope']): void {
  if (scope.type === 'chat') {
    if ('projectId' in scope && scope.projectId) invalid('Chat scope cannot carry projectId.');
    return;
  }
  if (scope.type !== 'coder-project' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(scope.projectId)) {
    invalid('Coder scope requires a bounded projectId.');
  }
}

function validateReadBack(
  result: MonarchSettingsReadResultV1,
  request: MonarchSettingsReadRequestV1,
): void {
  if (result.schemaVersion !== 1 || result.kind !== request.kind) {
    throw new MonarchSettingsCommandError(502, 'settings-readback-invalid', 'Settings service returned an invalid read-back.');
  }
  if (!Number.isSafeInteger(result.revision) || result.revision < 0 || !isSha256(result.contentHash)) {
    throw new MonarchSettingsCommandError(502, 'settings-readback-invalid', 'Settings read-back revision or hash is invalid.');
  }
}

function validateReceipt(
  receipt: MonarchSettingsWriteReceiptV1,
  request: MonarchSettingsCommandRequestV1,
  policyDecisionHash: string,
): void {
  const valid = receipt.schemaVersion === 1
    && receipt.clientRequestId === request.clientRequestId
    && receipt.command === request.command
    && receipt.policyDecisionHash === policyDecisionHash
    && Number.isSafeInteger(receipt.revision)
    && receipt.revision >= 0
    && isSha256(receipt.contentHash)
    && receipt.contentHash === receipt.readBackHash;
  if (!valid) {
    throw new MonarchSettingsCommandError(
      502,
      'settings-receipt-invalid',
      'Settings service did not prove the committed read-back.',
    );
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function invalid(message: string): never {
  throw new MonarchSettingsCommandError(400, 'settings-request-invalid', message);
}
