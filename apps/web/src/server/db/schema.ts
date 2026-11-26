// The one Postgres schema for M1 (architecture section 5). Owner: the coordinator.
// Change it only through the coordinator; then run `pnpm --filter @ai-loan-agent/web db:generate`.
import { sql } from "drizzle-orm";
import { bigint, boolean, doublePrecision, index, integer, jsonb, numeric, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Addresses are stored lowercased; checksum them for display. */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  address: text("address").notNull().unique(),
  email: text("email"),
  createdAt: createdAt(),
});

export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  /** sha256 of the cookie token; the token itself is never stored. */
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  address: text("address").notNull(),
  chainId: integer("chain_id").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const safes = pgTable("safes", {
  id: serial("id").primaryKey(),
  address: text("address").notNull().unique(),
  name: text("name").notNull(),
  /** `SafeSetup` from `@/shared/types` when known (M0-5). Null for Safes created outside the app. */
  setup: jsonb("setup"),
  createdAt: createdAt(),
});

/** One row per network the app tracks for a Safe. Cached owners only render early; chain is the truth. */
export const safeNetworks = pgTable("safe_networks", {
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  deployed: boolean("deployed").notNull().default(false),
  agentAdded: boolean("agent_added").notNull().default(false),
  agentChangedAt: timestamp("agent_changed_at", { withTimezone: true }),
  cachedOwners: jsonb("cached_owners").$type<string[]>(),
  cachedThreshold: integer("cached_threshold"),
  ownersReadAt: timestamp("owners_read_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.safeId, t.chainId] })]);

/** Safes a user picked (their list). Access is still checked on-chain per request. */
export const userSafes = pgTable("user_safes", {
  userId: integer("user_id").notNull().references(() => users.id),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  addedAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.safeId] })]);

