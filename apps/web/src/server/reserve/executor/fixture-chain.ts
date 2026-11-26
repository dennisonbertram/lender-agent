// MOCK stand-in for the Roles modifier: the same rules the real one enforces, on the fixture chain reader's
// state. A repay needs membership and allowance, takes only what is owed, charges the amount requested, and moves
// the Reserve Safe's stablecoin and the loan's debt in the fixture. Like the real chain it splits a repay into
// `prepare` (the refusal checks, a deterministic hash, no mutation) and `submit` (the state change, keyed by the
// prepared hash), so the durable broadcast protocol can be exercised end to end without a node.
import { keccak256, stringToHex } from "viem";
import type { FixtureReader } from "@/server/chain/fixture";
import type { Hex } from "@/shared/types";
import type { ExecLink } from "../types";
import { allowanceNow, type RawAllowance } from "../allowance";
import type { PreparedRepay, PrepareResult, RepayResult, ReserveChain } from "./chain";

export type FixtureReserveChain = ReserveChain & {
  /** Set what the owners' setup batch would have set. */
  setup(link: Pick<ExecLink, "roles" | "chainId">, p: { dailyLimitRaw: bigint; members: string[]; nowSec?: bigint }): void;
  /** The owners' removal of the role membership (what the owners' Safe transaction does). */
  revoke(link: Pick<ExecLink, "roles">, executor: string): void;
  setLimit(link: Pick<ExecLink, "roles">, dailyLimitRaw: bigint): void;
  setNow(sec: bigint): void;
  /** Mark a Reserve Safe transaction as executed (what Safe{Wallet} does once the owners signed). */
  markExecuted(safeTxHash: string): void;
  /** Mark a repay transaction as mined (what the network reports once it lands in a block). */
  markMined(txHash: string, status?: "success" | "reverted"): void;
  state(link: Pick<ExecLink, "roles">): { allowance: RawAllowance; members: string[] } | undefined;
  /** Enabled Roles proxies in the fixture; revoking membership leaves its module and allowance intact. */
  enabledModules(): string[];
  /** What was prepared, in order: the submitted and the never-submitted transactions (tests). */
  prepared: PreparedRepay[];
  /** What `submit` accepted, in order (tests: one repayment is at most one distinct hash). */
  submitted: PreparedRepay[];
};

