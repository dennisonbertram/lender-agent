"use client";

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CircleHelp, X } from "lucide-react";

import { guideTopics, topicForPath, type GuideStep, type GuideTopic } from "./guide-content";
import { GuideTopicList } from "./GuideTopicList";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { usePhone } from "@/components/ui/use-phone";
import { cn } from "@/lib/utils";
import styles from "./guide.module.css";

const STORE_KEY = "la:guide:v1";

type GuideView =
  | { kind: "closed" }
  | { kind: "topic"; topicId: string; step: number }
  | { kind: "index"; returnTo?: { topicId: string; step: number } };

type GuideApi = {
  /** Current pathname ("" when the router has not resolved one). */
  pathname: string;
  ready: boolean;
  /** What a manual open lands on: a mounted GuideIntro's override wins over the path topic. */
  currentTopicId: string | undefined;
  /** Open the walkthrough from `opener` (default: whatever element is focused): an explicit topic,
      else saved progress on this screen, else the current topic, else the index. */
  open: (topicId?: string, opener?: HTMLElement | null) => void;
  /** A GuideIntro registers the feature it actually sits in; returns the unregister. */
  registerTopic: (topicId: string) => () => void;
  /** User asked to never see the inline explanations again on this device. */
  hideIntros: boolean;
  /** Topics whose guide was already opened or finished on this device. */
  seenTopics: ReadonlySet<string>;
  /** Mute every inline explanation on this device; the manual Guide button still works. */
  dismissIntros: () => void;
  /** Undo a mute: let inline explanations appear again on this device. */
  restoreIntros: () => void;
};

const GuideContext = createContext<GuideApi | null>(null);

type GuidePrefs = { hideAll: boolean; seen: ReadonlySet<string> };
const EMPTY_PREFS: GuidePrefs = { hideAll: false, seen: new Set() };

/** Stored prefs, or null when storage is missing, corrupt or blocked — callers then keep session state. */
function readStored(): GuidePrefs | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "null") as
      | { hideAll?: unknown; seen?: unknown }
      | null;
    return {
      hideAll: raw?.hideAll === true,
      seen: new Set(Array.isArray(raw?.seen) ? raw.seen.filter((v): v is string => typeof v === "string") : []),
    };
  } catch {
    return null;
  }
}

function unionSeen(...sets: ReadonlySet<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const t of s) out.add(t);
  return out;
}

function writePrefs(prefs: GuidePrefs) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, hideAll: prefs.hideAll, seen: [...prefs.seen] }));
  } catch {
    // Storage can be off; the in-memory copy still covers this session.
  }
}

/** Actually shown: attached, not inside a `hidden` subtree or a closed `details` (whose
    own summary stays rendered), and visible per the box tree when supported. */
function isShown(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest("[hidden]")) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.tagName !== "DETAILS" || p.hasAttribute("open")) continue;
    const summary = [...p.children].find((c) => c.tagName === "SUMMARY");
    if (!summary?.contains(el)) return false;
  }
  // jsdom lacks checkVisibility; there an attached non-hidden node counts as shown.
  return typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : true;
}

