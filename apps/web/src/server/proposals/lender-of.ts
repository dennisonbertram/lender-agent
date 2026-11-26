// Which lender a stored proposal is for. An open names its venue, a protect names it in the loan id
// (`chain:safe:lender`, as the loans the lenders read are numbered); everything else is Aave (M1).
import type { Spec } from "@/lib/proposals";
import { AAVE_VENUE_ID } from "@/server/market-inputs";
import type { LenderId } from "@/server/lenders/types";

export const lenderOfSpec = (spec: Pick<Spec, "kind"> & Partial<{ venueId: string; loanId: string }>): LenderId =>
  (spec.kind === "open" ? spec.venueId : spec.kind === "protect" || spec.kind === "close" || spec.kind === "repay" ? spec.loanId?.split(":")[2] : undefined) as LenderId ?? AAVE_VENUE_ID;
