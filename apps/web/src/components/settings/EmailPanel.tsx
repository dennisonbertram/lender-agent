"use client";
// Settings: where alert emails go, and an off switch (BP-21). The address is used for alerts only.
import { useEffect, useRef, useState } from "react";
import { Panel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type EmailSettings = { email: string | null; enabled: boolean; deliveryConfigured?: boolean };
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;

export function EmailPanel({ value, onSave }: { value: EmailSettings; onSave: (next: { email?: string | null; enabled?: boolean }) => Promise<EmailSettings | void> }) {
  const [email, setEmail] = useState(value.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => setEmail(value.email ?? ""), [value.email]);
  const run = async (next: Parameters<typeof onSave>[0], savedOverride?: string) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const result = await onSave(next);
      const to = result ? result.email : "email" in next ? next.email ?? null : value.email;
      const on = result ? result.enabled : "enabled" in next ? next.enabled : value.enabled;
      setSaved(savedOverride ?? ("enabled" in next
        ? (!on ? "Saved. Emails are off." : result?.deliveryConfigured === false ? "Saved, but email delivery is not configured here." : to ? `Saved. Alerts go to ${to}.` : "Saved. Emails are on, add an address to get them.")
        : result?.deliveryConfigured === false && on ? "Saved. Email address updated, but delivery is not configured here." : "Saved. Email address updated; delivery setting unchanged."));
    } catch (e) { setError(`${e instanceof Error ? e.message : "Could not save."} Not saved.`); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const changeDelivery = (enabled: boolean) => {
    const draft = email.trim();
    const original = value.email ?? "";
    const changed = draft !== original;
    if (enabled) {
      if (!validEmail(draft)) {
        setSaved(null);
        setError("Enter a valid email address before turning email alerts on.");
        return;
      }
      void run(changed ? { email: draft, enabled: true } : { enabled: true });
      return;
    }
    if (!changed) { void run({ enabled: false }); return; }
    if (!draft) { void run({ enabled: false }); return; }
    if (validEmail(draft)) { void run({ email: draft, enabled: false }); return; }
    void run({ enabled: false }, "Saved. Emails are off. The edited address was not saved because it is invalid.");
  };
  return (
    <Panel title="Email alerts">
      <p className="text-sm text-muted-foreground">Alerts can notify you when a loan falls below your At-risk level or a plan needs approval. Email depends on an enabled address and available delivery. Email is used only for alerts.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="email" aria-label="Email address" className="max-w-xs" value={email} placeholder="you@example.com" disabled={saving} onChange={(e) => setEmail(e.target.value)} />
        <Button size="sm" variant="outline" disabled={saving} onClick={() => run({ email: email.trim() || null })}>{saving ? "Saving…" : "Save"}</Button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.enabled} disabled={saving} onChange={(e) => changeDelivery(e.target.checked)} /> Send me email
        </label>
      </div>
      <p className="text-sm text-muted-foreground">{value.deliveryConfigured === false ? "Email delivery is not configured here." : !value.enabled ? "Email alerts are off." : !value.email ? "Add an email address to receive alerts while you are away." : `Alerts are set to go to ${value.email}.`}</p>
      {saved && !error && <p role="status" className="text-sm text-success">{saved}</p>}
      {error && <p role="alert" className="text-sm text-destructive-text">{error}</p>}
    </Panel>
  );
}
