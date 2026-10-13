import { listMaxCloudModels } from './max-cloud-models';
import { MAX_CLOUD_PROVIDERS, cloudProvider, cloudRole, maxCloudEffortTunable, parseCloudRole, validCloudModel, type MaxCloudEffort, type MaxCloudProviderId } from './max-cloud-catalog';
import { MaxCloudProvider } from './max-cloud-provider';
import { validAstraMaxConsent, type AstraMaxMessageV1, type AstraMaxProviderConsentV1 } from './max-provider-contract';
import type { AstraMaxSettingsStore } from './max-settings-store';
import type { AstraMaxHostService } from './max-host-service';
import type { AstraJson } from './journal';

/** Independent encrypted records; replacing one connection cannot replace another.
 * Provider and model travel in the task role, never an ambient active-provider flag. */
export class MaxCloudHost {
  private readonly verified = new Map<string, string>();
  private readonly configuring = new Set<string>();
  /** The person's depth for agent decisions; a chat turn carries its own. */
  private agentEffort: MaxCloudEffort | undefined;
  constructor(private readonly options: { store: (id: MaxCloudProviderId) => AstraMaxSettingsStore;
    groq: AstraMaxHostService; fetch?: typeof fetch; now?: () => number }) {}
  setReasoningEffort(value: MaxCloudEffort | undefined): void {
    if (value !== undefined && !['low', 'medium', 'high'].includes(value)) throw Error('astra-max-cloud:reasoning');
    this.agentEffort = value;
  }
  async models(input: { providerId: MaxCloudProviderId; apiKey: string }) {
    return listMaxCloudModels(input.providerId, input.apiKey, this.options.fetch);
  }
  async storedModels(providerId: MaxCloudProviderId) {
    const provider = cloudProvider(providerId);
    if (!provider) throw Error('astra-max-cloud:provider');
    if (provider.id === 'groq') return [{ id: provider.model, label: 'GPT OSS 120B' }];
    const connection = await this.options.store(provider.id).resolveConnection();
    return listMaxCloudModels(provider.id, connection.apiKey, this.options.fetch);
  }
  async view() {
    return Promise.all(MAX_CLOUD_PROVIDERS.map(async provider => {
      const status = await this.options.store(provider.id).status();
      const model = provider.id === 'groq' ? provider.model : status.modelId ?? provider.model;
      const legacy = provider.id === 'groq' ? await this.options.groq.setupView() : null;
      return { id: provider.id, name: provider.name, mark: provider.mark, model,
        role: provider.id === 'groq' ? 'max-gpt-oss-120b' : cloudRole(provider.id, model),
        keysUrl: provider.keys, termsUrl: provider.terms, privacyUrl: provider.privacy,
        effortTunable: maxCloudEffortTunable(provider.id, model),
        state: status.state, connectionVerified: legacy?.connectionVerified ?? this.verified.get(provider.id) === model };
    }));
  }
  async configure(input: { providerId: MaxCloudProviderId; modelId: string; apiKey: string; consent: AstraMaxProviderConsentV1 }) {
    const provider = cloudProvider(input.providerId);
    if (!provider || !validCloudModel(input.modelId)) throw Error('astra-max-cloud:model');
    if (!validAstraMaxConsent(input.consent, (this.options.now ?? Date.now)(), provider.id)) throw Error('astra-max-cloud:consent-required');
    if (this.configuring.has(provider.id)) throw Error('astra-max-cloud:busy');
    this.configuring.add(provider.id);
    try {
      if (provider.id === 'groq') {
        if (input.modelId !== provider.model) throw Error('astra-max-cloud:model-retired');
        await this.options.groq.configure(input);
      } else {
        await new MaxCloudProvider({ providerId: provider.id, model: input.modelId, apiKey: input.apiKey,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }).verify();
        await this.options.store(provider.id).saveSetup(input);
        this.verified.set(provider.id, input.modelId);
      }
      return this.view();
    } finally { this.configuring.delete(provider.id); }
  }
  async updateModel(input: { providerId: MaxCloudProviderId; modelId: string }) {
    const provider = cloudProvider(input.providerId);
    if (!provider || !validCloudModel(input.modelId)) throw Error('astra-max-cloud:model');
    if (provider.id === 'groq') {
      if (input.modelId !== provider.model) throw Error('astra-max-cloud:model-retired');
      return this.view();
    }
    if (this.configuring.has(provider.id)) throw Error('astra-max-cloud:busy');
    this.configuring.add(provider.id);
    try {
      const connection = await this.options.store(provider.id).resolveConnection();
      if (!connection.modelId) throw Error('astra-max-cloud:not-configured');
      if (!validAstraMaxConsent(connection.consent, (this.options.now ?? Date.now)(), provider.id)) {
        throw Error('astra-max-cloud:consent-required');
      }
      if (connection.modelId !== input.modelId) {
        await new MaxCloudProvider({ providerId: provider.id, model: input.modelId, apiKey: connection.apiKey,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }).verify();
        await this.options.store(provider.id).saveSetup({
          apiKey: connection.apiKey, consent: connection.consent, modelId: input.modelId,
        });
      }
      this.verified.set(provider.id, input.modelId);
      return this.view();
    } finally { this.configuring.delete(provider.id); }
  }
  async verify(providerId: MaxCloudProviderId) {
    if (!cloudProvider(providerId)) throw Error('astra-max-cloud:provider');
    if (providerId === 'groq') await this.options.groq.verifyConnection();
    else {
      const connection = await this.options.store(providerId).resolveConnection();
      if (!connection.modelId) throw Error('astra-max-cloud:not-configured');
      this.verified.delete(providerId);
      await new MaxCloudProvider({ providerId, model: connection.modelId, apiKey: connection.apiKey,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }).verify();
      this.verified.set(providerId, connection.modelId);
    }
    return this.view();
  }
  /** Streams a chat answer from the connected service; same connection, model and consent checks as propose. */
  async *streamText(input: { role: string; messages: readonly AstraMaxMessageV1[]; maxTokens: number; reasoningEffort?: MaxCloudEffort }, signal?: AbortSignal): AsyncGenerator<string, { modelId: string; stopReason: 'stop' | 'length' }> {
    const selection = parseCloudRole(input.role);
    if (!selection || selection.providerId === 'groq') throw Error('astra-max-cloud:model');
    const connection = await this.options.store(selection.providerId).resolveConnection();
    if (connection.modelId !== selection.model) throw Error('astra-max-cloud:connection-changed');
    if (!validAstraMaxConsent(connection.consent, (this.options.now ?? Date.now)(), selection.providerId)) throw Error('astra-max-cloud:consent-required');
    const ended = yield* new MaxCloudProvider({ ...selection, apiKey: connection.apiKey, ...effort(input.reasoningEffort),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }).streamText(input.messages, input.maxTokens, signal);
    return { modelId: selection.model, stopReason: ended.stopReason };
  }
  async propose(input: { role: string; messages: readonly AstraMaxMessageV1[]; responseSchema: AstraJson; maxTokens: number; reasoningEffort?: MaxCloudEffort }, signal?: AbortSignal) {
    const selection = parseCloudRole(input.role);
    if (!selection || selection.providerId === 'groq') throw Error('astra-max-cloud:model');
    const connection = await this.options.store(selection.providerId).resolveConnection();
    // Changing a configured model invalidates an old task instead of rerouting it.
    if (connection.modelId !== selection.model) throw Error('astra-max-cloud:connection-changed');
    if (!validAstraMaxConsent(connection.consent, (this.options.now ?? Date.now)(), selection.providerId)) throw Error('astra-max-cloud:consent-required');
    const value = await new MaxCloudProvider({ ...selection, apiKey: connection.apiKey, ...effort(input.reasoningEffort ?? this.agentEffort),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }).propose(input.messages, input.responseSchema, input.maxTokens, signal);
    return { value, modelId: selection.model };
  }
}

function effort(value: MaxCloudEffort | undefined) {
  if (value !== undefined && !['low', 'medium', 'high'].includes(value)) throw Error('astra-max-cloud:reasoning');
  return value ? { reasoningEffort: value } : {};
}
