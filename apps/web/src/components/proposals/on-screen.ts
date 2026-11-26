"use client";
// Which proposals the page itself is showing in full, so the docked chat shows a stub instead (VC-07).
// A tiny external store: no provider, no shell file. The page card registers in a layout effect
// (before first paint, so the dock never flashes a second card) and clears on unmount.
import { useLayoutEffect, useSyncExternalStore } from "react";

let shown: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The page card for `id` is on screen for as long as the caller is mounted. `null` registers nothing. */
export function useShowOnScreen(id: string | null) {
  useLayoutEffect(() => {
    if (!id) return;
    shown = new Set(shown).add(id);
    emit();
    return () => {
      const next = new Set(shown);
      next.delete(id);
      shown = next;
      emit();
    };
  }, [id]);
}

export function useIsOnScreen(id: string): boolean {
  return useSyncExternalStore(subscribe, () => shown.has(id), () => false);
}
