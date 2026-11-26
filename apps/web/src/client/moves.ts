"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/client/safes";
import type { MoveView } from "@/server/moves/service";

const POLL_MS = 30_000;
const FINAL = ["arrived", "partial", "refunded", "failed", "closed", "expired"];

/** One move card; re-read every 30 s until it settles. */
export const useMove = (address: string, id: string) =>
  useQuery({
    queryKey: ["moves", address.toLowerCase(), id],
    queryFn: async () => {
      const res = await fetch(`/api/safes/${address}/moves/${id}`);
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? "Something went wrong");
      return ((await res.json()) as { move: MoveView }).move;
    },
    refetchInterval: (q) => (q.state.data && FINAL.includes(q.state.data.status) ? false : POLL_MS),
  });

/** "Send move to Safe (step 1 of 2)": the answer carries the receipt; the card and the thread are refetched. */
export function useSendMove(address: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/safes/${address}/moves/${id}/send`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body?.line ?? body?.error ?? "Something went wrong");
      return body as { proposalId: string; receipt: string | null };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["moves", address.toLowerCase()] });
      void qc.invalidateQueries({ queryKey: ["proposals", address.toLowerCase()] });
      void qc.invalidateQueries({ queryKey: ["chat", address.toLowerCase()] });
    },
  });
}
