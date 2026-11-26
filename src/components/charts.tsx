import { Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BASE_PRICES, PRICES, usd, type Loan } from "@/data";
import { hfHistory, historyLabel, priceDropSeries } from "@/lib/chart-data";
import { healthFactor, healthStatus } from "@/lib/loan-math";
import { Panel, axisProps, statusLabel, tooltipStyle } from "@/components/common";

const margin = { top: 12, right: 20, left: 36, bottom: 0 };
const hfNote = (v: number, warn: number, act: number) => (v < 1 ? "Can be liquidated" : statusLabel[healthStatus(v, warn, act)]);
const hfRow = (warn: number, act: number) => (v: unknown) => [`${Number(v).toFixed(2)} · ${hfNote(Number(v), warn, act)}`, "Health"] as [string, string];

function Fill({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--foreground)" stopOpacity={0.2} />
        <stop offset="100%" stopColor="var(--foreground)" stopOpacity={0} />
      </linearGradient>
    </defs>
  );
}

function Empty({ children }: { children: string }) {
  return <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">{children}</div>;
}

export function LoanCharts({ loan, hf, t }: { loan: Loan; hf: number; t: { warn: number; act: number } }) {
  const price = PRICES[loan.collAsset];
  const base = healthFactor(loan.collAmount * BASE_PRICES[loan.collAsset], loan.lt, loan.debt);
  const history = hfHistory(loan.trend, base, hf);
  const drop = priceDropSeries(price, hf);
  const noDebt = loan.debt <= 0 || !Number.isFinite(hf);
  const minHf = Math.min(...history.map((p) => p.hf));
  const nowColor = hf < 1 ? "var(--destructive)" : "var(--foreground)";
  const ago = (d: number) => (d === 0 ? "Now" : `${-d}d ago`);

  return (
    <div className={drop ? "grid gap-4 @2xl:grid-cols-2" : "grid gap-4"}>
      <Panel title="Health factor · 30 days">
        {noDebt ? <Empty>No debt.</Empty> : !history.length ? <Empty>Opened today. No history yet.</Empty> : (
          <>
          <p className="-mt-2 text-xs text-muted-foreground">Higher is safer. Below 1.0 the loan can be liquidated.</p>
          <div className="h-52" role="img" aria-label={historyLabel(hf, minHf, t)}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={margin}>
                <Fill id="hf-history" />
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="day" type="number" domain={[-30, 0]} ticks={[-30, -20, -10, 0]} tickFormatter={ago} {...axisProps} />
                <YAxis hide domain={[Math.min(0.9, Math.floor(minHf * 10) / 10), "auto"]} />
                <Tooltip {...tooltipStyle} separator=" " labelFormatter={(d) => ago(Number(d))} formatter={hfRow(t.warn, t.act)} />
                <ReferenceLine y={t.warn} ifOverflow="extendDomain" stroke="var(--warning)" strokeDasharray="4 4" label={{ value: `Watch ${t.warn}`, fill: "var(--warning)", fontSize: 12, position: "insideTopLeft" }} />
                <ReferenceLine y={t.act} ifOverflow="extendDomain" stroke="var(--destructive)" strokeDasharray="4 4" label={{ value: `At risk ${t.act}`, fill: "var(--destructive)", fontSize: 12, position: "insideTopLeft" }} />
                <ReferenceLine y={1} stroke="var(--destructive)" label={{ value: "Liquidated 1.0", fill: "var(--destructive)", fontSize: 12, position: "insideBottomLeft" }} />
                <Area dataKey="hf" name="Health" type="monotone" stroke="var(--foreground)" strokeWidth={2} fill="url(#hf-history)" isAnimationActive={false} />
                <ReferenceDot x={0} y={hf} r={4} ifOverflow="extendDomain" fill={nowColor} stroke={nowColor} label={{ value: `Now ${hf.toFixed(2)}`, position: "left", fontSize: 12, fill: nowColor }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          </>
        )}
      </Panel>

      {drop && (
      <Panel title={`If ${loan.collAsset} falls`}>
        {(
          <div className="h-52" role="img" aria-label={`Liquidated if ${loan.collAsset} falls to ${usd(drop.liq)}`}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={drop.points} margin={margin}>
                <Fill id="hf-price" />
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="price" type="number" reversed domain={[drop.low, price]} ticks={[price, drop.liq]} tickFormatter={(p) => (p === price ? `Now ${usd(p)}` : usd(p))} {...axisProps} />
                <YAxis hide domain={[0.9, "auto"]} />
                <Tooltip {...tooltipStyle} separator=" " labelFormatter={(p) => `If ${loan.collAsset} is ${usd(Number(p))}`} formatter={hfRow(t.warn, t.act)} />
                <ReferenceArea x1={drop.liq} x2={drop.low} fill="var(--destructive)" fillOpacity={0.1} label={{ value: "Liquidated", fill: "var(--destructive)", fontSize: 12, position: "insideTop" }} />
                <Area dataKey="hf" name="Health" type="linear" stroke="var(--foreground)" strokeWidth={2} fill="url(#hf-price)" isAnimationActive={false} />
                <ReferenceDot x={price} y={hf} r={4} fill="var(--foreground)" stroke="var(--foreground)" label={{ value: hf.toFixed(2), position: "right", fontSize: 12, fill: "var(--foreground)" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>
      )}
    </div>
  );
}
