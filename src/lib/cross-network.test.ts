import { describe, expect, it } from "vitest";
import { BASE_PRICES, VENUES, type Safe, type Venue } from "@/data";
import { choosePlan, moveLine, moveReason, moveQuote, plansAcross } from "./cash-plan";
import { buildProposal, followUpAfter } from "./proposals";
import { createSafe, deposit, networksLabel } from "./networks";
import { isStale } from "./threads";

const P = BASE_PRICES;
const owner = { owners: ["0x7be2a91c4d05f3e8b6a7c1d92e04f58a3b6cc41a"], threshold: 1, salt: 0 };
const empty = createSafe({ id: "s", name: "S", ...owner, networks: ["ethereum", "base"] });
const onBase = deposit(empty, "base", { ETH: 5 });
const onEth = deposit(empty, "ethereum", { ETH: 5 });
const need = (cash: number, network: "base" | "ethereum", targetHf = 1.6) => ({ cash, months: 12, targetHf, asset: "ETH" as const, network });
const choose = (s: Safe, cash: number, network: "base" | "ethereum", venues: Venue[] = VENUES) => choosePlan(plansAcross(s, need(cash, network), P, venues, []));

describe("moveQuote", () => {
  it("costs $2 to $6 and takes 2 to 15 minutes; Ethereum as destination costs more", () => {
    const m = moveQuote("base", "ethereum", "ETH", 4.86);
    expect(m).toEqual({ from: "base", to: "ethereum", asset: "ETH", amount: 4.86, feeUsd: 4, minutes: 10 });
    const l2 = moveQuote("base", "arbitrum", "ETH", 1);
    expect(l2.feeUsd).toBeLessThan(m.feeUsd);
    for (const a of ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"] as const)
      for (const b of ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"] as const) {
        if (a === b) continue;
        const q = moveQuote(a, b, "ETH", 1);
        expect(q.feeUsd).toBeGreaterThanOrEqual(2); expect(q.feeUsd).toBeLessThanOrEqual(6);
        expect(q.minutes).toBeGreaterThanOrEqual(2); expect(q.minutes).toBeLessThanOrEqual(15);
      }
  });
  it("prints the plan row", () => {
    expect(moveLine(moveQuote("base", "ethereum", "ETH", 2.04))).toBe("Move 2.04 ETH from Base to Ethereum (about 10 minutes).");
  });
});

describe("cross-network plans", () => {
  it("adds a move step with its fee and minutes when only a lender on another network can fund it", () => {
    // 5 ETH on Base cannot back $7,500 at Balanced with Base's lenders; Compound on Ethereum can.
    const c = choose(onBase, 7500, "base")!;
    expect(c.plan.venue.id).toBe("compound");
    expect(c.plan.network).toBe("ethereum");
    expect(c.plan.move).toEqual({ from: "base", to: "ethereum", asset: "ETH", amount: c.plan.collateral, feeUsd: 4, minutes: 10 });
    expect(c.plan.collateral).toBe(4.86);
  });
  it("prefers the same network when a lender there can fund the amount", () => {
    const c = choose(onBase, 3000, "base")!;
    expect(c.plan.network).toBe("base");
    expect(c.plan.move).toBeUndefined();
    expect(c.alternative).toBeUndefined();
  });
  it("has no move when the collateral is already on the lender's network", () => {
    const plans = plansAcross(onEth, need(3000, "ethereum"), P, VENUES, []);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => p.network === "ethereum" && p.move === undefined)).toBe(true);
  });
  it("is null when nothing can fund it, even with a move", () => {
    expect(choose(onBase, 15000, "base")).toBeNull();
  });
  const pricey: Venue[] = [
    { ...VENUES[0], id: "here", name: "Here", apr: 8, networks: ["base"] },
    { ...VENUES[0], id: "there", name: "There", apr: 2, networks: ["ethereum"] },
  ];
  it("offers a cheaper cross-network plan as an alternative when it saves more per year than the move costs", () => {
    const c = choose(onBase, 3000, "base", pricey)!;
    expect(c.plan.venue.id).toBe("here"); // default stays on the same network
    expect(c.alternative!.plan.venue.id).toBe("there");
    expect(c.alternative!.plan.move!.feeUsd).toBe(4);
    expect(c.alternative!.saves).toBeCloseTo(c.plan.newYearly - c.alternative!.plan.newYearly);
    expect(c.alternative!.saves).toBeGreaterThan(4);
  });
  it("does not offer it when the saving is smaller than the move fee", () => {
    const close = pricey.map((v) => (v.id === "there" ? { ...v, apr: 7.99 } : v));
    expect(choose(onBase, 3000, "base", close)!.alternative).toBeUndefined();
  });
});

