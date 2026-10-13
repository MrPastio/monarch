import { LoopbackServiceHostTransport, type ServiceHostBinding } from '../service-host';

const bootstrapBinding = {
  endpoint: process.env.MONARCH_GITHUB_HOST_ENDPOINT,
  token: process.env.MONARCH_GITHUB_HOST_TOKEN,
};
delete process.env.MONARCH_GITHUB_HOST_TOKEN;

export class GitHubHostTransport extends LoopbackServiceHostTransport {
  constructor(binding: ServiceHostBinding = bootstrapBinding) {
    super({ serviceId: 'github', ...binding });
  }
}
