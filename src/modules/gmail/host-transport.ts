import { LoopbackServiceHostTransport, type ServiceHostBinding } from '../service-host';

const bootstrapBinding = {
  endpoint: process.env.MONARCH_GMAIL_HOST_ENDPOINT,
  token: process.env.MONARCH_GMAIL_HOST_TOKEN,
};
delete process.env.MONARCH_GMAIL_HOST_TOKEN;

export class GmailHostTransport extends LoopbackServiceHostTransport {
  constructor(binding: ServiceHostBinding = bootstrapBinding) {
    super({ serviceId: 'gmail', ...binding });
  }
}