describe("move proposal", () => {
  const then = { kind: "open" as const, venueId: "compound", asset: "ETH" as const, amount: 4.86, borrow: 7500, safeId: "s", network: "ethereum" as const };
  const spec = { kind: "move" as const, safeId: "s", move: moveQuote("base", "ethereum", "ETH", 4.86), then };
  const p = buildProposal("m", spec, []);
  it("is titled and described as a move, with no loan yet", () => {
    expect(p.title).toBe("Move 4.86 ETH to Ethereum");
    expect(p.loanId).toBe("");
    expect(p.outcome).toContain("Base");
    expect(p.done).toBe("Your 4.86 ETH is on Ethereum now, in the same Safe. Step 2 of 2: sign the loan below.");
    expect(p.steps).toEqual(["Allow 4.86 ETH to leave Base", "Send 4.86 ETH from Base to Ethereum"]);
    expect(p.outcome.startsWith("Step 1 of 2. Moves 4.86 ETH from Base to Ethereum, about 10 minutes.")).toBe(true);
    expect(p.outcome.endsWith("When it arrives I draft the loan, step 2, for you to sign.")).toBe(true);
  });
  it("is out of date when the Safe no longer holds the amount on the source network", () => {
    expect(isStale({ ...p }, [], onBase.balances)).toBe(false);
    expect(isStale({ ...p }, [], deposit(empty, "base", { ETH: 1 }).balances)).toBe(true);
  });
  it("drafts the follow-up loan only once the move has executed", () => {
    for (const stage of [0, 1, 2, -1, -2, -3]) expect(followUpAfter({ spec, stage })).toBeNull();
    expect(followUpAfter({ spec, stage: 3 })).toEqual(then);
    expect(followUpAfter({ spec: then, stage: 3 })).toBeNull();
  });
});

it("names up to three networks and counts more", () => {
  expect(networksLabel(["ethereum", "base"])).toBe("Ethereum and Base");
  expect(networksLabel(["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"])).toBe("all 6 networks");
});

describe("moveReason", () => {
  it("says why the ETH moves", () => {
    const plans = plansAcross(onBase, need(7500, "base"), P, VENUES, []);
    const c = choosePlan(plans)!;
    expect(moveReason(c.plan, plans)).toBe("No lender on Base can lend $7,500 against your ETH at this safety level. Compound v3 on Ethereum can, so your ETH moves there first.");
    const same = choose(onEth, 5000, "ethereum")!;
    expect(moveReason(same.plan, [same.plan])).toBeNull();
  });
  it("names the saving when a cheaper lender needs a move", () => {
    const pricey: Venue[] = [
      { ...VENUES[0], id: "here", name: "Here", apr: 8, networks: ["base"] },
      { ...VENUES[0], id: "there", name: "There", apr: 2, networks: ["ethereum"] },
    ];
    const plans = plansAcross(onBase, need(3000, "base"), P, pricey, []);
    const alt = choosePlan(plans)!.alternative!;
    expect(moveReason(alt.plan, plans)).toMatch(/^Moving saves about /);
  });
});
