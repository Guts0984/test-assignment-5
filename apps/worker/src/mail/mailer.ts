import nodemailer from 'nodemailer';

export type Mail = { to: string; subject: string; text: string; html: string; messageId: string };

/** Sends one email or throws. A function type, so tests can substitute a fake. */
export type Mailer = (mail: Mail) => Promise<void>;

/** SMTP to the mail catcher. Every wait is bounded, so an unreachable server fails fast. */
export const createMailer = (smtp: { host: string; port: number; from: string }): Mailer => {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return async (mail) => {
    await transport.sendMail({
      from: smtp.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      // Stable per delivery: a mail client or server can recognise a resend as the same message.
      messageId: mail.messageId,
    });
  };
};
