import type { ShellLoan, ShellReserve } from "@/components/shell/ShellContext";

/** One line on what the Reserve is for; the Settings row and the page (without an Aave loan) both open with it. */
export const RESERVE_ONE_LINER = "Keeps a second Safe ready to repay your Aave loan. Works with Aave loans only.";

export const hasAaveLoan = (loans: readonly Pick<ShellLoan, "venue">[]) => loans.some((l) => /aave/i.test(l.venue));

/** The Reserve gets its own nav item only with an Aave loan or a linked Reserve; otherwise Settings points to it. */
export const showReserveNav = (loans: readonly Pick<ShellLoan, "venue">[], reserve?: ShellReserve | null) => !!reserve || hasAaveLoan(loans);
