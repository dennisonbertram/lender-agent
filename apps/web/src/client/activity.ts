"use client";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/client/http";
import type { ActivityView } from "@/server/activity-view";

export type { ActivityView };

export function useActivity(address: string) {
  return useQuery({
    queryKey: ["activity", address.toLowerCase()],
    refetchInterval: 15_000,
    queryFn: async (): Promise<ActivityView[]> => (await getJson<{ activity: ActivityView[] }>(`/api/safes/${address}/activity`)).activity,
  });
}
