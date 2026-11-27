"use client";
import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The message box: a pill with a send button (mockup `ChatThread`). */
export function Composer({ placeholder, disabled, lockInput, guideTarget, onSend }: { placeholder: string; disabled?: boolean; lockInput?: boolean; guideTarget?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    onSend(v);
    setText("");
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pr-1.5 pl-4 focus-within:ring-2 focus-within:ring-ring">
      <input
        data-guide-target={guideTarget ? "chat-compose" : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        disabled={lockInput}
        aria-label="Message"
        className="min-w-0 flex-1 self-stretch bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
      />
      <Button type="submit" size="icon" className="rounded-full" aria-label="Send" disabled={disabled || !text.trim()}><ArrowUp /></Button>
    </form>
  );
}
