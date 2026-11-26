// Email transport (BP-21, D-17). An `EmailProvider` sends one message; the per-alert `idempotencyKey`
// lets a retry of a message that did get through be ignored. The dev transport records messages
// (tests and MOCK); the HTTP provider (Resend, plain fetch, no SDK) is used only when RESEND_API_KEY is set.
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  /** Same key, same message: the provider must not send it twice. */
  idempotencyKey: string;
  /** One-click unsubscribe target (RFC 8058), when the message has one. */
  unsubscribeUrl?: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Records messages in memory. Sending the same idempotency key again records nothing. `failNext` makes the next sends throw. */
export class DevEmailProvider implements EmailProvider {
  readonly name = "dev";
  readonly sent: EmailMessage[] = [];
  failNext = 0;
  async send(message: EmailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("dev transport: scripted failure");
    }
    if (this.sent.some((m) => m.idempotencyKey === message.idempotencyKey)) return;
    this.sent.push(message);
  }
}

type Fetch = typeof fetch;

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private readonly opts: { apiKey: string; from: string; fetch?: Fetch; url?: string }) {}
  async send(m: EmailMessage): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(this.opts.url ?? "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", "idempotency-key": m.idempotencyKey },
      body: JSON.stringify({
        from: this.opts.from, to: [m.to], subject: m.subject, text: m.text,
        ...(m.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

const g = globalThis as unknown as { __devEmail?: DevEmailProvider };
/** The one dev transport of the process, so a test or the MOCK app can read what was "sent". */
export const devEmail = (): DevEmailProvider => (g.__devEmail ??= new DevEmailProvider());

/** The dev transport in MOCK or test (never a real send); else Resend when RESEND_API_KEY is set; otherwise null (email is not configured and nothing is sent). */
export function getEmailProvider(env: Record<string, string | undefined> = process.env): EmailProvider | null {
  if (env.MOCK === "1" || env.NODE_ENV === "test") return devEmail();
  if (env.RESEND_API_KEY && isUsableSender(env.EMAIL_FROM)) return new ResendProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM! });
  return null;
}

/** Only report real delivery when both the provider key and a non-placeholder sender are configured. */
export function emailDeliveryConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return env.MOCK !== "1" && env.NODE_ENV !== "test" && !!env.RESEND_API_KEY && isUsableSender(env.EMAIL_FROM);
}

function isUsableSender(from: string | undefined): boolean {
  if (!from) return false;
  const address = from.match(/<([^<>]+)>/)?.[1] ?? from;
  const match = address.match(/^[^\s@]+@([^\s@]+)$/);
  return !!match && !match[1].toLowerCase().endsWith(".invalid");
}
