import { useState } from "react";
import { PRICES, networkName, usd, type Asset, type Network } from "@/data";
import { holdingsOf, quoteLoan, resolveHolding } from "@/lib/cash-plan";
import { balancesOn, venuesNotOn, venuesOn } from "@/lib/networks";
import { rateNote } from "@/lib/loan-copy";
import { DEFAULT_LEVELS, MIN_LOAN, healthStatus, maxSafeBorrow, parseAmount } from "@/lib/loan-math";
import { useApp } from "@/store";
import { Panel, PageHeader, statusLabel, textClass } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function OfferExplorer() {
  const { safe, loans, view, go } = useApp();
  const back: { asset?: Asset; network?: Network; amount?: number; borrow?: number } = view.name === "offers" ? view : {};
  const owned = holdingsOf(safe.balances);
  const [{ asset, network }, setHolding] = useState(() => resolveHolding(safe, PRICES, 10000, DEFAULT_LEVELS.warn, { asset: back.asset, network: back.network }));
  const BALANCES = balancesOn(safe, network);
  const [amountText, setAmountText] = useState(() => String(back.amount ?? BALANCES[asset]));
  const [borrow, setBorrow] = useState(back.borrow ?? 10000);
  const netName = networkName(network);

  if (owned.length === 0) {
    return (
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <PageHeader title="Explore offers" sub="Rates are sample data" />
        <Panel title="Fund this Safe first">
          <p className="text-sm text-muted-foreground">Offers need ETH, wstETH or WBTC in this Safe.</p>
          <Button className="self-start" onClick={() => go({ name: "home" })}>Go to Overview</Button>
        </Panel>
      </div>
    );
  }

  const { amount, over } = parseAmount(amountText, BALANCES[asset]);
  const value = amount * PRICES[asset];

  const limits = venuesOn(network).flatMap((v) => {
    const m = v.markets[asset];
    return m ? [{ v, limit: maxSafeBorrow(value, m.lt, m.maxLtv, DEFAULT_LEVELS.warn) }] : [];
  });
  const sliderMax = Math.max(0, ...limits.map((r) => r.limit));
  const loan = Math.min(Math.max(borrow, MIN_LOAN), sliderMax);
  const rows = limits.map((r) => ({ ...r, q: quoteLoan(r.v, asset, amount, loan, PRICES[asset], loans.filter((l) => l.network === network)) })).sort((a, b) => a.q.apr - b.q.apr);
  const empty =
    amount === 0 ? (BALANCES[asset] > 0 ? "Enter an amount to see offers." : `No ${asset} in this Safe. Pick another collateral.`)
    : sliderMax < MIN_LOAN ? `Enter more ${asset}. The smallest loan is $500.`
    : null;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader title="Explore offers" sub="Rates are sample data" />

      <Panel title="Your loan">
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr]">
          <Field label="Collateral">
            {(p) => (
              <NativeSelect {...p} className="w-full" value={`${network}:${asset}`} onChange={(e) => { const [n, a] = e.target.value.split(":") as [Network, Asset]; setHolding({ network: n, asset: a }); setAmountText(String(balancesOn(safe, n)[a])); }}>
                {owned.map((h) => {
                  const where = owned.some((o) => o.asset === h.asset && o.network !== h.network) ? ` · ${networkName(h.network)}` : "";
                  return <NativeSelectOption key={`${h.network}:${h.asset}`} value={`${h.network}:${h.asset}`}>{h.asset}{where} · {balancesOn(safe, h.network)[h.asset]} in Safe</NativeSelectOption>;
                })}
              </NativeSelect>
            )}
          </Field>
          <Field label="Collateral amount" suffix={asset} tone={over ? "error" : "hint"} message={over ? `This Safe holds ${BALANCES[asset]} ${asset}.` : undefined}>
            {(p) => <Input {...p} inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} onBlur={() => !over && setAmountText(String(amount))} />}
          </Field>
          {!empty && (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span className="flex justify-between"><span>Loan amount</span><span className="text-sm text-foreground">{usd(loan)}</span></span>
              <input type="range" min={MIN_LOAN} max={sliderMax} step={MIN_LOAN} value={loan} onChange={(e) => setBorrow(Number(e.target.value))} className="h-9 w-full accent-[var(--foreground)]" />
            </label>
          )}
        </div>
        <p className="text-xs text-muted-foreground">On {netName}. Collateral value {usd(value)}{!empty && ` · borrow up to ${usd(sliderMax)}`}{venuesNotOn(network).length > 0 && `. Not on ${netName}: ${venuesNotOn(network).map((v) => v.name).join(", ")}`}</p>
      </Panel>

      {empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {rows.map((r, i) => {
            const { q } = r;
            const s = healthStatus(q.hf, DEFAULT_LEVELS.warn, DEFAULT_LEVELS.act);
            const blocked = loan > r.limit;
            return (
              <div key={r.v.id} className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{r.v.name}</div>
                    <div className="text-xs text-muted-foreground">Borrow {r.v.borrowAsset} · {q.apr.toFixed(1)}% {q.scope === "added" ? "on your loan" : "interest rate"}</div>
                  </div>
                  {i === 0 && <Badge variant="secondary">Lowest rate</Badge>}
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-lg bg-muted p-3 text-xs">
                  <Cell k="Health factor" v={q.hf.toFixed(2)} cls={textClass[s]} sub={statusLabel[s]} />
                  <Cell k="Price can fall" v={q.dropPct === 0 ? "None" : `−${q.dropPct}%`} />
                  <Cell k="Liquidation price" v={usd(q.liqPrice)} />
                  <Cell k="Interest per year" v={usd(q.newYearly)} />
                </div>
                {q.scope === "added" && <p className="text-xs text-muted-foreground">Adds {usd(loan)} to your {usd(q.existingDebt)} loan. Interest is for the new {usd(loan)} (about {usd(q.yearly)} a year on the full {usd(q.debt)} loan). Health and price figures are for the full loan.{rateNote(q)}</p>}
                {blocked && r.limit >= MIN_LOAN ? (
                  <Button className="mt-auto" variant="outline" onClick={() => setBorrow(r.limit)}>Borrow {usd(r.limit)} here</Button>
                ) : (
                  <Button className="mt-auto" variant={i === 0 ? "default" : "secondary"} disabled={blocked} onClick={() => go({ name: "cash", amount: loan, step: 2, asset, network, venueId: r.v.id, collateral: amount, from: "offers" })}>
                    {blocked ? "Too small for this venue" : "Use this lender"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const Cell = ({ k, v, cls, sub }: { k: string; v: string; cls?: string; sub?: string }) => (
  <div className="flex min-w-0 flex-col"><span className="text-muted-foreground">{k}</span><span className={`truncate text-sm font-medium ${cls ?? ""}`}>{v}</span>{sub && <span className={`text-xs ${cls ?? ""}`}>{sub}</span>}</div>
);