export function createFixtureReserveChain(fx: FixtureReader): FixtureReserveChain {
  const mods = new Map<string, { allowance: RawAllowance; members: Set<string> }>();
  const executed = new Set<string>();
  const mined = new Map<string, "success" | "reverted">();
  const submitted = new Map<string, PreparedRepay>();
  const prepared: PreparedRepay[] = [];
  const calls = new Map<string, { link: ExecLink; amountRaw: bigint }>();
  let seq = 0;
  let now = BigInt(Math.floor(Date.now() / 1000));
  const k = (a: string) => a.toLowerCase();
  const fail = (name: string, detail: string | null = null): PrepareResult => ({ ok: false, name, detail, error: detail ? `${name}(${detail})` : name });
  const balanceOf = async (link: { chainId: number; reserveSafe: string; tokenSymbol: string }) =>
    (await fx.readBalances(link.chainId as 8453, link.reserveSafe as never)).balances.find((x) => x.symbol === link.tokenSymbol)?.raw ?? 0n;

  /** The checks a mined `execTransactionWithRole` would apply, without the mutation. */
  const refuse = async (link: ExecLink, amountRaw: bigint, executor: string): Promise<PrepareResult | null> => {
    const m = mods.get(k(link.roles));
    if (!m) return fail("Unknown");
    if (!m.members.has(k(executor))) return fail("NoMembership");
    const left = allowanceNow(m.allowance, Number(now)).left;
    if (amountRaw > left) return fail("ConditionViolation", "AllowanceExceeded");
    const { position } = await fx.readAavePosition(link.chainId, link.mainSafe);
    const d = position?.debt.find((x) => x.asset === link.tokenSymbol);
    if (!position || !d || d.amount <= 0) return fail("ModuleTransactionFailed");
    const bal = await balanceOf(link);
    if (bal <= 0n) return fail("ModuleTransactionFailed");
    return null;
  };

  /** What a mined transaction does: charge the amount requested, take only what is owed. */
  const apply = async (link: ExecLink, amountRaw: bigint) => {
    const m = mods.get(k(link.roles))!;
    const left = allowanceNow(m.allowance, Number(now)).left;
    const { position } = await fx.readAavePosition(link.chainId, link.mainSafe);
    const d = position!.debt.find((x) => x.asset === link.tokenSymbol)!;
    const scale = 10 ** link.tokenDecimals;
    const owed = BigInt(Math.ceil(d.amount * scale));
    const take = amountRaw < owed ? amountRaw : owed;
    // Charged by the amount requested, not by what was taken (M0-6).
    // The refill is applied lazily, on use: the stored balance and timestamp move to the accrued values first.
    const stored = m.allowance;
    const intervals = stored.period > 0n && now >= stored.timestamp + stored.period ? (now - stored.timestamp) / stored.period : 0n;
    m.allowance = { ...stored, balance: left - amountRaw, timestamp: stored.timestamp + intervals * stored.period };
    const bal = await balanceOf(link);
    const reserve = (await fx.readBalances(link.chainId, link.reserveSafe)).balances;
    fx.setBalances(link.chainId, link.reserveSafe, Object.fromEntries(reserve.map((b) => [b.symbol, b.symbol === link.tokenSymbol ? Number(bal - take) / scale : b.amount])));
    const paid = Number(take) / scale;
    const debtLeft = Math.max(0, d.amount - paid);
    const debt = position!.debt.map((x) => (x === d ? { ...x, amount: debtLeft, usd: debtLeft * ((d.usd ?? 0) / d.amount) } : x));
    const debtUsd = debt.reduce((s, x) => s + (x.usd ?? 0), 0);
    const collUsd = position!.collateral.reduce((s, x) => s + (x.usd ?? 0), 0);
    fx.setPosition(link.chainId, link.mainSafe, { ...position!, debt, healthFactor: debtUsd > 0 ? (collUsd * position!.liquidationThreshold) / debtUsd : Infinity });
    fx.mine();
  };

  const chain: FixtureReserveChain = {
    prepared,
    submitted: [],
    setup(link, p) {
      mods.set(k(link.roles), { allowance: { refill: p.dailyLimitRaw, maxRefill: p.dailyLimitRaw, period: 86_400n, balance: p.dailyLimitRaw, timestamp: p.nowSec ?? now }, members: new Set(p.members.map(k)) });
    },
    revoke(link, executor) { mods.get(k(link.roles))?.members.delete(k(executor)); },
    setLimit(link, v) {
      const m = mods.get(k(link.roles));
      if (m) m.allowance = { refill: v, maxRefill: v, period: 86_400n, balance: v, timestamp: now };
    },
    setNow(sec) { now = sec; },
    markExecuted(h) { executed.add(h.toLowerCase()); },
    markMined(h, s = "success") { mined.set(h.toLowerCase(), s); },
    async wasExecuted(_l, h) { return executed.has(h.toLowerCase()); },
    async receipt(_l, h) { const s = mined.get(h.toLowerCase()); return s ? { status: s, blockNumber: fx.state.blockNumber, transactionHash: h } : null; },
    async waitReceipt(_l, h) { const s = mined.get(h.toLowerCase()); return s ? { status: s, blockNumber: fx.state.blockNumber, transactionHash: h } : null; },
    async blockNumber() { return fx.state.blockNumber; },
    async nonce(_l, tag = "pending") { void tag; return mined.size; },
    state(link) { const m = mods.get(k(link.roles)); return m && { allowance: m.allowance, members: [...m.members] }; },
    enabledModules() { return [...mods.keys()]; },
    async read(link) {
      const m = mods.get(k(link.roles));
      if (!m) throw new Error("fixture: no modifier");
      const executorIsMember = m.members.has(k(link.executor));
      return {
        allowance: m.allowance, nowSec: Number(now), balance: await balanceOf(link), executorIsMember,
        policyAsDesigned: executorIsMember && m.members.size === 1 && m.allowance.maxRefill > 0n,
      };
    },
    async prepare(link, amountRaw, nonce, signer) {
      const refusal = await refuse(link, amountRaw, signer.address);
      if (refusal) return refusal;
      const raw = keccak256(stringToHex(`fixture repay ${link.roles} ${link.mainSafe} ${amountRaw} ${nonce} ${seq++}`));
      const tx: PreparedRepay = { raw, hash: raw, nonce };
      prepared.push(tx);
      calls.set(raw.toLowerCase(), { link: { ...link }, amountRaw });
      return { ok: true, tx };
    },
    async submit(chainId, tx) {
      const call = calls.get(tx.raw.toLowerCase());
      if (!call || call.link.chainId !== chainId) throw new Error("fixture submit: an unknown transaction");
      const { link, amountRaw } = call;
      // Sending the same bytes again is idempotent: an already-mined hash is a no-op, never a second repay.
      if (submitted.has(tx.hash.toLowerCase())) return;
      submitted.set(tx.hash.toLowerCase(), tx);
      chain.submitted.push(tx);
      const refusal = await refuse(link, amountRaw, link.executor); // the mined call re-runs the checks
      if (refusal) { mined.set(tx.hash.toLowerCase(), "reverted"); return; }
      await apply(link, amountRaw);
      mined.set(tx.hash.toLowerCase(), "success");
    },
    async repay(link, amountRaw, signer, onBroadcast) {
      const refusal = await refuse(link, amountRaw, signer.address);
      if (refusal) return refusal as RepayResult;
      await apply(link, amountRaw);
      const hash = `0x${fx.state.blockNumber.toString(16).padStart(64, "0")}` as Hex;
      mined.set(hash.toLowerCase(), "success");
      await onBroadcast?.(hash);
      return { ok: true, txHash: hash, blockNumber: fx.state.blockNumber };
    },
  };
  return chain;
}
