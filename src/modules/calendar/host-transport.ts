import { LoopbackServiceHostTransport, type ServiceHostBinding } from '../service-host';

const bootstrapBinding = {
  endpoint: process.env.MONARCH_CALENDAR_HOST_ENDPOINT,
  token: process.env.MONARCH_CALENDAR_HOST_TOKEN,
};
delete process.env.MONARCH_CALENDAR_HOST_TOKEN;

export class CalendarHostTransport extends LoopbackServiceHostTransport {
  constructor(binding: ServiceHostBinding = bootstrapBinding) {
    super({ serviceId: 'calendar', ...binding });
  }
}
