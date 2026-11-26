"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/client/safes";
import type { AlertView } from "@/server/alerts/view";

const POLL_MS = 30_000;

/** One alert with its state against the live loan; re-read every 30 s while mounted. */
export const useAlert = (address: string, id: number) =>
  useQuery({
    queryKey: ["alerts", address.toLowerCase(), id],
    queryFn: async () => {
      const res = await fetch(`/api/safes/${address}/alerts/${id}`);
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? "Something went wrong");
      return ((await res.json()) as { alert: AlertView }).alert;
    },
    refetchInterval: POLL_MS,
  });

export type EmailSettings = { email: string | null; enabled: boolean; deliveryConfigured?: boolean };

/** The signed-in owner's alert email (BP-21): read, and save the address or the on/off choice. */
export function useEmailSettings() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["account", "email"],
    queryFn: async () => {
      const res = await fetch("/api/account/email");
      if (!res.ok) throw new ApiError(res.status, "Could not read your email settings.");
      return (await res.json()) as EmailSettings;
    },
  });
  const save = useMutation({
    mutationFn: async (next: { email?: string | null; enabled?: boolean }) => {
      const res = await fetch("/api/account/email", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not save. Try again.");
      return data as EmailSettings;
    },
    onSuccess: (data) => qc.setQueryData(["account", "email"], data),
  });
  return { query, save };
}
