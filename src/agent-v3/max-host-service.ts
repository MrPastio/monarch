import type { AstraContextPlan } from './context-engine';
import { AstraGroqMaxProvider } from './groq-max-provider';
import { decideAstraReadWithMax, type AstraMaxReadDecision } from './max-decision-bridge';
import {
  ASTRA_MAX_PROVIDER_ID,
  astraMaxInputDigest,
  validAstraMaxConsent,
  type AstraMaxDeployment,
  type AstraMaxMessageV1,
  type AstraMaxPrimaryModel,
  type AstraMaxProposalV1,
  type AstraMaxProviderConsentV1,
  type AstraMaxReasoningEffort,
} from './max-provider-contract';
import type { AstraJson } from './journal';
import type { AstraMaxSettingsStatus, AstraMaxSettingsStore } from './max-settings-store';
import { AstraMaxSettingsError } from './max-settings-store';
import type { AstraReadCandidate } from './read-decision-gateway';

export type AstraMaxSetupView = Readonly<{
  state: AstraMaxSettingsStatus['state'];
  connectionVerified: boolean;
  title: string;
  detail: string;
  nextAction: 'none' | 'connect' | 'reconnect' | 'retry';
  availableModels?: readonly string[];
}>;

/** Main/host composition only. Renderer-facing code receives SetupView, never settings or credentials. */
export class AstraMaxHostService {
  private connectionRevision = 0;
  private verifiedRevision: number | null = null;
  private availableModels: readonly string[] | undefined;

  constructor(private readonly options: {
    deployment: AstraMaxDeployment;
    settings: AstraMaxSettingsStore;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    if (!['isolated-validation', 'source-preview', 'native-desktop'].includes(options.deployment)) {
      throw new Error('astra-max-host:deployment');
    }
  }

  async setupView(): Promise<AstraMaxSetupView> {
    return { ...setupView(await this.options.settings.status(), this.isConnectionVerified()),
      ...(this.availableModels ? { availableModels: this.availableModels } : {}) };
  }

  async configure(input: { apiKey: string; consent: AstraMaxProviderConsentV1 }): Promise<AstraMaxSetupView> {
    if (!validAstraMaxConsent(input.consent, (this.options.now ?? Date.now)())) {
      throw new AstraMaxSettingsError('consent-required');
    }
    // A mistyped/expired replacement must not overwrite a working encrypted connection.
    const available = this.options.deployment === 'native-desktop'
      ? await this.provider(async () => input.apiKey).checkConnection() : undefined;
    const status = await this.options.settings.saveSetup(input);
    this.connectionRevision += 1;
    this.verifiedRevision = available ? this.connectionRevision : null;
    this.availableModels = available;
    return { ...setupView(status, Boolean(available)), ...(available ? { availableModels: available } : {}) };
  }

  async verifyConnection(): Promise<AstraMaxSetupView> {
    const revision = this.connectionRevision;
    const connection = await this.options.settings.resolveConnection();
    const available = await this.provider(async () => connection.apiKey).checkConnection();
    if (revision === this.connectionRevision) {
      this.availableModels = available;
      this.markConnectionVerified(revision);
    }
    return this.setupView();
  }

  private provider(resolveApiKey: () => Promise<string>): AstraGroqMaxProvider {
    return new AstraGroqMaxProvider({ deployment: this.options.deployment, resolveApiKey,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.now ? { now: this.options.now } : {}) });
  }