/** The first *shown* control among any duplicates carrying the step's target name. */
function guideTarget(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide-target="${name}"]`)) {
    if (isShown(el)) return el;
  }
  return null;
}

export function GuideProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const pathKey = pathname.toLowerCase();
  const phone = usePhone();
  // Deterministic first render: device prefs are only read after mount (see GuideIntro too).
  const [ready, setReady] = useState(false);
  const [prefs, setPrefs] = useState<GuidePrefs>(EMPTY_PREFS);
  const [view, setView] = useState<GuideView>({ kind: "closed" });
  const overrides = useRef<string[]>([]);
  const [, bumpOverrides] = useState(0);
  // The query string belongs to the screen's identity: on routes like
  // /onboarding/agent?safe=<addr> it carries the Safe the page is about.
  const [query, setQuery] = useState("");
  const onQuery = useCallback((q: string) => setQuery((prev) => (prev === q ? prev : q)), []);
  const scopeKey = `${pathKey}\n${query}`;
  const progress = useRef<{ scope: string; topicId: string; step: number } | null>(null);
  // The highlighted control plus the step's target name at activation: one control can be
  // reused for another action (a wizard's Next/Confirm), so the marker — not the node —
  // decides whether the paused spotlight still points at the right thing.
  const [spot, setSpot] = useState<{ el: HTMLElement; target: string } | null>(null);
  // Focus hand-off for when the overlay closes: the control to point at next, and the
  // route-local element that last opened the guide (restored on Done/Escape/Dismiss).
  const focusNext = useRef<HTMLElement | null>(null);
  const trigger = useRef<{ el: HTMLElement; scope: string } | null>(null);

  useEffect(() => {
    setPrefs(readStored() ?? EMPTY_PREFS);
    setReady(true);
  }, []);

  const lastScope = useRef(scopeKey);
  useEffect(() => {
    if (lastScope.current === scopeKey) return;
    lastScope.current = scopeKey;
    // A different route — or a different Safe in the query, same path or not — makes a
    // paused step, its highlight and route-local focus anchors stale. Device prefs
    // deliberately survive navigation.
    setView({ kind: "closed" });
    setSpot(null);
    progress.current = null;
    focusNext.current = null;
    trigger.current = null;
  }, [scopeKey]);

  const markSeen = useCallback((topicId: string) => {
    setPrefs((prev) => {
      // Merge against what other tabs wrote since this one loaded: a tab holding stale
      // prefs must not write an old hideAll or a partial seen list over a newer dismissal.
      // The stored toggle wins (last writer wins); seen topics only ever union.
      const stored = readStored();
      const seen = unionSeen(stored?.seen ?? EMPTY_PREFS.seen, prev.seen);
      seen.add(topicId);
      const hideAll = stored?.hideAll ?? prev.hideAll;
      if (hideAll === prev.hideAll && seen.size === prev.seen.size) return prev;
      const next = { hideAll, seen };
      writePrefs(next);
      return next;
    });
  }, []);

  const dismissIntros = useCallback(() => {
    setPrefs((prev) => {
      const stored = readStored();
      const next = { hideAll: true, seen: unionSeen(stored?.seen ?? EMPTY_PREFS.seen, prev.seen) };
      writePrefs(next);
      return next;
    });
  }, []);

  const restoreIntros = useCallback(() => {
    setPrefs((prev) => {
      if (!prev.hideAll) return prev;
      const stored = readStored();
      const next = { hideAll: false, seen: unionSeen(stored?.seen ?? EMPTY_PREFS.seen, prev.seen) };
      writePrefs(next);
      return next;
    });
  }, []);

  // Another tab's writes arrive as storage events: adopt its toggle, union its seen list,
  // and write the union back so a stale tab can't drop topics this one already saw.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key !== STORE_KEY) return;
      const stored = readStored();
      if (!stored) return;
      setPrefs((prev) => {
        const next = { hideAll: stored.hideAll, seen: unionSeen(stored.seen, prev.seen) };
        if (next.seen.size > stored.seen.size) writePrefs(next);
        return next;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const registerTopic = useCallback((topicId: string) => {
    const stack = overrides.current;
    stack.push(topicId);
    bumpOverrides((t) => t + 1);
    return () => {
      const i = stack.lastIndexOf(topicId);
      if (i >= 0) {
        stack.splice(i, 1);
        bumpOverrides((t) => t + 1);
      }
    };
  }, []);

  const currentTopicId = overrides.current[overrides.current.length - 1] ?? topicForPath(pathname)?.id;

  const open = useCallback(
    (topicId?: string, opener?: HTMLElement | null) => {
      setSpot(null);
      focusNext.current = null;
      const from = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      if (from) trigger.current = { el: from, scope: scopeKey };
      const id = topicId ?? currentTopicId;
      // Saved progress resumes only when it still belongs to the topic this open lands on.
      const resume = progress.current && progress.current.scope === scopeKey && progress.current.topicId === id ? progress.current : null;
      progress.current = null;
      if (!id) {
        setView({ kind: "index" });
        return;
      }
      markSeen(id);
      setView({ kind: "topic", topicId: id, step: resume?.step ?? 0 });
    },
    [currentTopicId, markSeen, scopeKey],
  );

  const pickTopic = useCallback(
    (topicId: string) => {
      markSeen(topicId);
      setView({ kind: "topic", topicId, step: 0 });
    },
    [markSeen],
  );

  const showOnPage = useCallback(
    (step: GuideStep, topicId: string, stepIndex: number) => {
      const name = step.target;
      const el = name ? guideTarget(name) : null;
      // The control went away since the step rendered — keep the guide open rather than
      // hiding it over nothing.
      if (!name || !el) return;
      progress.current = { scope: scopeKey, topicId, step: stepIndex };
      // A disabled control can be pointed at and explained, not focused.
      focusNext.current = el.matches(":disabled") ? null : el;
      setView({ kind: "closed" });
      setSpot({ el, target: name });
    },
    [scopeKey],
  );

  const backToGuide = useCallback(() => {
    const saved = progress.current;
    setSpot(null);
    if (saved && saved.scope === scopeKey) {
      progress.current = null;
      setView({ kind: "topic", topicId: saved.topicId, step: saved.step });
    } else {
      open();
    }
  }, [open, scopeKey]);

  // Base UI calls this as the popup closes: the spotlighted control wins, then the trigger
  // that opened this guide (still route-local and shown), then any visible Guide button —
  // the persistent anchor — and finally the default chain.
  const focusAfterClose = useCallback((): HTMLElement | boolean | null => {
    const pending = focusNext.current;
    focusNext.current = null;
    if (pending?.isConnected) return pending;
    if (trigger.current?.scope === scopeKey && isShown(trigger.current.el)) return trigger.current.el;
    for (const el of document.querySelectorAll<HTMLElement>("[data-guide-button]")) {
      if (isShown(el)) return el;
    }
    return true;
  }, [scopeKey]);

  // Point at the control — scroll and outline only, the guide never clicks it or asks the
  // wallet for anything. Focus arrives via finalFocus once the overlay is gone.
  useEffect(() => {
    if (!spot) return;
    const el = spot.el;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    el.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
    const nativelyFocusable =
      /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName) ||
      el.hasAttribute("tabindex") ||
      el.isContentEditable;
    if (!nativelyFocusable) el.setAttribute("tabindex", "-1");
    el.classList.add(styles.spotlight ?? "guide-spotlight");
    return () => {
      el.classList.remove(styles.spotlight ?? "guide-spotlight");
      if (!nativelyFocusable) el.removeAttribute("tabindex");
    };
  }, [spot]);

  // Escape ends the spotlight without reopening the guide.
  useEffect(() => {
    if (!spot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSpot(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [spot]);

  // The highlighted control can unmount, hide or stop being the step's target while the
  // guide is paused — drop the spotlight and its banner rather than claim a highlight
  // that no longer exists.
  useEffect(() => {
    if (!spot) return;
    const check = () => {
      if (spot.el.getAttribute("data-guide-target") !== spot.target || !isShown(spot.el)) setSpot(null);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-guide-target", "hidden", "style", "class", "disabled", "open"],
    });
    return () => observer.disconnect();
  }, [spot]);

  const api = useMemo<GuideApi>(
    () => ({
      pathname,
      ready,
      currentTopicId,
      open,
      registerTopic,
      hideIntros: prefs.hideAll,
      seenTopics: prefs.seen,
      dismissIntros,
      restoreIntros,
    }),
    [pathname, ready, currentTopicId, open, registerTopic, prefs, dismissIntros, restoreIntros],
  );

  return (
    <GuideContext.Provider value={api}>
      {children}
      {/* useSearchParams suspends on statically prerendered routes; it must stay inside
          its own Suspense boundary or the production build fails. */}
      <Suspense fallback={null}>
        <SearchScope onQuery={onQuery} />
      </Suspense>
      {view.kind !== "closed" && (
        <GuideOverlay
          phone={phone}
          view={view}
          onView={setView}
          onPickTopic={pickTopic}
          onClose={() => setView({ kind: "closed" })}
          onShowOnPage={showOnPage}
          onReturnFocus={focusAfterClose}
        />
      )}
      {spot && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-popover py-1.5 pl-4 pr-1.5 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          <span className="truncate">Guide paused — the control is highlighted</span>
          <Button size="sm" className="shrink-0" onClick={backToGuide}>
            Back to guide
          </Button>
          <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Dismiss" onClick={() => setSpot(null)}>
            <X />
          </Button>
        </div>
      )}
    </GuideContext.Provider>
  );
}

/** Reports the live query string; the provider folds it into the route scope so a
    same-path Safe switch (?safe=) resets guide state like any other navigation. */
function SearchScope({ onQuery }: { onQuery: (query: string) => void }) {
  const query = useSearchParams()?.toString() ?? "";
  useEffect(() => onQuery(query), [onQuery, query]);
  return null;
}

function GuideOverlay({
  phone,
  view,
  onView,
  onPickTopic,
  onClose,
  onShowOnPage,
  onReturnFocus,
}: {
  phone: boolean;
  view: GuideView;
  onView: (view: GuideView) => void;
  onPickTopic: (topicId: string) => void;
  onClose: () => void;
  onShowOnPage: (step: GuideStep, topicId: string, stepIndex: number) => void;
  onReturnFocus: () => HTMLElement | boolean | null;
}) {
  const closeIf = (open: boolean) => {
    if (!open) onClose();
  };
  const Title = (phone ? SheetTitle : DialogTitle) as ElementType;
  const topic = view.kind === "topic" ? guideTopics.find((t) => t.id === view.topicId) : undefined;
  const body =
    view.kind === "index" || (view.kind === "topic" && !topic) ? (
      <TopicIndex
        Title={Title}
        back={view.kind === "index" ? view.returnTo : undefined}
        onPick={onPickTopic}
        onBack={(b) => onView({ kind: "topic", topicId: b.topicId, step: b.step })}
        onDone={onClose}
      />
    ) : view.kind === "topic" && topic ? (
      <TopicWalkthrough
        Title={Title}
        topic={topic}
        step={view.step}
        onStep={(step) => onView({ kind: "topic", topicId: topic.id, step })}
        onIndex={() => onView({ kind: "index", returnTo: { topicId: topic.id, step: view.step } })}
        onDone={onClose}
        onShowOnPage={(stepDef, i) => onShowOnPage(stepDef, topic.id, i)}
      />
    ) : null;
  return phone ? (
    <Sheet open onOpenChange={closeIf}>
      <SheetContent className="gap-4" finalFocus={onReturnFocus}>
        {body}
      </SheetContent>
    </Sheet>
  ) : (
    <Dialog open onOpenChange={closeIf}>
      <DialogContent className="sm:max-w-md" finalFocus={onReturnFocus}>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function TopicIndex({
  Title,
  back,
  onPick,
  onBack,
  onDone,
}: {
  Title: ElementType;
  back?: { topicId: string; step: number };
  onPick: (topicId: string) => void;
  onBack: (back: { topicId: string; step: number }) => void;
  onDone: () => void;
}) {
  const guide = useContext(GuideContext);
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2">
        <Title>All guides</Title>
      </div>
      <GuideTopicList onPick={onPick} />
      {guide?.hideIntros && (
        <Button variant="ghost" size="sm" className="self-start" onClick={guide.restoreIntros}>
          Show introductions for new features
        </Button>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {back && (
            <Button variant="ghost" size="sm" onClick={() => onBack(back)}>
              Back
            </Button>
          )}
        </span>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  );
}

function TopicWalkthrough({
  Title,
  topic,
  step,
  onStep,
  onIndex,
  onDone,
  onShowOnPage,
}: {
  Title: ElementType;
  topic: GuideTopic;
  step: number;
  onStep: (step: number) => void;
  onIndex: () => void;
  onDone: () => void;
  onShowOnPage: (step: GuideStep, stepIndex: number) => void;
}) {
  const stepCount = topic.steps.length;
  const i = Math.max(0, Math.min(step, stepCount - 1));
  const current = stepCount ? topic.steps[i] : undefined;
  const targetName = current?.target;
  const [targetOnPage, setTargetOnPage] = useState(false);

  // Conditional controls can mount or unhide at any point while the step is shown;
  // react to the DOM instead of polling once and keeping a stale answer.
  useEffect(() => {
    if (!targetName) {
      setTargetOnPage(false);
      return;
    }
    const update = () => setTargetOnPage(guideTarget(targetName) !== null);
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-guide-target", "hidden", "style", "class", "disabled", "open"],
    });
    return () => observer.disconnect();
  }, [targetName]);

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2">
        <Title>{topic.title}</Title>
        <p className="text-sm text-muted-foreground">{topic.summary}</p>
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {current ? (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 ring-1 ring-foreground/5">
            {/* Step number, title and instruction all announce when Next/Back is pressed. */}
            <div aria-live="polite" className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Step {i + 1} of {stepCount}
              </p>
              <p className="text-sm font-medium">{current.title}</p>
              <p className="text-sm text-muted-foreground">{current.body}</p>
            </div>
            {targetOnPage && (
              <div>
                <Button variant="outline" size="sm" onClick={() => onShowOnPage(current, i)}>
                  Show on page
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">This guide has no steps yet.</p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onIndex}>
          All topics
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>
            Dismiss
          </Button>
          {i > 0 && (
            <Button variant="outline" size="sm" onClick={() => onStep(i - 1)}>
              Back
            </Button>
          )}
          {i < stepCount - 1 ? (
            <Button size="sm" onClick={() => onStep(i + 1)}>
              Next
            </Button>
          ) : (
            <Button size="sm" onClick={onDone}>
              Done
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/** The "?" affordance the feature places; outside a GuideProvider it renders nothing. */
export function GuideButton({ className }: { className?: string }) {
  const guide = useContext(GuideContext);
  if (!guide) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("gap-1.5", className)}
      data-guide-button
      disabled={!guide.ready}
      onClick={(e) => guide.open(undefined, e.currentTarget)}
    >
      <CircleHelp aria-hidden />
      Guide
    </Button>
  );
}

/**
 * The feature's own short explanation, shown inline on first entry until the topic's guide
 * has been opened — or until the user dismisses intros entirely on this device.
 * `topicId` overrides the path's topic when one screen hosts more than one feature (e.g.
 * create-safe inside /onboarding). `compact` drops the card and title for screens whose
 * own heading already carries it. Outside a GuideProvider it renders nothing.
 */
export function GuideIntro({ topicId, compact = false }: { topicId?: string; compact?: boolean }) {
  const guide = useContext(GuideContext);
  const register = guide?.registerTopic;
  useEffect(() => (register && topicId ? register(topicId) : undefined), [register, topicId]);
  const id = topicId ?? (guide ? topicForPath(guide.pathname)?.id : undefined);
  const topic = id ? guideTopics.find((t) => t.id === id) : undefined;
  if (!guide?.ready || !id || !topic) return null;
  if (guide.hideIntros || guide.seenTopics.has(id)) return null;
  if (compact) {
    // Inline form for screens whose own heading already carries the topic's title:
    // a quiet sentence with the walkthrough link and the device-wide hide grouped
    // into one unbreakable run, so they drop to the next line together. No second
    // card or title. Coarse-pointer targets reserve their height in the line, and
    // the walkthrough target stays within its own button.
    return (
      <aside
        role="note"
        aria-label={`${topic.title} — guide`}
        className="text-sm text-muted-foreground"
        onKeyDown={(e) => {
          if (e.key === "Escape") guide.dismissIntros();
        }}
      >
        <p>
          {topic.summary}{" "}
          <span className="inline-flex items-center gap-1 pointer-coarse:min-h-11">
            <Button variant="link" size="inline" className="pointer-coarse:py-3 pointer-coarse:after:inset-y-0" onClick={(e) => guide.open(id, e.currentTarget)}>
              Walk through the steps
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide automatic introductions on this device"
              title="Hide every automatic guide on this device — the Guide button still opens any guide"
              onClick={guide.dismissIntros}
            >
              <X />
            </Button>
          </span>
        </p>
      </aside>
    );
  }
  return (
    <aside
      role="note"
      aria-label={`${topic.title} — guide`}
      className="flex min-w-0 flex-col gap-2 border-l-2 border-link bg-muted/40 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") guide.dismissIntros();
      }}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-link" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-link">Quick guide</p>
          <p className="text-sm font-medium leading-tight">{topic.title}</p>
          <p className="text-xs leading-snug text-muted-foreground">{topic.summary}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 pl-6 sm:pl-0">
        <Button size="sm" variant="outline" onClick={(e) => guide.open(id, e.currentTarget)}>
          Walk through the steps
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Hide automatic introductions on this device"
          title="Hide every automatic guide on this device — the Guide button still opens any guide"
          onClick={guide.dismissIntros}
        >
          <X />
        </Button>
      </div>
    </aside>
  );
}
