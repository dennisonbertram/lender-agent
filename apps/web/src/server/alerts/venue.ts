// The lender of a loan, from the loan id `${chainId}:${safe}:${lender}` (monitor, alerts and loans all use it).
import { AAVE_VENUE_NAME } from "@/server/market-inputs";

const NAMES: Record<string, string> = { "aave-v3": AAVE_VENUE_NAME, "compound-v3": "Compound v3", "morpho-blue": "Morpho" };

export const lenderOfLoanId = (loanId: string): string => loanId.split(":")[2] ?? "aave-v3";
export const venueNameOf = (lender: string): string => NAMES[lender] ?? lender;
export const venueOfLoanId = (loanId: string): string => venueNameOf(lenderOfLoanId(loanId));