  async proposePrepared(input: {
    requestId: string;
    executionId: string;
    modelId: AstraMaxPrimaryModel;
    reasoningEffort: AstraMaxReasoningEffort;
    maxCompletionTokens: number;
    messages: readonly AstraMaxMessageV1[];
    responseSchema: AstraJson;
    signal?: AbortSignal;
  }): Promise<AstraMaxProposalV1> {
    if (input.modelId !== 'openai/gpt-oss-120b') throw Error('astra-max-native:model-retired');
    const connectionRevision = this.connectionRevision;
    const { signal, ...request } = input;
    const connection = await this.options.settings.resolveConnection();
    const provider = new AstraGroqMaxProvider({
      deployment: this.options.deployment,
      resolveApiKey: async () => connection.apiKey,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    const bound = { ...request, consent: connection.consent };
    const proposal = await provider.propose(bound, signal);
    if (proposal.inputDigest !== astraMaxInputDigest(bound)) throw new Error('astra-max-host:provider-input-binding');
    this.markConnectionVerified(connectionRevision);
    return proposal;
  }

  async decideRead(input: {
    context: AstraContextPlan;
    candidates: AstraReadCandidate[];
    requestId: string;
    modelId: AstraMaxPrimaryModel;
    reasoningEffort: AstraMaxReasoningEffort;
    maxCompletionTokens: number;
    controlEpoch: number;
    catalogRevision: number;
    isCurrent: () => boolean;
    signal?: AbortSignal;
  }): Promise<AstraMaxReadDecision> {
    if (input.modelId !== 'openai/gpt-oss-120b') return { status: 'blocked', code: 'model-retired',
      max: { requestId: input.requestId, providerId: ASTRA_MAX_PROVIDER_ID, modelId: input.modelId } };
    const connectionRevision = this.connectionRevision;
    let connection: Readonly<{ apiKey: string; consent: AstraMaxProviderConsentV1 }>;
    try { connection = await this.options.settings.resolveConnection(); }
    catch (error) {
      return { status: 'blocked', code: settingsCode(error),
        max: { requestId: input.requestId, providerId: ASTRA_MAX_PROVIDER_ID, modelId: input.modelId } };
    }
    const provider = new AstraGroqMaxProvider({
      deployment: this.options.deployment,
      resolveApiKey: async () => connection.apiKey,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    const decision = await decideAstraReadWithMax({ deployment: this.options.deployment,
      provider, consent: connection.consent, ...input });
    if (decision.status === 'accepted') this.markConnectionVerified(connectionRevision);
    return decision;
  }

  private isConnectionVerified(): boolean {
    return this.verifiedRevision === this.connectionRevision;
  }

  private markConnectionVerified(connectionRevision: number): void {
    if (connectionRevision === this.connectionRevision) this.verifiedRevision = connectionRevision;
  }
}

function settingsCode(error: unknown): string {
  if (!(error instanceof AstraMaxSettingsError)) return 'settings-unavailable';
  if (error.code === 'not-configured') return 'settings-not-configured';
  if (['encryption-unavailable', 'access-denied', 'root-unavailable', 'record-unavailable'].includes(error.code)) {
    return 'settings-unavailable';
  }
  return 'settings-corrupt';
}

function setupView(status: AstraMaxSettingsStatus, connectionVerified: boolean): AstraMaxSetupView {
  switch (status.state) {
  case 'ready':
    return connectionVerified
      ? Object.freeze({ state: status.state, connectionVerified, title: 'MAX готов',
        detail: 'Подключение проверено. MAX можно использовать для новых задач.', nextAction: 'none' })
      : Object.freeze({ state: status.state, connectionVerified, title: 'Ключ MAX сохранён',
        detail: 'Доступ проверится при первой задаче.', nextAction: 'none' });
  case 'not-configured':
    return Object.freeze({ state: status.state, connectionVerified: false, title: 'Подключи MAX',
      detail: 'Monarch пошагово поможет подключить облачные модели.', nextAction: 'connect' });
  case 'corrupt':
    return Object.freeze({ state: status.state, connectionVerified: false, title: 'Подключи MAX заново',
      detail: 'Сохранённое подключение нельзя безопасно использовать.', nextAction: 'reconnect' });
  case 'unavailable':
    return Object.freeze({ state: status.state, connectionVerified: false, title: 'MAX временно недоступен',
      detail: 'Не удалось безопасно сохранить подключение на этом устройстве.', nextAction: 'retry' });
  }
}
