import type { Logger } from "pino";

/**
 * Report email delivery. Resend (HTTPS API) when RESEND_API_KEY is set;
 * otherwise the job stores the report row + PDF and marks the email as
 * skipped — reports are never blocked on email configuration.
 *
 * Copy rules apply here the same as the UI: contractions, name the enemy
 * (waste), end with periods, no banned words, no exclamation spam.
 */

export interface ReportEmail {
  to: string[];
  subject: string;
  text: string;
  pdfFileName: string;
  pdfBytes: Uint8Array;
}

export interface EmailSender {
  send(email: ReportEmail): Promise<void>;
}

export interface SentEmail extends ReportEmail {
  from: string;
}

/** Records every send; used in tests and as the local-dev sink. */
export class StubEmailSender implements EmailSender {
  readonly sent: SentEmail[] = [];

  constructor(private readonly from: string) {}

  send(email: ReportEmail): Promise<void> {
    this.sent.push({ ...email, from: this.from });
    return Promise.resolve();
  }
}

type FetchLike = typeof fetch;

export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: FetchLike;
  readonly #logger: Logger;

  constructor(options: {
    apiKey: string;
    from: string;
    logger: Logger;
    fetchFn?: FetchLike;
  }) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#logger = options.logger;
    this.#fetch = options.fetchFn ?? fetch;
  }

  async send(email: ReportEmail): Promise<void> {
    const res = await this.#fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.#from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        attachments: [
          {
            filename: email.pdfFileName,
            content: Buffer.from(email.pdfBytes).toString("base64"),
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.#logger.warn(
        { status: res.status },
        "resend send failed",
      );
      throw new Error(`resend send failed with status ${res.status}: ${body.slice(0, 200)}`);
    }
  }
}

/** Build the sender for this environment: Resend when configured, the
 *  recording stub otherwise (reports are generated either way). */
export function createEmailSender(options: {
  resendApiKey: string | undefined;
  from: string;
  logger: Logger;
  fetchFn?: FetchLike;
}): EmailSender {
  if (options.resendApiKey === undefined) {
    return new StubEmailSender(options.from);
  }
  return new ResendEmailSender({
    apiKey: options.resendApiKey,
    from: options.from,
    logger: options.logger,
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });
}
