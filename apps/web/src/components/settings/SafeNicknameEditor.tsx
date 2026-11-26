"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SafeNicknameEditor({ address, safeName, nickname, enabled = true, setSafeNickname }: { address: string; safeName: string; nickname?: string; enabled?: boolean; setSafeNickname: (address: string, value: string) => boolean }) {
  // Undefined means untouched, so a nickname loaded from storage after mount stays in the field.
  const [draft, setDraft] = useState<string>();
  const [message, setMessage] = useState("");
  const value = draft ?? nickname ?? "";
  const save = (nextValue: string) => {
    const stored = setSafeNickname(address, nextValue);
    if (stored) {
      setDraft(undefined);
      setMessage(nextValue.trim() ? "Nickname saved in this browser." : "Nickname removed. Showing the default name.");
    } else {
      setMessage("Nickname could not be saved. Your current name is unchanged; check browser storage and try again.");
    }
  };
  return (
    <section aria-label="Safe nickname" className="rounded-xl border border-edge p-3">
      <label htmlFor="safe-nickname" className="mb-1 block text-sm font-medium">Safe nickname</label>
      <p className="mb-2 text-xs text-muted-foreground">Default name: <span className="font-medium text-foreground">{safeName}</span>. A nickname changes only what this browser displays; it is stored for this wallet and Safe.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input id="safe-nickname" aria-label="Safe nickname" maxLength={40} disabled={!enabled} value={value} onChange={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") { if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return; e.preventDefault(); save(value); } }} placeholder={safeName} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" />
        <Button size="sm" disabled={!enabled} onClick={() => save(value)}>Save nickname</Button>
        {nickname !== undefined && <Button size="sm" variant="outline" disabled={!enabled} onClick={() => save("")}>Use default name</Button>}
      </div>
      {!enabled && <p className="mt-2 text-xs text-muted-foreground">Connect a wallet to edit this Safe nickname.</p>}
      {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
    </section>
  );
}
