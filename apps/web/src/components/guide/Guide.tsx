"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
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
};

const GuideContext = createContext<GuideApi | null>(null);

type GuidePrefs = { hideAll: boolean; seen: ReadonlySet<string> };
const EMPTY_PREFS: GuidePrefs = { hideAll: false, seen: new Set() };

function readPrefs(): GuidePrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "null") as
      | { hideAll?: unknown; seen?: unknown }
      | null;
    return {
      hideAll: raw?.hideAll === true,
      seen: new Set(Array.isArray(raw?.seen) ? raw.seen.filter((v): v is string => typeof v === "string") : []),
    };
  } catch {
    // Missing or corrupt storage: behave like a first visit on this device.
    return EMPTY_PREFS;
  }
}

function writePrefs(prefs: GuidePrefs) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, hideAll: prefs.hideAll, seen: [...prefs.seen] }));
  } catch {
    // Storage can be off; the in-memory copy still covers this session.
  }
}

/** Actually shown: attached, not inside a `hidden` subtree, visible per the box tree when supported. */
function isShown(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest("[hidden]")) return false;
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
  const progress = useRef<{ path: string; topicId: string; step: number } | null>(null);
  const [spot, setSpot] = useState<HTMLElement | null>(null);
  // Focus hand-off for when the overlay closes: the control to point at next, and the
  // route-local element that last opened the guide (restored on Done/Escape/Dismiss).
  const focusNext = useRef<HTMLElement | null>(null);
  const trigger = useRef<{ el: HTMLElement; path: string } | null>(null);

  useEffect(() => {
    setPrefs(readPrefs());
    setReady(true);
  }, []);

  const lastPath = useRef(pathKey);
  useEffect(() => {
    if (lastPath.current === pathKey) return;
    lastPath.current = pathKey;
    // A different route — or a different Safe — makes a paused step, its highlight and
    // route-local focus anchors stale. Device prefs deliberately survive navigation.
    setView({ kind: "closed" });
    setSpot(null);
    progress.current = null;
    focusNext.current = null;
    trigger.current = null;
  }, [pathKey]);

  const markSeen = useCallback((topicId: string) => {
    setPrefs((prev) => {
      if (prev.seen.has(topicId)) return prev;
      const next = { hideAll: prev.hideAll, seen: new Set(prev.seen).add(topicId) };
      writePrefs(next);
      return next;
    });
  }, []);

  const dismissIntros = useCallback(() => {
    setPrefs((prev) => {
      if (prev.hideAll) return prev;
      const next = { hideAll: true, seen: prev.seen };
      writePrefs(next);
      return next;
    });
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
      if (from) trigger.current = { el: from, path: pathKey };
      const id = topicId ?? currentTopicId;
      // Saved progress resumes only when it still belongs to the topic this open lands on.
      const resume = progress.current && progress.current.path === pathKey && progress.current.topicId === id ? progress.current : null;
      progress.current = null;
      if (!id) {
        setView({ kind: "index" });
        return;
      }
      markSeen(id);
      setView({ kind: "topic", topicId: id, step: resume?.step ?? 0 });
    },
    [currentTopicId, markSeen, pathKey],
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
      const el = step.target ? guideTarget(step.target) : null;
      // The control went away since the step rendered — keep the guide open rather than
      // hiding it over nothing.
      if (!el) return;
      progress.current = { path: pathKey, topicId, step: stepIndex };
      // A disabled control can be pointed at and explained, not focused.
      focusNext.current = el.matches(":disabled") ? null : el;
      setView({ kind: "closed" });
      setSpot(el);
    },
    [pathKey],
  );

  const backToGuide = useCallback(() => {
    const saved = progress.current;
    setSpot(null);
    if (saved && saved.path === pathKey) {
      progress.current = null;
      setView({ kind: "topic", topicId: saved.topicId, step: saved.step });
    } else {
      open();
    }
  }, [open, pathKey]);

  // Base UI calls this as the popup closes: the spotlighted control wins, then the trigger
  // that opened this guide (still route-local and shown), then any visible Guide button —
  // the persistent anchor — and finally the default chain.
  const focusAfterClose = useCallback((): HTMLElement | boolean | null => {
    const pending = focusNext.current;
    focusNext.current = null;
    if (pending?.isConnected) return pending;
    if (trigger.current?.path === pathKey && isShown(trigger.current.el)) return trigger.current.el;
    for (const el of document.querySelectorAll<HTMLElement>("[data-guide-button]")) {
      if (isShown(el)) return el;
    }
    return true;
  }, [pathKey]);

  // Point at the control — scroll and outline only, the guide never clicks it or asks the
  // wallet for anything. Focus arrives via finalFocus once the overlay is gone.
  useEffect(() => {
    if (!spot) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    spot.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
    const nativelyFocusable =
      /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(spot.tagName) ||
      spot.hasAttribute("tabindex") ||
      spot.isContentEditable;
    if (!nativelyFocusable) spot.setAttribute("tabindex", "-1");
    spot.classList.add(styles.spotlight ?? "guide-spotlight");
    return () => {
      spot.classList.remove(styles.spotlight ?? "guide-spotlight");
      if (!nativelyFocusable) spot.removeAttribute("tabindex");
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
    }),
    [pathname, ready, currentTopicId, open, registerTopic, prefs, dismissIntros],
  );

  return (
    <GuideContext.Provider value={api}>
      {children}
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
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2">
        <Title>All guides</Title>
      </div>
      <GuideTopicList onPick={onPick} />
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
      attributeFilter: ["data-guide-target", "hidden", "style", "class", "disabled"],
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
            <div aria-live="polite" className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Step {i + 1} of {stepCount}
              </p>
              <p className="text-sm font-medium">{current.title}</p>
            </div>
            <p className="text-sm text-muted-foreground">{current.body}</p>
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
 * create-safe inside /onboarding). Outside a GuideProvider it renders nothing.
 */
export function GuideIntro({ topicId }: { topicId?: string }) {
  const guide = useContext(GuideContext);
  const register = guide?.registerTopic;
  useEffect(() => (register && topicId ? register(topicId) : undefined), [register, topicId]);
  const id = topicId ?? (guide ? topicForPath(guide.pathname)?.id : undefined);
  const topic = id ? guideTopics.find((t) => t.id === id) : undefined;
  if (!guide?.ready || !id || !topic || guide.hideIntros || guide.seenTopics.has(id)) return null;
  return (
    <aside
      role="note"
      aria-label={`${topic.title} — guide`}
      className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
      onKeyDown={(e) => {
        if (e.key === "Escape") guide.dismissIntros();
      }}
    >
      <div className="flex items-start gap-3">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-medium">{topic.title}</p>
          <p className="text-sm text-muted-foreground">{topic.summary}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss guide" onClick={guide.dismissIntros}>
          <X />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={(e) => guide.open(id, e.currentTarget)}>
          Walk through the steps
        </Button>
      </div>
    </aside>
  );
}
