import { describe, expect, it, vi } from "vitest";
import { DevEmailProvider, emailDeliveryConfigured, getEmailProvider, ResendProvider } from "./provider";

describe("email provider selection (D-17)", () => {
  it("is Resend only when RESEND_API_KEY is set", () => {
    expect(getEmailProvider({ RESEND_API_KEY: "re_test", EMAIL_FROM: "Lender <alerts@example.com>" })?.name).toBe("resend");
    expect(getEmailProvider({ MOCK: "1" })).toBeInstanceOf(DevEmailProvider);
    expect(getEmailProvider({})).toBeNull();
    expect(getEmailProvider({ RESEND_API_KEY: "re_test" })).toBeNull();
    expect(getEmailProvider({ RESEND_API_KEY: "re_test", EMAIL_FROM: "alerts@example.invalid" })).toBeNull();
    expect(emailDeliveryConfigured({ RESEND_API_KEY: "re_test", EMAIL_FROM: "Lender <alerts@example.com>" })).toBe(true);
    expect(emailDeliveryConfigured({ MOCK: "1", RESEND_API_KEY: "re_test", EMAIL_FROM: "alerts@example.com" })).toBe(false);
    expect(emailDeliveryConfigured({ NODE_ENV: "test", RESEND_API_KEY: "re_test", EMAIL_FROM: "alerts@example.com" })).toBe(false);
  });

  it("uses the dev transport in MOCK or test even when RESEND_API_KEY is set", () => {
    expect(getEmailProvider({ MOCK: "1", RESEND_API_KEY: "re_test" })).toBeInstanceOf(DevEmailProvider);
    expect(getEmailProvider({ NODE_ENV: "test", RESEND_API_KEY: "re_test" })).toBeInstanceOf(DevEmailProvider);
  });

  it("Resend posts JSON with a bearer key and the idempotency key, and throws on a non-2xx answer", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const p = new ResendProvider({ apiKey: "re_test", from: "A <a@example.com>", fetch: f as unknown as typeof fetch });
    await p.send({ to: "x@example.com", subject: "S", text: "T", idempotencyKey: "k1", unsubscribeUrl: "https://u" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({ authorization: "Bearer re_test", "idempotency-key": "k1" });
    expect(JSON.parse(init.body as string)).toMatchObject({ from: "A <a@example.com>", to: ["x@example.com"], subject: "S", text: "T" });
    const bad = new ResendProvider({ apiKey: "k", from: "f", fetch: (async () => new Response("no", { status: 500 })) as typeof fetch });
    await expect(bad.send({ to: "x@example.com", subject: "S", text: "T", idempotencyKey: "k2" })).rejects.toThrow(/500/);
  });
});
