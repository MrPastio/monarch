import Ajv2020 from 'ajv/dist/2020.js';
import { groqStrictTransport } from './groq-max-provider';
import { PortableMaxCloudProvider } from './max-cloud-portable';
import type { MaxCloudEffort, MaxCloudProviderId } from './max-cloud-catalog';

/** Desktop adapter. Cloud uses the same protocol with precompiled validators. */
export class MaxCloudProvider extends PortableMaxCloudProvider {
  constructor(options: { providerId: MaxCloudProviderId; apiKey: string; model: string; reasoningEffort?: MaxCloudEffort; fetch?: typeof fetch }) {
    super({ ...options, redirect: 'error', transport: groqStrictTransport,
      compile: schema => new Ajv2020({ strict: true }).compile(schema as object),
      diagnostic: entry => { process.stderr.write(JSON.stringify(entry) + '\n'); } });
  }
}
