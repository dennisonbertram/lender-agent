"use client";

import type { ReactNode } from "react";
import type { UIBlock } from "@/lib/blocks";
import { blockCard } from "./card";

export { blockCard };

/** `render` maps each block kind the caller can show to its element. The data for each block comes from the caller, never from here. */
export type BlockRenderers = { [K in UIBlock["kind"]]?: (block: Extract<UIBlock, { kind: K }>) => ReactNode };

/** Picks the renderer for the block's kind. Kinds without a renderer render nothing. */
export function Block({ block, render }: { block: UIBlock; render: BlockRenderers }) {
  const fn = render[block.kind] as ((b: UIBlock) => ReactNode) | undefined;
  return <>{fn?.(block) ?? null}</>;
}