/** Chat thread per Safe address, AI SDK UIMessage JSON. Append-only (r12). */
export const messages = pgTable("messages", {
  seq: serial("seq").primaryKey(),
  id: text("id").notNull().unique(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  role: text("role").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  message: jsonb("message").notNull(),
  createdAt: createdAt(),
}, (t) => [index("messages_safe_idx").on(t.safeId, t.seq)]);

export const proposals = pgTable("proposals", {
  id: text("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  /** The typed `Spec` from `@/lib/proposals`. */
  spec: jsonb("spec").notNull(),
  /** `SafeTx` from `@/shared/types`; immutable once stored. */
  tx: jsonb("tx"),
  nonce: bigint("nonce", { mode: "bigint" }),
  safeTxHash: text("safe_tx_hash"),
  /** Committed before the first Safe service POST; a non-null value forbids any retry or nonce release on absence. */
  submissionAttemptedAt: timestamp("submission_attempted_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  title: text("title").notNull(),
  steps: jsonb("steps").$type<string[]>().notNull(),
  outcome: text("outcome").notNull(),
  /** `ProposalStage` from `@/shared/types`. */
  stage: text("stage").notNull(),
  confirmations: jsonb("confirmations").$type<{ owner: string; submittedAt: string }[]>().notNull().default(sql`'[]'::jsonb`),
  threshold: integer("threshold"),
  executedTxHash: text("executed_tx_hash"),
  /** Test-run result: { ok, feeUsd?, healthAfter?, reason? }. */
  testRun: jsonb("test_run"),
  stopReason: text("stop_reason"),
  /** True once the agent's DeleteRequest was accepted. */
  deletedFromQueue: boolean("deleted_from_queue").notNull().default(false),
  replacedBy: text("replaced_by"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [// Live rows only: a refused (not_sent) or deleted proposal never reached or left the Safe queue, so an identical re-draft may reuse its hash.
  uniqueIndex("proposals_hash_idx").on(t.chainId, t.safeTxHash).where(sql`${t.stage} <> 'not_sent' and not ${t.deletedFromQueue}`), index("proposals_safe_idx").on(t.safeId, t.stage)]);

/** Append-only log (BP-27). Only `recordActivity` writes it; no update or delete path. */
export const activity = pgTable("activity", {
  id: serial("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  actorAddress: text("actor_address"),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  detail: text("detail"),
  proposalId: text("proposal_id"),
  /** Dedupe key so a poll that sees the same event twice writes one row. */
  eventKey: text("event_key").unique(),
  /** On-chain transaction hash and Safe transaction hash, when the event has them. */
  txHash: text("tx_hash"),
  safeTxHash: text("safe_tx_hash"),
}, (t) => [index("activity_safe_idx").on(t.safeId, t.at)]);

export const snapshots = pgTable("snapshots", {
  id: serial("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  loanId: text("loan_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  health: text("health").notNull(),
  price: text("price"),
  debt: text("debt").notNull(),
  collateral: text("collateral").notNull(),
  /** The lender's variable borrow rate per year (0..1) when the snapshot was taken; null when it could not be read. */
  rate: text("rate"),
}, (t) => [index("snapshots_loan_idx").on(t.loanId, t.at)]);

/** The one live plan draft per Safe (OC-04). */
export const planDrafts = pgTable("plan_drafts", {
  safeId: integer("safe_id").primaryKey().references(() => safes.id),
  draft: jsonb("draft").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workerLocks = pgTable("worker_locks", {
  job: text("job").primaryKey(),
  lockedBy: text("locked_by").notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
});

export const workerTicks = pgTable("worker_ticks", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  workerId: text("worker_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  ok: boolean("ok").notNull(),
  error: text("error"),
}, (t) => [index("worker_ticks_job_idx").on(t.job, t.startedAt)]);

export const operatorAlerts = pgTable("operator_alerts", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// BP-31 deposits
/** Last balance the deposit job saw per (Safe, network, asset), raw token units. A rise over it is a deposit. */
export const depositBalances = pgTable("deposit_balances", {
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  asset: text("asset").notNull(),
  raw: text("raw").notNull(),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.safeId, t.chainId, t.asset] })]);

/** One row per observed rise of a balance. `announcedAt` is set once the Activity row and chat message are written. */
export const deposits = pgTable("deposits", {
  id: serial("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  asset: text("asset").notNull(),
  /** The rise, raw token units. */
  raw: text("raw").notNull(),
  amount: text("amount").notNull(),
  valueUsd: text("value_usd").notNull(),
  blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  announcedAt: timestamp("announced_at", { withTimezone: true }),
}, (t) => [index("deposits_safe_idx").on(t.safeId, t.detectedAt)]);
// E4 monitor and alerts
/** One loan's alert levels (BP-19). No row means the defaults (DEFAULT_LEVELS: Watch 1.45, At-risk 1.25). */
export const loanLevels = pgTable("loan_levels", {
  safeId: integer("safe_id").notNull().references(() => safes.id),
  loanId: text("loan_id").notNull(),
  chainId: integer("chain_id").notNull(),
  warn: doublePrecision("warn").notNull(),
  act: doublePrecision("act").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.safeId, t.loanId] })]);

/** What the last monitor tick did for one (Safe, network) (BP-18): drives "Watching n loans" and the dashboard's last check. */
export const monitorStatus = pgTable("monitor_status", {
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }).notNull(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  /** Null after a successful check. */
  lastError: text("last_error"),
  /** Data source, e.g. "Aave v3 on Base". */
  source: text("source").notNull(),
  loanCount: integer("loan_count").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.safeId, t.chainId] })]);
// E7 create Safe
/** How a Safe was created in the app: the creator wallet, the salt index (salt = f(creator, index)) and their consent signature. The setup itself is `safes.setup`. */
export const safeCreations = pgTable("safe_creations", {
  safeId: integer("safe_id").primaryKey().references(() => safes.id),
  creator: text("creator").notNull(),
  saltIndex: integer("salt_index").notNull(),
  /** personal_sign over the setup summary; proves the creator approved this exact setup. Not a key. */
  consentSignature: text("consent_signature").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("safe_creations_creator_idx").on(t.creator, t.saltIndex)]);

/** One sponsored deployment per (Safe, network). The row is the idempotency guard and the budget ledger. */
export const relayerDeployments = pgTable("relayer_deployments", {
  id: serial("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  /** Null while the transaction is being sent. */
  txHash: text("tx_hash"),
  /** The creator wallet (lowercase): the per-wallet sponsorship limit counts by this. */
  creator: text("creator").notNull().default(""),
  /** Estimated cost in wei, reserved with the claim; `costWei` replaces it once the receipt is known. */
  estimatedWei: numeric("estimated_wei", { precision: 78, scale: 0 }).notNull().default("0"),
  costWei: numeric("cost_wei", { precision: 78, scale: 0 }),
  /** A claim is held until this time; after it, a crashed attempt can be reconciled or resumed. */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("relayer_deployments_safe_chain_idx").on(t.safeId, t.chainId), index("relayer_deployments_day_idx").on(t.createdAt), index("relayer_deployments_creator_idx").on(t.creator)]);
// BP-20/21 alerts
/** One alert per crossing of a loan's At-risk level (BP-20). Written before it is delivered; `chatPostedAt` is set once the chat message exists. */
export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  loanId: text("loan_id").notNull(),
  /** Health factor at the crossing, and the owner's levels then. */
  hf: doublePrecision("hf").notNull(),
  warn: doublePrecision("warn").notNull(),
  act: doublePrecision("act").notNull(),
  price: doublePrecision("price"),
  /** Cause from stored snapshots ("ETH fell 6% in 4h."); null when the snapshots show none. */
  cause: text("cause"),
  /** The loan as it was at the crossing (`Loan` from `@/lib/types`); null when the position has several assets. */
  snap: jsonb("snap"),
  addColl: doublePrecision("add_coll"),
  repay: doublePrecision("repay"),
  /** Set when health is back at the Watch level. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  chatPostedAt: timestamp("chat_posted_at", { withTimezone: true }),
  /** Set once the owners to email were read and their delivery rows written. */
  emailPlannedAt: timestamp("email_planned_at", { withTimezone: true }),
  eventKey: text("event_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("alerts_loan_idx").on(t.safeId, t.loanId, t.id)]);

/** Whether a loan is below its At-risk level and has not yet recovered to Watch: the guard that gives one alert per crossing. */
export const alertState = pgTable("alert_state", {
  safeId: integer("safe_id").notNull().references(() => safes.id),
  loanId: text("loan_id").notNull(),
  crossed: boolean("crossed").notNull(),
  /** Set once the Watch chat message was posted (or the loan fell straight below At-risk); cleared when health is back above Watch by a margin. */
  belowWatch: boolean("below_watch").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.safeId, t.loanId] })]);

