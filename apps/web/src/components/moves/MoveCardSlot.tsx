"use client";
// Renders a stored move inside the chat (a `data-move` part).
import { useMove, useSendMove } from "@/client/moves";
import { MoveCard } from "./MoveCard";

export function MoveCardSlot({ safeAddress, moveId }: { safeAddress: string; moveId: string }) {
  const { data, error } = useMove(safeAddress, moveId);
  const send = useSendMove(safeAddress, moveId);
  if (error) return <p role="alert" className="text-sm text-muted-foreground">We could not load this move.</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <MoveCard move={data} sending={send.isPending} onSend={() => send.mutate()} error={send.isError ? send.error.message : null} />;
}
