import { nextViewOnSwitch } from "@/lib/nav";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  SAMPLE_ACTIVITY, BASE_PRICES, TREASURY, NETWORKS, networkName, SAMPLE_LOANS, PRICES, RESERVE_BALANCES, RESERVE_POLICY, RULES, THRESHOLDS, VENUES, fmt, loanHF, usd,
  type ActivityEvent, type Actor, type ActivityKind, type Amounts, type Asset, type Loan, type Network, type Safe, type Stable,
} from "@/data";
import { depositLine, type UIBlock } from "@/lib/blocks";
import { routeIntent } from "@/lib/intents";
import { balancesAfter, buildProposal, compute, followUpAfter, nextStage, type Proposal, type Spec } from "@/lib/proposals";
import { maxCashSafe, type Move } from "@/lib/cash-plan";
import { seedDraft, type PlanDraft, emptyDraft } from "@/lib/plan-draft";
import { isStale, loanInContext, specNetwork, specSafeId, threadOf } from "@/lib/threads";
import { addNetwork, agentOn, balancesOn, deposit, markDeployed, setAllAgents, setNetworkAgent, totalBalances } from "@/lib/networks";
import { requiredSignatures, whyMorphoLine } from "@/lib/loan-copy";
import { collateralNeeded, DEFAULT_LEVELS, healthFactor, levelsOf, attentionOf, healthStatus, maxSafeBorrow, MIN_LOAN, parseUsd, reservePlan, type ReservePolicy } from "@/lib/loan-math";
import { blockMessage, capResetLabel, reserveBlock, unmetNote } from "@/lib/reserve";
import { STILL_QUEUED, crossedLevel, policyLogText, proposalDetail, reserveUsedCopy } from "@/lib/activity-copy";
import { alertAmounts, alertOptions, alertState, ruleAction } from "@/lib/alerts";

export type View = { name: "onboarding" } | { name: "loan"; id: string } | { name: "offers"; asset?: Asset; network?: Network; amount?: number; borrow?: number } | { name: "cash"; amount?: number; step?: number; asset?: Asset; network?: Network; venueId?: string; collateral?: number; from?: "offers" } | { name: "activity" } | { name: "settings" } | { name: "reserve" } | { name: "home" } | { name: "chat" };

export type Msg = { id: string; safeId: string } & (
  | { role: "user"; text: string }
  | { role: "agent"; text: string }
  | { role: "alert"; loanId: string; snap: Loan; hf: number; price: number; why?: string; addColl: number; repay: number; chosen?: "coll" | "repay" | "both" | "reserve" }
  | { role: "proposal"; proposalId: string }
  | { role: "ui"; text?: string; block: UIBlock }
  | { role: "reserve"; loanId: string; title: string; steps: string[]; hfBefore: number; hfAfter: number; capLine: string; leftLine: string; note?: string }
);

type Store = ReturnType<typeof useStoreState>;
const Ctx = createContext<Store | null>(null);
export const useApp = () => useContext(Ctx)!;

