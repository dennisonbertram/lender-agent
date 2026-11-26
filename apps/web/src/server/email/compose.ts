// The alert email (BP-21): the loan, the status, a link to the alert. It carries no figure: every number
// stays in the app. Wording reuses `alertTitle` and `riskBanner`.
import { shortAddress } from "@/lib/address";
import { alertTitle, riskBanner } from "@/lib/loan-copy";
import { CHAIN_NAME as SHARED_CHAIN_NAME } from "@/shared/types";

const CHAIN_NAME: Record<number, string> = SHARED_CHAIN_NAME;

export const appUrl = (env: Record<string, string | undefined> = process.env) => (env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export function alertEmail(a: { safeName: string; safeAddress: string; chainId: number; venue: string; hf: number; alertId: number; unsubscribeToken: string }, env: Record<string, string | undefined> = process.env) {
  const base = appUrl(env);
  const link = `${base}/s/${a.safeAddress.toLowerCase()}/chat?alert=${a.alertId}`;
  const unsubscribeUrl = `${base}/api/alerts/unsubscribe?token=${a.unsubscribeToken}`;
  const name = a.safeName || shortAddress(a.safeAddress);
  const title = alertTitle(a.venue, a.hf);
  const subject = `${title} · ${name}`;
  const text = [
    `${name}: your ${a.venue} loan on ${CHAIN_NAME[a.chainId] ?? "this network"}.`,
    "",
    `${title}. ${riskBanner(a.hf, "none")}`,
    "",
    `See what you can do: ${link}`,
    "",
    "You get this because you gave this address for loan alerts. It is used for nothing else.",
    `Turn these emails off: ${unsubscribeUrl}`,
  ].join("\n");
  return { subject, text, unsubscribeUrl };
}

/** The co-signer email (flow-08): who sent what, on which Safe, how many approvals, one link. Wording: docs/ux-review/round2-email.md. */
export function cosignerEmail(a: { sender: string; title: string; safeName: string; safeAddress: string; chainId: number; threshold: number; owners: number; signed: number; signBy?: string; proposalId: string; unsubscribeUrl: string }, env: Record<string, string | undefined> = process.env) {
  const link = `${appUrl(env)}/s/${a.safeAddress.toLowerCase()}/proposals/${a.proposalId}`;
  const name = a.safeName || shortAddress(a.safeAddress);
  const subject = `Approval needed on your Safe ${shortAddress(a.safeAddress)}`;
  const text = [
    `${shortAddress(a.sender)} sent a plan that needs your approval.`,
    "",
    `Plan: ${a.title}`,
    `Safe: ${name} (${shortAddress(a.safeAddress)}) on ${CHAIN_NAME[a.chainId] ?? "this network"}`,
    `Approvals: it needs ${a.threshold} of ${a.owners} owners to approve. ${a.signed} so far.`,
    ...(a.signBy ? [`Sign by: ${new Date(a.signBy).toISOString().slice(0, 10)}`] : []),
    "",
    `Review and approve it here: ${link}`,
    "",
    "The agent cannot sign or move money. Only owners can. Before you approve in Safe, check that the code shown there matches the one in the app.",
    "",
    "You get this because you gave this address for loan alerts. It is used for nothing else.",
    `Turn these emails off: ${a.unsubscribeUrl}`,
  ].join("\n");
  return { subject, text, unsubscribeUrl: a.unsubscribeUrl };
}
