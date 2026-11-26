// BP-31 on a Base fork: fund a test Safe with anvil, run the deposit job, and see one deposit,
// one Activity row and one chat message (and still one after more polls).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { listActivity } from "@/server/activity";
import { loadThread } from "@/server/agent/persist";
import { setPublicClientForTests } from "@/server/chain/client";
import { createViemReader } from "@/server/chain/reader";
import { schema, type Db } from "@/server/db/client";
import { createTestDb } from "@/server/db/test-db";
import { pollDeposits } from "@/server/deposits/poll";
import type { Address } from "@/shared/types";
import { ANVIL_KEYS, startBaseFork, type Fork } from "../helpers/anvil";
import { deployTestSafe } from "../helpers/safe";

let fork: Fork;
let safe: Address;
let db: Db;
let safeId: number;
const run = () => pollDeposits({ db, reader: createViemReader(), now: new Date(), log: () => {} });

beforeAll(async () => {
  fork = await startBaseFork();
  setPublicClientForTests(8453, fork.publicClient as PublicClient);
  const owner = privateKeyToAccount(ANVIL_KEYS[1]).address as Address;
  safe = (await deployTestSafe({ fork, owners: [owner], threshold: 1 })).address;
  db = await createTestDb();
  const [s] = await db.insert(schema.safes).values({ address: safe.toLowerCase(), name: "Fork Safe" }).returning();
  safeId = s.id;
  await db.insert(schema.safeNetworks).values({ safeId, chainId: 8453, deployed: true });
}, 240_000);

afterAll(async () => {
  setPublicClientForTests(8453, undefined);
  await fork?.stop();
});

describe("deposit notice on a Base fork", () => {
  it("funding the Safe gives one deposit, one Activity row and one chat message", async () => {
    await run(); // empty Safe: baseline only
    expect(await db.select().from(schema.deposits)).toHaveLength(0);
    await fork.testClient.setBalance({ address: safe, value: parseEther("2") });
    await run();
    await run();
    expect(await db.select().from(schema.deposits)).toHaveLength(1);
    const act = await listActivity(db, safeId);
    expect(act).toHaveLength(1);
    expect(act[0].text).toContain("2 ETH");
    const thread = await loadThread(db, safeId);
    expect(thread).toHaveLength(1);
    const text = thread[0].parts.find((p) => p.type === "text") as { text: string };
    expect(text.text).toMatch(/^I see 2 ETH \(about \$[\d,]+\) on Base in Fork Safe\. You can borrow up to \$[\d,]+ against it without selling it\.$/);
    expect(thread[0].parts.filter((p) => p.type === "data-block")).toHaveLength(1);
  }, 120_000);
});
