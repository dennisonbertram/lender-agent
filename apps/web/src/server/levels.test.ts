import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createFixtureReader, type FixtureReader } from "@/server/chain/fixture";
import { activity, loanLevels, safes } from "@/server/db/schema";
import { createTestDb, type Db } from "@/server/db/test-db";
import { HttpError } from "@/server/http";
import type { SafeContext } from "@/server/request";
import type { Address, LoanPosition } from "@/shared/types";
import { DEFAULT_LEVELS } from "@/lib/loan-math";
import { loansFor } from "./loans";
import { saveLevels } from "./levels";

const SAFE = "0x5afE5aFE5Afe5afe5aFe5afE5afE5aFE5afe0001" as Address;
const LOAN_ID = `8453:${SAFE.toLowerCase()}:aave-v3`;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const position = (hf: number): LoanPosition => ({
  chainId: 8453, safe: SAFE, lender: "aave-v3", id: LOAN_ID,
  collateral: [{ asset: "WETH", token: WETH, amount: 2, usd: 6000 }],
  debt: [{ asset: "USDC", token: USDC, amount: 2000, usd: 2000 }],
  healthFactor: hf, liquidationThreshold: 0.83, ltv: 0.8, mixed: false, blockNumber: 57_172_001n,
});

let db: Db;
let reader: FixtureReader;
let safeId: number;
const ctx = (owned: number[] = [8453]) => ({
  db, services: { reader }, safe: { id: safeId, address: SAFE.toLowerCase(), name: "Main" },
  networks: [{ safeId, chainId: 8453, deployed: true, agentAdded: true }],
  access: { ownedChainIds: owned, trackedChainIds: [8453], chat: true, ownersDiffer: false },
}) as unknown as SafeContext;

beforeEach(async () => {
  db = await createTestDb();
  reader = createFixtureReader();
  [{ id: safeId }] = await db.insert(safes).values({ address: SAFE.toLowerCase(), name: "Main" }).returning();
  reader.setBalances(8453, SAFE, { ETH: 1 });
  reader.setPosition(8453, SAFE, position(1.35)); // inside the default Watch band (1.25 to 1.45)
});

describe("saveLevels (BP-19)", () => {
  it("saves valid levels and says what the loan now shows", async () => {
    const r = await saveLevels(ctx(), LOAN_ID, "1.3", "1.2");
    expect(r.levels).toEqual({ warn: 1.3, act: 1.2 });
    expect(r.message).toBe("Saved. Aave v3 now shows Healthy, not Watch (health 1.35).");
    const [row] = await db.select().from(loanLevels);
    expect(row).toMatchObject({ safeId, loanId: LOAN_ID, chainId: 8453, warn: 1.3, act: 1.2 });
  });

  it("the saved levels drive the loan's status; the defaults apply with no row", async () => {
    expect((await loansFor(ctx())).loans[0]).toMatchObject({ status: "watch", levels: DEFAULT_LEVELS });
    await saveLevels(ctx(), LOAN_ID, "2", "1.6");
    const l = (await loansFor(ctx())).loans[0];
    expect(l).toMatchObject({ status: "risk", levels: { warn: 2, act: 1.6 } });
    expect(l.shell.status).toBe("risk");
  });

  it("saving again replaces the row and writes an Activity row for the owner (G3)", async () => {
    await saveLevels(ctx(), LOAN_ID, "1.8", "1.4");
    await saveLevels(ctx(), LOAN_ID, "1.7", "1.3");
    expect(await db.select().from(loanLevels)).toHaveLength(1);
    const rows = await db.select().from(activity).where(eq(activity.safeId, safeId));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ actor: "You", kind: "status", chainId: 8453 });
  });

  it.each([
    ["", "1.3", "Enter Watch level."],
    ["1.6", "", "Enter At-risk level."],
    ["abc", "1.3", "Use numbers only, for example 1.6."],
    ["5.1", "1.3", "Watch level can be at most 5.0."],
    ["1.6", "1", "At-risk level must be above 1.0."],
    ["1.3", "1.3", "At-risk level must be below Watch level."],
    ["1.2", "1.5", "At-risk level must be below Watch level."],
  ])("invalid (%s, %s): 400 with the specific message and nothing saved", async (warn, act, message) => {
    await expect(saveLevels(ctx(), LOAN_ID, warn, act)).rejects.toMatchObject({ status: 400, message });
    expect(await db.select().from(loanLevels)).toHaveLength(0);
    expect(await db.select().from(activity)).toHaveLength(0);
  });

  it("accepts the bounds: Watch 5, At-risk just above 1", async () => {
    await expect(saveLevels(ctx(), LOAN_ID, "5", "1.01")).resolves.toMatchObject({ levels: { warn: 5, act: 1.01 } });
  });

  it("404 for a loan the Safe does not have; 403 for a network the wallet does not own (G4)", async () => {
    await expect(saveLevels(ctx(), `8453:0x0000000000000000000000000000000000000001:aave-v3`, "1.6", "1.35")).rejects.toBeInstanceOf(HttpError);
    await expect(saveLevels(ctx([]), LOAN_ID, "1.6", "1.35")).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(loanLevels)).toHaveLength(0);
  });
});
