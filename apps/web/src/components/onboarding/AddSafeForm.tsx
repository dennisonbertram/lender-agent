"use client";
import { useState } from "react";
import { validateAddress } from "@/lib/address";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/** "Add by address" (r21). Local errors first; the server adds "not an owner". */
export function AddSafeForm({ existing, busy, serverError, onSubmit, onCancel }: {
  existing: string[];
  busy?: boolean;
  serverError?: string | null;
  onSubmit: (v: { address: string; name: string }) => void;
  onCancel?: () => void;
}) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const local = validateAddress(address, existing);
  const err = local ?? (tried ? serverError ?? null : null);
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => { e.preventDefault(); setTried(true); if (!local) onSubmit({ address: address.trim(), name: name.trim() }); }}
    >
      <Field label="Safe address" tone={(tried || address) && err ? "error" : "hint"} message={tried || address ? err ?? undefined : "Copy it from your Safe app, under the Safe's name."}>
        {(p) => <Input {...p} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 0x4a1c…9e2f" />}
      </Field>
      <Field label="Name (optional)">
        {(p) => <Input {...p} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ops Safe" />}
      </Field>
      <div className="flex gap-2">
        {onCancel && <Button size="lg" variant="ghost" type="button" disabled={busy} onClick={onCancel}>Cancel</Button>}
        <Button size="lg" type="submit" disabled={busy} className="flex-1">Add this Safe</Button>
      </div>
    </form>
  );
}
