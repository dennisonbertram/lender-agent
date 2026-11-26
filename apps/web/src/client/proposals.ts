"use client";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "@/client/http";
import type { ProposalView } from "@/server/proposals/view";

const POLL_MS = 30_000;
/** A card that is open in a thread or panel re-reads this often until the proposal is final. */
const LIVE_MS = 5_000;
/** Dispatched on `window` after a Send to Safe succeeds: open cards re-read at once (an older plan becomes "Replaced"). */
export const PROPOSAL_SENT_EVENT = "lender:proposal-sent";
/** While an approval or send is in flight (or the network is running it), re-read fast. */
const FAST_MS = 2_000;

/** One proposal; re-read on mount and on window focus, and every 30 s (5 s with `live`) while mounted and not final. */
export const useProposal = (address: string, id: string, opts: { fast?: boolean; live?: boolean; enabled?: boolean } = {}) =>
  useQuery({
    enabled: opts.enabled ?? true,
    queryKey: ["proposals", address.toLowerCase(), id],
    queryFn: async () => (await getJson<{ proposal: ProposalView }>(`/api/safes/${address}/proposals/${id}`)).proposal,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.final ? false : opts.fast || q.state.data?.state === "sending" ? FAST_MS : opts.live ? LIVE_MS : POLL_MS),
  });

export const useProposals = (address: string, opts: { open?: boolean } = {}, enabled = true) =>
  useQuery({
    enabled,
    queryKey: ["proposals", address.toLowerCase(), "list", !!opts.open],
    queryFn: async () => (await getJson<{ proposals: ProposalView[] }>(`/api/safes/${address}/proposals/list${opts.open ? "?open=1" : ""}`)).proposals,
    refetchInterval: (q) => (q.state.data?.every((p) => p.final) ? false : POLL_MS),
  });
