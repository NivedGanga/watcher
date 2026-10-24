import { Resend } from 'resend';
import type { EmailProvider, EmailMessage } from './types.js';

export class ResendEmailProvider implements EmailProvider {
  private resend: Resend;

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    });
    if (error) {
      // Do not propagate the provider's message; it may echo recipients.
      throw new Error(`email send failed: ${error.name ?? 'unknown'}`);
    }
  }
}