export function useMedia(query: string) {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

/** Sample data for "Load sample loans". The Morpho fix that is already in the Safe queue with one signature (a real proposal, so it can be signed or rejected). */
const seedProposals = (): Record<string, Proposal> => ({
  q1: { ...buildProposal("q1", { kind: "protect", loanId: "morpho", addColl: 0.1, repay: 0 }, SAMPLE_LOANS), stage: 2 },
});

const seedMessages = (): Msg[] => {
  return [
    { id: "m0", safeId: TREASURY.id, role: "proposal", proposalId: "q1" },
    { id: "m2", safeId: TREASURY.id, role: "alert", loanId: "spark", snap: SAMPLE_LOANS[2], hf: loanHF(SAMPLE_LOANS[2]), price: PRICES.ETH, why: "ETH fell 6% in 4h.", ...alertAmounts(SAMPLE_LOANS[2], PRICES.ETH, DEFAULT_LEVELS.warn) },
  ];
};

function useStoreState() {
  const [onboarded, setOnboarded] = useState(false);
  /** Which demo wallet is connected: one that owns Treasury Safe, or one with no Safe yet. */
  const [wallet, setWallet] = useState<"returning" | "new">("returning");
  const [view, setView] = useState<View>({ name: "onboarding" });
  const ctxLoanId = view.name === "loan" ? view.id : "";
  const [allLoans, setLoans] = useState<Loan[]>([]);
  const [safes, setSafes] = useState<Safe[]>([TREASURY]);
  const [activeSafeId, setActiveSafeId] = useState(TREASURY.id);
  const [addSafeOpen, setAddSafeOpen] = useState(false);
  const [thresholds, setThresholds] = useState(THRESHOLDS);
  const [rules, setRules] = useState(RULES);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [messages, setMessages] = useState<Msg[]>([]);
  const [typingSafeId, setTypingSafeId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [chatDocked, setChatDocked] = useState(true);
  const [chatSheet, setChatSheet] = useState(false);
  const [navSheet, setNavSheet] = useState(false);
  const [reserveLinkedRaw, setReserveLinked] = useState(false);
  const [reserveBal, setReserveBal] = useState(RESERVE_BALANCES);
  const [policy, setPolicyState] = useState<ReservePolicy>(RESERVE_POLICY);
  const [planDraft, setPlanDraft] = useState<Record<string, PlanDraft>>({});
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);
  const [, setTick] = useState(0);

  const loansRef = useRef(allLoans);
  loansRef.current = allLoans;
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;
  const safe = safes.find((x) => x.id === activeSafeId) ?? safes[0];
  const activeRef = useRef(safe);
  activeRef.current = safe;
  // The Reserve Safe is linked to the Treasury Safe only.
  const reserveLinked = reserveLinkedRaw && safe.id === TREASURY.id;
  const proposerActive = safe.agent;
  const linkedRef = useRef(reserveLinkedRaw);
  linkedRef.current = reserveLinkedRaw;
  const reserveRef = useRef(reserveBal);
  reserveRef.current = reserveBal;
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const safesRef = useRef(safes);
  safesRef.current = safes;
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;
  const lastProposalMsg = useRef("");
  const n = useRef(100);
  const nid = (p: string) => `${p}${n.current++}`;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const go = (v: View) => {
    setView(v);
    setNavSheet(false);
  };

  const log = (actor: Actor, kind: ActivityKind, text: string, safeId: string, detail?: string) =>
    setActivity((a) => [{ id: nid("a"), safeId, at: Date.now(), actor, kind, text, detail }, ...a]);

  const post = (m: Msg) => setMessages((x) => [...x, m]);
  const reply = (fn: () => void, ms = 900) => {
    setTypingSafeId(activeRef.current.id);
    setTimeout(() => {
      setTypingSafeId(null);
      fn();
    }, ms);
  };
  const say = (text: string, safeId: string) => post({ id: nid("m"), safeId, role: "agent", text });
  const postUi = (block: UIBlock, text: string | undefined, safeId: string) => {
    const id = nid("m");
    post({ id, safeId, role: "ui", text, block });
    // The newest plan message becomes the live one; it seeds the shared plan draft.
    if (block.kind === "plan") {
      const owner = safesRef.current.find((x) => x.id === safeId);
      const max = owner ? maxCashSafe(owner, PRICES, DEFAULT_LEVELS.warn, block.network) : 0;
      setPlanDraft((d) => ({ ...d, [safeId]: seedDraft(block, id, max >= MIN_LOAN ? max : Infinity) }));
    }
  };
  /** Changes the Safe's plan draft; with `null`, clears it. */
  const patchPlanDraft = (safeId: string, partial: Partial<PlanDraft> | null) =>
    setPlanDraft((d) => ({ ...d, [safeId]: partial ? { ...(d[safeId] ?? emptyDraft), ...partial } : emptyDraft }));
  /** Posts a generated UI block from the agent to the current Safe's thread, right away (block buttons). `send` posts after its typing delay. */
  const postBlock = (block: UIBlock, text?: string) => postUi(block, text, activeRef.current.id);

  const stoppedDetail = (p: Proposal, queued: boolean) => (queued ? `${proposalDetail(p.steps)}. ${STILL_QUEUED}` : proposalDetail(p.steps));

  const createProposal = (spec: Spec, loansNow: Loan[] = loansRef.current, stage = 0): string => {
    const sid = specSafeId(spec, loansNow, activeRef.current.id);
    const p = { ...buildProposal(nid("p"), spec, loansNow), stage };
    // One live draft per loan: older drafts (stage 0) for the same loan are replaced.
    const replaces = Object.values(proposalsRef.current).some((o) => o.stage === 0 && o.loanId === p.loanId);
    setProposals((x) => ({
      ...Object.fromEntries(Object.entries(x).map(([k, o]) => [k, o.stage === 0 && o.loanId === p.loanId ? { ...o, stage: -2 } : o])),
      [p.id]: p,
    }));
    const mid = nid("m");
    lastProposalMsg.current = mid;
    post({ id: mid, safeId: sid, role: "proposal", proposalId: p.id });
    log("Agent", "proposed", stage === 0 ? `${replaces ? "Updated draft" : "Proposed"}: ${p.title}` : `Sent to Safe for signatures: ${p.title}`, sid, proposalDetail(p.steps));
    return p.id;
  };

  /** Alert message for the loan as it is now, sized to reach its warn level. */
  const alertMsg = (x: Loan, why?: string, chosen?: "repay"): Msg => ({
    id: nid("m"), safeId: x.safeId, role: "alert", loanId: x.id, snap: x, hf: loanHF(x), price: PRICES[x.collAsset], why, chosen,
    ...alertAmounts(x, PRICES[x.collAsset], levelsOf(thresholdsRef.current, x.id).warn),
  });

  /** Posts an alert and returns its id. Only one live fix per loan: older drafts (stage 0) go out of date. */
  const postAlert = (x: Loan, why?: string, chosen?: "repay"): string => {
    setProposals((o) => Object.fromEntries(Object.entries(o).map(([k, p]) => [k, p.stage === 0 && p.loanId === x.id ? { ...p, stage: -3 } : p])));
    const m = alertMsg(x, why, chosen);
    post(m);
    return m.id;
  };

  /** Where an alert stands now, against the live loan, newer alerts and open fixes. */
  const alertStateOf = (a: Extract<Msg, { role: "alert" }>) => {
    const live = allLoans.find((x) => x.id === a.loanId);
    const mine = messages.filter((x) => x.role === "alert" && x.loanId === a.loanId);
    return alertState(a, {
      newer: mine[mine.length - 1].id !== a.id,
      liveHf: live ? loanHF(live) : null,
      warn: levelsOf(thresholds, a.loanId).warn,
      openFix: Object.values(proposals).some((p) => p.loanId === a.loanId && p.stage >= 0 && p.stage <= 2),
    });
  };

  const warnOf = (id: string) => levelsOf(thresholdsRef.current, id).warn;

  /** The one place the agent executes: supply or repay on behalf of a Treasury loan from the Reserve Safe. */
  const execReserve = (loanId: string, force: boolean): boolean => {
    const l = loansRef.current.find((x) => x.id === loanId);
    if (!l || l.safeId !== TREASURY.id) return false;
    const bal = reserveRef.current;
    const pol = policyRef.current;
    const price = PRICES[l.collAsset];
    const plan = reservePlan(
      { amount: l.collAmount, price, lt: l.lt, debt: l.debt },
      warnOf(l.id),
      { coll: bal[l.collAsset], stable: bal[l.debtAsset] },
      { ...pol, armed: pol.armed && linkedRef.current },
      force,
    );
    if (!plan) return false;
    const next = { ...l, collAmount: l.collAmount + plan.supply, debt: l.debt - plan.repay };
    const nl = loansRef.current.map((x) => (x.id === l.id ? next : x));
    loansRef.current = nl;
    setLoans(nl);
    const nb = { ...bal, [l.collAsset]: bal[l.collAsset] - plan.supply, [l.debtAsset]: bal[l.debtAsset] - plan.repay };
    reserveRef.current = nb;
    setReserveBal(nb);
    const capLeftBefore = Math.max(0, pol.dailyCapUsd - pol.usedUsd24h);
    const np = { ...pol, usedUsd24h: pol.usedUsd24h + plan.usd, usedSince: pol.usedUsd24h === 0 ? Date.now() : pol.usedSince };
    policyRef.current = np;
    setPolicyState(np);
    const steps: string[] = [];
    const safeName = safes.find((s) => s.id === l.safeId)?.name ?? TREASURY.name;
    if (plan.supply > 0) steps.push(`Supply ${fmt(plan.supply, 2)} ${l.collAsset} to ${l.venue} for ${safeName}`);
    if (plan.repay > 0) steps.push(`Repay ${fmt(plan.repay)} ${l.debtAsset} on ${l.venue} for ${safeName}`);
    const what = steps.length === 2 ? "supplied and repaid" : plan.supply > 0 ? `supplied ${fmt(plan.supply, 2)} ${l.collAsset} to` : `repaid ${fmt(plan.repay)} ${l.debtAsset} on`;
    const totalAfter = (Object.keys(nb) as (Asset | Stable)[]).reduce((t, a) => t + nb[a] * PRICES[a], 0);
    const need = plan.unmet ? collateralNeeded(next.collAmount, price, next.lt, next.debt, warnOf(l.id)) : 0;
    const addColl = Math.ceil(need * 10) / 10;
    const draftHf = healthFactor((next.collAmount + addColl) * price, next.lt, next.debt);
    post({
      id: nid("m"), safeId: l.safeId, role: "reserve", loanId: l.id,
      title: `I used the reserve: ${what} your ${l.venue} loan.`,
      steps, hfBefore: plan.hfBefore, hfAfter: plan.hfAfter,
      capLine: `Daily limit: ${usd(np.usedUsd24h)} of ${usd(np.dailyCapUsd)} used`, leftLine: `Reserve left: ${usd(totalAfter)}`,
      note: plan.unmet ? unmetNote(plan.usd >= capLeftBefore - 0.01, draftHf) : undefined,
    });
    const used = reserveUsedCopy({ usd: plan.usd, venue: l.venue, supply: plan.supply, collAsset: l.collAsset, repay: plan.repay, debtAsset: l.debtAsset, hfBefore: plan.hfBefore, hfAfter: plan.hfAfter });
    log("Agent (reserve)", "reserve", used.text, l.safeId, used.detail);
    if (plan.unmet) createProposal({ kind: "protect", loanId: l.id, addColl, repay: 0 }, nl);
    return true;
  };

  /** Why the reserve did not act on a loan, as a chat sentence. */
  const reserveWhy = (l: Loan, pick: "above" | "below"): string => {
    if (!linkedRef.current) return "No reserve is linked, so I can only propose.";
    const bal = reserveRef.current;
    const pol = policyRef.current;
    const price = PRICES[l.collAsset];
    const block = reserveBlock({ amount: l.collAmount, price, lt: l.lt, debt: l.debt }, warnOf(l.id), { coll: bal[l.collAsset], stable: bal[l.debtAsset] }, pol);
    if (l.safeId !== TREASURY.id || !block) return "The reserve cannot act on this loan right now.";
    return blockMessage(block, { cap: pol.dailyCapUsd, used: pol.usedUsd24h, coll: l.collAsset, debt: l.debtAsset, reset: capResetLabel(pol.usedSince, Date.now()), hf: loanHF(l), pick });
  };

  const simulateDrop = (loanId: string, pct: number) => {
    const l = loansRef.current.find((x) => x.id === loanId);
    if (!l) return;
    const before = new Map(loansRef.current.map((x) => [x.id, loanHF(x)]));
    (l.collAsset === "WBTC" ? ["WBTC"] : ["ETH", "wstETH"]).forEach((a) => (PRICES[a as Asset] *= 1 - pct / 100));
    setTick((t) => t + 1);
    log("Agent", "read", `Saw ${l.collAsset} price fall ${pct}% (demo)`, l.safeId);
    reply(() => {
      for (const x of loansRef.current) {
        const hf = loanHF(x);
        const t = levelsOf(thresholdsRef.current, x.id);
        const pol = policyRef.current;
        const armed = pol.armed && linkedRef.current;
        if (hf < pol.emergencyHF && armed && execReserve(x.id, false)) continue;
        const sf = safesRef.current.find((s) => s.id === x.safeId);
        if (!sf || !agentOn(sf, x.network)) continue; // not a proposer: no alerts, no drafts (the reserve above has its own pause)
        if (hf < t.act && hf < (before.get(x.id) ?? Infinity) - 1e-9) {
          if (hf < pol.emergencyHF) say(reserveWhy(x, "below"), x.safeId);
          const { repay } = alertAmounts(x, PRICES[x.collAsset], t.warn);
          const bal = balancesOn(sf, x.network)[x.debtAsset];
          const act = ruleAction(rulesRef.current.some((r) => r.id === "r1" && r.on), repay, bal);
          postAlert(x, `${x.collAsset} fell ${pct}% just now (demo).`, act === "draft repay" ? "repay" : undefined);
          if (act === "draft repay") {
            say("Your standing rule drafted this repayment. Nothing moves until you sign in Safe.", x.safeId);
            createProposal({ kind: "protect", loanId: x.id, addColl: 0, repay });
          } else if (act) say(`Your rule could not draft a repayment: this Safe has only ${fmt(bal)} ${x.debtAsset}.`, x.safeId);
          const lvl = crossedLevel(before.get(x.id) ?? 0, hf, t.act, pol.emergencyHF);
          if (lvl) log("Agent", "status", lvl === "emergency" ? `${x.venue} health ${hf.toFixed(2)} crossed the ${pol.emergencyHF.toFixed(2)} reserve level` : `${x.venue} health ${hf.toFixed(2)} crossed your ${t.act} At-risk level`, x.safeId);
        }
      }
    }, 1200);
  };

  const applyPolicy = (patch: Partial<ReservePolicy>) => {
    const prev = policyRef.current;
    const next = { ...prev, ...patch };
    policyRef.current = next;
    setPolicyState(next);
    log("You", "reserve", policyLogText(prev, next), TREASURY.id);
  };

  const linkReserve = () => {
    setReserveLinked(true);
    log("You", "reserve", "Linked Reserve Safe and approved the agent's limits", TREASURY.id);
  };

  const ctxLoan = () => loanInContext(loansRef.current, activeRef.current.id, ctxLoanId);
  const editingRef = useRef<string | null>(null);
  /** Largest loan the open proposal's venue allows against its collateral. */
  const openLimit = (spec: Extract<Spec, { kind: "open" }>) => {
    const m = VENUES.find((v) => v.id === spec.venueId)!.markets[spec.asset]!;
    return maxSafeBorrow(spec.amount * PRICES[spec.asset], m.lt, m.maxLtv, DEFAULT_LEVELS.act);
  };

  const send = (text: string) => {
    const t = text.trim();
    if (!t || !proposerActive) return;
    const sid = activeRef.current.id;
    const sayHere = (text: string) => say(text, sid);
    post({ id: nid("m"), safeId: sid, role: "user", text: t });
    const q = t.toLowerCase();
    const editing = editingRef.current;
    editingRef.current = null;
    const typed = parseUsd(t);
    reply(() => {
      if (typed !== null && (editing || /instead|make it|change/.test(q))) {
        const mine = Object.values(proposalsRef.current).filter((x) => x.spec.kind === "open" && x.stage >= 0 && x.stage <= 2 && specSafeId(x.spec, loansRef.current, sid) === sid);
        const target = editing ? mine.find((x) => x.id === editing) : mine[mine.length - 1];
        if (target && target.spec.kind === "open") {
          const spec = target.spec;
          const limit = openLimit(spec);
          if (target.stage > 0) return sayHere("That one is already in your Safe queue. Reject it, then ask again.");
          if (typed > limit) return sayHere(`${VENUES.find((v) => v.id === spec.venueId)!.name} allows up to ${usd(limit)} against ${fmt(spec.amount, 2)} ${spec.asset}. Pick a smaller amount.`);
          if (typed < MIN_LOAN) return sayHere(`The smallest loan is ${usd(MIN_LOAN)}.`);
          sayHere(`Replaced the draft with ${usd(typed)}.`);
          return createProposal({ ...spec, borrow: typed });
        }
      }
      const l = ctxLoan();
      const intent = routeIntent(t, { hasLoans: loansRef.current.some((x) => x.safeId === sid), balances: totalBalances(activeRef.current), loanInView: l?.id, maxCash: (n) => maxCashSafe(activeRef.current, PRICES, DEFAULT_LEVELS.warn, n) });
      if (intent?.block) return postUi(intent.block, intent.text, sid);
      if ((q.includes("close") || q.includes("refinanc")) && !l) {
        sayHere(loansRef.current.some((x) => x.safeId === sid) ? "Which loan? Open it from the sidebar, then ask again." : "This Safe has no loans yet.");
      } else if (q.includes("close") && l) {
        sayHere(`Closing your ${l.venue} loan: repay all debt and take back all collateral, in one Safe transaction.`);
        createProposal({ kind: "close", loanId: l.id });
      } else if (q.includes("refinanc") && l) {
        const best = VENUES.filter((v) => v.markets[l.collAsset] && v.name !== l.venue).sort((a, b) => a.apr - b.apr)[0];
        if (best && best.apr < l.apr) {
          sayHere(`${best.name} charges ${best.apr}% against your ${l.apr}% on ${l.venue}.`);
          createProposal({ kind: "refi", loanId: l.id, venueId: best.id });
        } else sayHere(`No cheaper venue for ${l.collAsset} than ${l.venue} right now.`);
      } else if (q.includes("reserve")) {
        const p = policyRef.current;
        sayHere(reserveLinked ? `The reserve is ${p.armed ? "on" : "off"}. When a loan's health falls below ${p.emergencyHF.toFixed(2)}, I add collateral or repay from it, up to ${usd(p.dailyCapUsd)} per day. It can only do this for ${TREASURY.name} loans. Everything else I only propose.` : "No reserve is linked yet. Link one from the Reserve row in the sidebar.");
      } else if (q.includes("morpho")) {
        sayHere(whyMorphoLine(VENUES));
      } else {
        sayHere(l ? `I can plan a loan ("I need $10k"), compare offers, refinance or close your ${l.venue} loan, and explain Morpho. I only draft transactions. Nothing moves until you sign in Safe.` : "I can plan a loan (\"I need $10k\"), compare offers and explain Morpho. Open a loan to refinance or close it. I only draft transactions. Nothing moves until you sign in Safe.");
      }
    });
  };

  const chooseAlert = (msgId: string, choice: "coll" | "repay" | "both" | "reserve") => {
    const a = messages.find((m) => m.id === msgId);
    if (!a || a.role !== "alert") return;
    const sf = safes.find((x) => x.id === a.safeId) ?? safe;
    if (choice !== "reserve" && (alertStateOf(a) !== "live" || !agentOn(sf, a.snap.network))) return;
    setMessages((x) => x.map((m) => (m.id === msgId && m.role === "alert" ? { ...m, chosen: choice } : m)));
    const opt = alertOptions(a, balancesOn(sf, a.snap.network)).find((o) => o.k === choice);
    const sid = a.safeId;
    post({ id: nid("m"), safeId: sid, role: "user", text: opt?.label ?? "Use reserve now" });
    if (choice === "reserve") {
      reply(() => {
        if (!execReserve(a.loanId, true)) {
          const l = loansRef.current.find((x) => x.id === a.loanId);
          say(l ? reserveWhy(l, "above") : "The reserve cannot cover this right now.", sid);
        }
      });
      return;
    }
    if (!opt) return;
    const sigs = requiredSignatures(sf.threshold);
    reply(() => {
      say(`Drafted below. Nothing has changed yet: press Send to Safe, then it needs ${sigs} signature${sigs === 1 ? "" : "s"}.`, sid);
      createProposal({ kind: "protect", loanId: a.loanId, addColl: opt.addColl, repay: opt.repay });
    });
  };

  /** Opens the chat on the draft for this loan, or its current alert, or a fresh alert from the live loan. */
  const fixWithAgent = (loanId: string) => {
    setChatDocked(true);
    setChatSheet(true);
    const l = loansRef.current.find((x) => x.id === loanId);
    const owner = l && safes.find((x) => x.id === l.safeId);
    if (!l || !owner || !agentOn(owner, l.network)) return;
    const draft = Object.values(proposals).find((p) => p.loanId === loanId && p.stage >= 0 && p.stage <= 2);
    const draftMsg = draft && messages.find((m) => m.role === "proposal" && m.proposalId === draft.id);
    const last = messages.filter((m): m is Extract<Msg, { role: "alert" }> => m.role === "alert" && m.loanId === loanId).pop();
    const target = draftMsg ?? (last && ["live", "chosen"].includes(alertStateOf(last)) ? last : undefined);
    if (target) return setFocus({ id: target.id, at: Date.now() });
    reply(() => setFocus({ id: postAlert(l), at: Date.now() }), 600);
  };

  /**
   * The Get cash send button: drafts the proposal and puts it in the Safe queue (stage 1) in one step. Returns its id.
   * With a `move`, the first proposal is the move; the loan is drafted when the move executes (see advance).
   */
  const sendLoan = (venueId: string, asset: Asset, amount: number, borrow: number, network: Network, move?: Move): string => {
    setChatDocked(true);
    const sid = activeRef.current.id;
    const open = { kind: "open" as const, venueId, asset, amount, borrow, safeId: sid, network };
    const id = createProposal(move ? { kind: "move", safeId: sid, move, then: open } : open, loansRef.current, 1);
    // The proposal card is the one place that says what to sign: bring it into view.
    setFocus({ id: lastProposalMsg.current, at: Date.now() });
    patchPlanDraft(sid, { sentId: id });
    return id;
  };

  const patch = (id: string, stage: number, extra?: Partial<Proposal>) => setProposals((x) => ({ ...x, [id]: { ...x[id], stage, ...extra } }));

  const advance = (id: string) => {
    const p = proposalsRef.current[id];
    if (!p) return;
    const sid = specSafeId(p.spec, loansRef.current, activeRef.current.id);
    const bal = (safes.find((s) => s.id === sid) ?? activeRef.current).balances;
    if (isStale(p, loansRef.current, bal)) {
      const queued = p.stage >= 1 && p.stage <= 2;
      patch(id, -3, { queued });
      log("Agent", "status", `Out of date: ${p.title}`, sid, stoppedDetail(p, queued));
      return;
    }
    const stage = nextStage(p.stage, requiredSignatures((safesRef.current.find((s) => s.id === sid) ?? activeRef.current).threshold));
    const oneStep = stage === 3 && p.stage === 1;
    patch(id, stage);
    if (stage === 1) log("Agent", "proposed", `Sent to Safe for signatures: ${p.title}`, sid, proposalDetail(p.steps));
    if (stage === 2) log("You", "signed", `Signed: ${p.title}`, sid, proposalDetail(p.steps));
    if (stage === 3) {
      const c = compute(p.spec, loansRef.current);
      const net = specNetwork(p.spec, loansRef.current);
      const target = safesRef.current.find((s) => s.id === sid);
      if (target && !target.networks.find((n) => n.id === net)?.deployed) log("Agent", "status", `Safe set up on ${networkName(net)}. Free: the first transaction there sets it up.`, sid);
      setSafes((x) => x.map((s) => {
        if (s.id !== sid) return s;
        const t = { ...markDeployed(s, net), balances: { ...s.balances, [net]: balancesAfter(balancesOn(s, net), p.spec, loansRef.current) } };
        return p.spec.kind === "move" ? deposit(t, p.spec.move.to, { [p.spec.move.asset]: p.spec.move.amount }) : t;
      }));
      setLoans(c.next);
      log(oneStep ? "You" : "Co-signer", "signed", `Signed and executed: ${p.title}`, sid, proposalDetail(p.steps));
      const next = followUpAfter({ spec: p.spec, stage });
      if (next && p.spec.kind === "move") {
        const m = p.spec.move;
        log("Agent", "status", `${fmt(m.amount, 2)} ${m.asset} arrived on ${networkName(m.to)}`, sid);
        reply(() => {
          say(c.done, sid);
          createProposal(next, loansRef.current, 1);
        }, 600);
      } else reply(() => say(c.done, sid), 600);
    }
  };

  const reject = (id: string) => {
    const p = proposalsRef.current[id];
    const queued = !!p && p.stage >= 1 && p.stage <= 2;
    patch(id, -1, { queued });
    if (p) log("You", "status", `Rejected: ${p.title}`, specSafeId(p.spec, loansRef.current, activeRef.current.id), stoppedDetail(p, queued));
  };

  const edit = (id: string) => {
    const p = proposalsRef.current[id];
    if (!p || p.spec.kind !== "open") return;
    const sid = specSafeId(p.spec, loansRef.current, activeRef.current.id);
    editingRef.current = id;
    const limit = openLimit(p.spec);
    reply(() => say(`What amount do you want instead? Up to ${usd(limit)}. For example "$5k".`, sid));
  };

  const mutateSafe = (id: string, fn: (s: Safe) => Safe) => setSafes((x) => x.map((s) => (s.id === id ? fn(s) : s)));

  /** Adds or removes the agent on every network of the active Safe. */
  const setAgent = (on: boolean) => {
    mutateSafe(activeRef.current.id, (s) => setAllAgents(s, on));
    log("You", "status", on ? "Added Lender agent to this Safe" : "Removed Lender agent from this Safe", activeRef.current.id);
    say(on ? `I can suggest transactions on ${activeRef.current.name} now.` : `I can no longer suggest transactions on ${activeRef.current.name}. I won't send alerts or suggest fixes here until you add me back. Anything already waiting stays in Safe until you reject it.`, activeRef.current.id);
  };
  const removeProposer = () => setAgent(false);
  const addProposer = () => setAgent(true);

  /** One network at a time (one signature each). */
  const setAgentOn = (network: Network, on: boolean) => {
    const sid = activeRef.current.id;
    mutateSafe(sid, (s) => setNetworkAgent(s, network, on));
    log("You", "status", `${on ? "Added" : "Removed"} Lender agent on ${networkName(network)}`, sid);
    say(on ? `I can suggest transactions on ${networkName(network)} now.` : `I can no longer suggest transactions on ${networkName(network)}.`, sid);
  };

  /** Adds a network to the active Safe, with the agent when `agent` is true. The address stays the same. */
  const addSafeNetwork = (network: Network, agent: boolean) => {
    const sid = activeRef.current.id;
    mutateSafe(sid, (s) => addNetwork(s, network, agent));
    log("You", "status", `Added ${networkName(network)}${agent ? " with the Lender agent" : ""}`, sid);
    say(`${activeRef.current.name} now works on ${networkName(network)} too, at the same address. It is set up there the first time you use it.`, sid);
  };

  /** Demo: 5 ETH arrives on `network`. */
  const simulateDeposit = (network: Network) => {
    const sid = activeRef.current.id;
    const next = deposit(activeRef.current, network, { ETH: 5 });
    const max = maxCashSafe(next, PRICES, DEFAULT_LEVELS.warn);
    mutateSafe(sid, (s) => deposit(s, network, { ETH: 5 }));
    log("Agent", "read", `Saw 5 ETH arrive on ${networkName(network)} (demo)`, sid);
    say(depositLine(activeRef.current.name, networkName(network), 5 * PRICES.ETH, max), sid);
    if (max >= MIN_LOAN) postUi({ kind: "suggestions", items: [`Borrow ${usd(max)}`] }, undefined, sid);
  };

  const switchSafe = (id: string) => {
    activeRef.current = safes.find((x) => x.id === id) ?? activeRef.current;
    setActiveSafeId(id);
    setView(nextViewOnSwitch);
    setNavSheet(false);
  };

  /** Adds a Safe and makes it active. From onboarding (`inOnboarding`) it stays on the current screen, and a new user's list holds only this Safe. */
  const addSafe = (s: Safe, inOnboarding = false) => {
    setSafes((x) => (inOnboarding && wallet === "new" ? [s] : [...x, s]));
    log("You", "status", `Added ${s.name}${s.agent ? " with the Lender agent" : ""}`, s.id);
    if (!inOnboarding) say(s.agent ? `Added ${s.name}. I can suggest transactions here.` : `Added ${s.name}. I'm not added here yet, so I can't suggest transactions.`, s.id);
    activeRef.current = s;
    setActiveSafeId(s.id);
    if (!inOnboarding) setView({ name: "home" });
    setNavSheet(false);
  };

  /** Onboarding, returning user: the agent signed on these networks of `safeId`. */
  const addAgentOn = (safeId: string, networks: Network[]) => {
    mutateSafe(safeId, (s) => networks.reduce((t, n) => setNetworkAgent(t, n, true), s));
    log("You", "status", "Added Lender agent to this Safe", safeId);
  };

  const reset = () => {
    setOnboarded(false);
    setWallet("returning");
    setView({ name: "onboarding" });
    loansRef.current = [];
    setLoans([]);
    setThresholds(THRESHOLDS);
    setRules(RULES);
    setProposals({});
    setPlanDraft({});
    Object.assign(PRICES, BASE_PRICES);
    setMessages([]);
    setTypingSafeId(null);
    setActivity([]);
    setSafes([TREASURY]);
    setActiveSafeId(TREASURY.id);
    setReserveLinked(false);
    setReserveBal(RESERVE_BALANCES);
    setPolicyState(RESERVE_POLICY);
  };

  const finishOnboarding = (linked = false) => {
    if (linked) linkReserve();
    setOnboarded(true);
    setView({ name: "chat" });
  };

  const sampleLoaded = allLoans.some((l) => SAMPLE_LOANS.some((s) => s.id === l.id));
  /** Demo data: the three sample loans, the Morpho fix waiting for a signature, the Spark alert and past activity. Opens the Overview. */
  const loadSampleLoans = () => {
    if (sampleLoaded) return;
    const nl = [...loansRef.current, ...SAMPLE_LOANS];
    loansRef.current = nl;
    setLoans(nl);
    setThresholds(THRESHOLDS);
    setProposals((x) => ({ ...x, ...seedProposals() }));
    setMessages((x) => [...x, ...seedMessages()]);
    setActivity((a) => [...a, ...SAMPLE_ACTIVITY]);
    setOnboarded(true);
    setView({ name: "home" });
  };

  return {
    onboarded, view, go, ctxLoanId, allLoans, loans: allLoans.filter((l) => l.safeId === safe.id), safes, safe, balances: safe.balances, switchSafe, addSafe, addAgentOn, setAgentOn, addSafeNetwork, simulateDeposit, wallet, connectWallet: setWallet, addSafeOpen, setAddSafeOpen, thresholds, setThresholds, rules, setRules, proposals, messages: threadOf(messages, safe.id), typing: typingSafeId === safe.id,
    activity: activity.filter((e) => e.safeId === safe.id), theme, setTheme, proposerActive, removeProposer, addProposer, chatDocked, setChatDocked, chatSheet,
    setChatSheet, navSheet, setNavSheet, send, chooseAlert, alertStateOf, fixWithAgent, focus, planDraft, patchPlanDraft, sendLoan, advance, reject, edit, reset, finishOnboarding, loadSampleLoans, sampleLoaded, postBlock,
    reserveLinked, reserveBal, policy, applyPolicy, linkReserve, simulateDrop,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const s = useStoreState();
  return <Ctx.Provider value={s}>{children}</Ctx.Provider>;
}

export const useStatus = () => {
  const { thresholds } = useApp();
  return useCallback((l: Loan) => {
    const t = levelsOf(thresholds, l.id);
    return healthStatus(loanHF(l), t.warn, t.act);
  }, [thresholds]);
};

export const useAttention = () => {
  const { loans } = useApp();
  const status = useStatus();
  const a = attentionOf(loans.map((loan) => ({ loan, hf: loanHF(loan), status: status(loan) })));
  return { risk: a.risk, count: a.count, worst: a.worst?.loan };
};
