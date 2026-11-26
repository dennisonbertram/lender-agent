// Zod discriminated union for every `UIBlock` kind (src/lib/blocks.ts). A block carries parameters,
// never figures (architecture section 6). Every tool parses its own result with this schema.
import { z } from "zod";
import type { UIBlock } from "@/lib/blocks";

const asset = z.enum(["ETH", "wstETH", "WBTC"]);
const network = z.enum(["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"]);
const amount = z.number().finite().nonnegative();

export const blockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    cash: amount,
    asset: asset.optional(),
    network: network.optional(),
    venueId: z.string().optional(),
    hfIdx: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    months: z.union([z.literal(3), z.literal(12), z.literal(24)]).optional(),
    edit: z.boolean().optional(),
    hypothetical: z.boolean().optional(),
    refusal: z.object({ reason: z.literal("not_enough_collateral"), needUsd: amount }).optional(),
  }),
  z.object({ kind: z.literal("compare"), cash: amount, asset: asset.optional(), network: network.optional() }),
  z.object({ kind: z.literal("whatif"), asset: asset.optional(), cash: amount.optional(), drop: z.number().int().min(0).max(100).optional(), capped: z.boolean().optional() }),
  z.object({ kind: z.literal("explain"), topic: z.enum(["how", "health", "liquidation", "collateral", "safe", "reserve"]) }),
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("fix"), loanId: z.string().min(1) }),
  z.object({ kind: z.literal("holdings") }),
  z.object({ kind: z.literal("addfunds") }),
  z.object({ kind: z.literal("suggestions"), items: z.array(z.string().min(1)).min(1).max(6) }),
]);

// Compile-time check that the schema and the mockup type agree.
type _Same = z.infer<typeof blockSchema> extends UIBlock ? (UIBlock extends z.infer<typeof blockSchema> ? true : never) : never;
export const _blockTypesAgree: _Same = true;

/** Parse an unknown value into a block; throws a ZodError when it is not one. */
export const parseBlock = (value: unknown): UIBlock => blockSchema.parse(value) as UIBlock;
export const safeParseBlock = (value: unknown): UIBlock | null => {
  const r = blockSchema.safeParse(value);
  return r.success ? (r.data as UIBlock) : null;
};