/** Email delivery of one alert to one owner (BP-21). `key` is the per-alert idempotency key handed to the provider. */
export const alertDeliveries = pgTable("alert_deliveries", {
  id: serial("id").primaryKey(),
  alertId: integer("alert_id").notNull().references(() => alerts.id),
  userId: integer("user_id").notNull().references(() => users.id),
  key: text("key").notNull().unique(),
  /** pending, sent, or failed (gave up). */
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

/** Per owner: alert emails on or off, and the secret in their unsubscribe link. No row means on. */
export const emailPrefs = pgTable("email_prefs", {
  userId: integer("user_id").primaryKey().references(() => users.id),
  enabled: boolean("enabled").notNull().default(true),
  unsubscribeToken: text("unsubscribe_token").notNull().unique(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// BP-22/23 fixes
/** A fix the owner picked for an at-risk loan (BP-22). One live draft per loan: a newer one marks the older "replaced". `proposalId` is set once it was sent to the Safe. */
export const fixDrafts = pgTable("fix_drafts", {
  id: text("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  loanId: text("loan_id").notNull(),
  /** "coll" | "repay" | "both" (`alertOptions`). */
  option: text("option").notNull(),
  /** The typed protect `Spec`. */
  spec: jsonb("spec").notNull(),
  title: text("title").notNull(),
  steps: jsonb("steps").$type<string[]>().notNull(),
  healthBefore: doublePrecision("health_before"),
  healthAfter: doublePrecision("health_after"),
  /** The test run's sentence and verdict, as shown on the card. */
  testRunLine: text("test_run_line").notNull(),
  canSend: boolean("can_send").notNull(),
  /** At-risk when drafted: proposed at the Safe's current nonce (D-10). */
  urgent: boolean("urgent").notNull().default(false),
  /** "draft" | "replaced" | "sent". */
  state: text("state").notNull().default("draft"),
  proposalId: text("proposal_id"),
  createdAt: createdAt(),
}, (t) => [index("fix_drafts_loan_idx").on(t.safeId, t.loanId, t.state)]);

// BP-25 rules
/** A standing rule (BP-25): the fix the owner pre-chose for a loan. One per loan. `createdBy` is the owner who last set it; the rule acts on their behalf and only while they still own the Safe (G4). */
export const standingRules = pgTable("standing_rules", {
  id: serial("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  loanId: text("loan_id").notNull(),
  /** "coll" | "repay" | "both" (`alertOptions`). */
  option: text("option").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("standing_rules_loan_idx").on(t.safeId, t.loanId)]);

/** What the rule did at one alert; the unique alert id makes the run happen once. `outcome`: "running" | "drafted" | "nothing". */
export const ruleRuns = pgTable("rule_runs", {
  id: serial("id").primaryKey(),
  alertId: integer("alert_id").notNull().references(() => alerts.id).unique(),
  outcome: text("outcome").notNull(),
  /** The sentence the alert card and chat message show. */
  line: text("line").notNull(),
  /** The fix draft the rule made; the owner sends it with the fix card. */
  draftId: text("draft_id"),
  createdAt: createdAt(),
});

// E9 moves
/** A move of collateral to another network (BP-36 to BP-38): the aggregator quote it was drafted from, the proposal that carries it, and what the bridge reported. Amounts are raw token units as strings. */
export const moves = pgTable("moves", {
  id: text("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  fromChain: integer("from_chain").notNull(),
  toChain: integer("to_chain").notNull(),
  asset: text("asset").notNull(),
  /** "quoted" (drafted), "queued" (in the Safe queue), "bridging" (executed on the source), "arrived", "partial", "refunded", "failed", "expired" (Out of date), "closed" (rejected or replaced). */
  status: text("status").notNull(),
  /** The aggregator quote (`AggregatorQuote`, bigints as strings): its transaction, minimum received and route. */
  quote: jsonb("quote").notNull(),
  /** The plan the move was drafted for (`Spec` kind "move"): the move row and the loan drafted on arrival. */
  spec: jsonb("spec").notNull(),
  proposalId: text("proposal_id"),
  sourceTxHash: text("source_tx_hash"),
  destTxHash: text("dest_tx_hash"),
  quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull(),
  /** Good until (D-13): 15 minutes after the quote unless the route is known to last longer. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Set once the arrival or the failure was told in chat. */
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  delayedAt: timestamp("delayed_at", { withTimezone: true }),
  receivedRaw: text("received_raw"),
  /** How much of `receivedRaw` (or, before arrival, the expected amount) the deposit job already attributed to this move. */
  attributedRaw: text("attributed_raw").notNull().default("0"),
  detail: text("detail"),
  replacedBy: text("replaced_by"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("moves_safe_idx").on(t.safeId, t.status), index("moves_proposal_idx").on(t.proposalId)]);
// E10 reserve
/**
 * The Reserve Safe linked to a main Safe on one network (BP-39). What the chain enforces (limit, role,
 * scope) is read back from the Roles modifier; this row keeps only what the chain cannot hold: the
 * off-chain trigger (D-02), the addresses and salt of the setup, and where to start reading logs.
 * `state`: "pending" until the setup transaction is seen on-chain, then "linked".
 */
export const reserveLinks = pgTable("reserve_links", {
  id: serial("id").primaryKey(),
  mainSafeId: integer("main_safe_id").notNull().references(() => safes.id),
  reserveSafeId: integer("reserve_safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  /** The Roles v2 modifier proxy, predicted before it exists. Lowercased. */
  rolesAddress: text("roles_address").notNull(),
  /** The executor key's address (the Reserve executor Signer, never the proposer). Lowercased. */
  executorAddress: text("executor_address").notNull(),
  saltNonce: text("salt_nonce").notNull(),
  attempt: integer("attempt").notNull().default(0),
  /** Daily limit in raw USDC units the owners were shown; the chain value is read back and wins. */
  dailyLimit: text("daily_limit").notNull(),
  /** Off-chain trigger: the agent repays when health is below this (1.02 to 2.00). */
  triggerHf: doublePrecision("trigger_hf").notNull(),
  setupProposalId: text("setup_proposal_id"),
  /** Block at link time: the modifier cannot exist before it, so logs are read from here. */
  fromBlock: bigint("from_block", { mode: "bigint" }).notNull(),
  state: text("state").notNull().default("pending"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("reserve_links_main_idx").on(t.mainSafeId, t.chainId)]);
// E10 reserve executor
/**
 * One executor attempt for one loan in one tick. `key` makes a retried tick write one row.
 * `status`: pending, done, failed. A pending run with a lease and no transaction fields is an
 * unsigned claim. Signing commits the transaction fields together while the lease is still set.
 * Submission intent records the final authorization before the first network call. Recovery
 * relays the same bytes and settles only from a receipt for the exact hash.
 */
export const reserveRuns = pgTable("reserve_runs", {
  id: serial("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  loanId: text("loan_id").notNull(),
  key: text("key").notNull().unique(),
  status: text("status").notNull(),
  /** The amount requested from the role, in raw token units (what the allowance is charged). */
  requestedRaw: text("requested_raw").notNull(),
  /** What left the Reserve Safe, from the balance read after the receipt. */
  paidRaw: text("paid_raw"),
  txHash: text("tx_hash"),
  /** The raw signed EIP-1559 transaction, committed at handoff before it can reach an RPC. */
  signedTx: text("signed_tx"),
  /** The executor EOA nonce the signed transaction claims; allocates and the nonce-consumed check. */
  nonce: bigint("nonce", { mode: "number" }),
  /** The executor key that signed the transaction. Lowercased. */
  executorAddress: text("executor_address"),
  /**
   * The link generation the call was prepared under: `attempt|reserveSafe|roles|executor` of the
   * link row at claim time, lowercased. The gate recomputes it under the row lock and refuses the
   * handoff and the intent when it no longer matches. An already-committed intent keeps its original data.
   */
  linkFingerprint: text("link_fingerprint"),
  /** For origin "now": the wallet that asked, lowercased; re-checked as an owner of both Safes in the gate. */
  authorizedBy: text("authorized_by"),
  /** Final authorization and irrevocable submission intent, committed before a network send. */
  broadcastAt: timestamp("broadcast_at", { withTimezone: true }),
  /** Fences an unsigned claim. A signed handoff retains its lease until intent. */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  hfBefore: doublePrecision("hf_before").notNull(),
  hfAfter: doublePrecision("hf_after"),
  allowanceLeftRaw: text("allowance_left_raw"),
  balanceLeftRaw: text("balance_left_raw"),
  /** "now" for a "Use reserve now" press, else "auto". */
  origin: text("origin").notNull().default("auto"),
  error: text("error"),
  /** The fix draft that holds the rest the reserve could not cover. */
  restDraftId: text("rest_draft_id"),
  emailPlannedAt: timestamp("email_planned_at", { withTimezone: true }),
  /** Failed email rounds so far; the next one waits `emailNextAt` (the alerts' backoff). */
  emailAttempts: integer("email_attempts").notNull().default(0),
  emailNextAt: timestamp("email_next_at", { withTimezone: true }),
  /** Owners (user ids) already emailed for this run: a retry never sends to them again. */
  emailSentTo: jsonb("email_sent_to").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
}, (t) => [index("reserve_runs_loan_idx").on(t.safeId, t.loanId, t.id)]);

/** A policy change or turn-off waiting for the Reserve Safe's owners (BP-43). `status`: pending, applied. */
export const reservePolicyChanges = pgTable("reserve_policy_changes", {
  id: text("id").primaryKey(),
  safeId: integer("safe_id").notNull().references(() => safes.id),
  chainId: integer("chain_id").notNull(),
  /** "off" | "policy". */
  kind: text("kind").notNull(),
  newTrigger: doublePrecision("new_trigger"),
  /** New daily limit in raw token units; null when only the trigger changes. */
  newLimitRaw: text("new_limit_raw"),
  /** The Reserve Safe transaction the owners sign, and its hash. */
  tx: jsonb("tx").notNull(),
  safeTxHash: text("safe_tx_hash").notNull(),
  /** The policy when it was asked for: what the Activity row says it changed from. */
  prevTrigger: doublePrecision("prev_trigger").notNull().default(0),
  prevLimitRaw: text("prev_limit_raw").notNull().default("0"),
  /** The Reserve Safe's block when it was asked for: where to look for the execution event. */
  fromBlock: text("from_block").notNull().default("0"),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by"),
  createdAt: createdAt(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [index("reserve_policy_changes_safe_idx").on(t.safeId, t.chainId, t.status)]);
