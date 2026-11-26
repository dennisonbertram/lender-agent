import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePhone } from "@/components/ui/use-phone";

/**
 * The state's one action. The headline is the live region; `primary` is the single high-emphasis control
 * (or a disabled status button). Sticky to the bottom of its scroll container, safe-area aware.
 * On phones (< 480 px) the bar is compact: headline, a one-line caption, and one row with the primary button
 * beside "More options" (the secondary actions); `detail` is a second toggle row. Nothing is clipped, and
 * opening a toggle grows the bar.
 */
export function ActionBar({ headline, body, note, detail, primary, helper, secondary, sticky = true, className, style, barRef }: {
  headline: ReactNode; body?: ReactNode; note?: ReactNode; detail?: { label: string; content: ReactNode }; primary?: ReactNode; helper?: ReactNode; secondary?: ReactNode[]; sticky?: boolean; className?: string; style?: CSSProperties; barRef?: Ref<HTMLElement>;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState<"detail" | "more" | null>(null);
  const list = (secondary ?? []).map((s, i) => <div key={i}>{s}</div>);
  const folded = phone && (list.length > 1 || !!detail);
  const toggles = [detail && { key: "detail" as const, label: detail.label }, list.length > 0 && { key: "more" as const, label: "More options" }].filter(Boolean) as { key: "detail" | "more"; label: string }[];
  // Phone, no wallet detail: the primary button and "More options" share one row.
  const inline = folded && !!primary && !detail;
  const moreToggle = inline && (
    <button type="button" aria-expanded={open === "more"} onClick={() => setOpen(open === "more" ? null : "more")} className="flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", open === "more" && "rotate-90")} />More options
    </button>
  );
  const linkRow = "[&>*]:flex [&>*]:min-h-11 [&>*]:items-center [&>*]:text-sm";
  return (
    <section
      ref={barRef}
      style={style}
      data-slot="action-bar"
      data-sticky={sticky || undefined}
      className={cn(
        "flex flex-col gap-2 overflow-y-auto border-t border-border bg-card px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]",
        open ? "max-h-[70dvh]" : "max-h-[45dvh]",
        sticky && "sticky bottom-0 z-10 shadow-[var(--shadow-bar)]",
        className,
      )}
    >
      <h2 aria-live="polite" className="text-base font-semibold">{headline}</h2>
      {body && <p className={cn("text-sm text-muted-foreground", phone && "line-clamp-1")}>{body}</p>}
      {!(phone && detail) && note}
      {inline ? (
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1 [&>*]:w-full">{primary}</div>
          {moreToggle}
        </div>
      ) : primary && <div className="flex flex-col gap-1 [&>*]:w-full">{primary}</div>}
      {helper && <p className={cn("text-xs text-muted-foreground", phone && "line-clamp-1")}>{helper}</p>}
      {folded ? (
        <>
          {!inline && <div className="flex gap-2">
            {toggles.map((t) => (
              <button key={t.key} type="button" aria-expanded={open === t.key} onClick={() => setOpen(open === t.key ? null : t.key)} className="flex min-h-11 flex-1 items-center justify-start gap-1 rounded-md text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", open === t.key && "rotate-90")} />{t.label}
              </button>
            ))}
          </div>}
          {open === "detail" && detail && <div className="text-sm">{detail.content}</div>}
          {open === "more" && <div className={cn("flex flex-col", linkRow)}>{list}</div>}
        </>
      ) : list.length > 0 && (
        <div className={cn("flex flex-col gap-0 min-[480px]:flex-row min-[480px]:flex-wrap min-[480px]:gap-x-4", linkRow)}>{list}</div>
      )}
    </section>
  );
}
