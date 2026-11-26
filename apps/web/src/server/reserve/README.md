# Reserve Safe (E10: BP-39 link and sign the policy, BP-40 status; BP-41/42/52 the durable executor)

Decisions: D-01 (a) the Reserve may only repay the main Safe's Aave v3 USDC debt on Base, within a daily
allowance; D-02 (a) the trigger (health below N) is decided off-chain, the chain enforces target, function,
asset, rate mode, `onBehalfOf` and the allowance. Compound v3 is not covered (architecture 8.4).

## Verified on Base (8453), 2026-11-14, `eth_getCode` on https://mainnet.base.org
| Item | Address | Code |
| --- | --- | --- |
| Roles v2 mastercopy | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` | 24,409 bytes |
| ModuleProxyFactory | `0x000000000000aDdB49795b0f9bA5BC298cDda236` | 2,046 bytes |
| MultiSendCallOnly 1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | present |
| Aave v3 Pool / USDC | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` / `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | present |

## Files
- `constants.ts`, `roles-abi.ts`: addresses, role key `reserve-executor`, allowance key `daily-repay`, hand-written Roles v2 ABI slice.
- `build.ts`: `buildReserveSetup()` (pure; one MultiSend batch: deploy modifier, enable, assign, scope `Pool.repay`, `setAllowance`, approve Pool once), `buildRoleRepay()`, proxy address prediction.
- `read.ts`, `allowance.ts`, `status.ts`: read the policy back from the modifier's events and storage; `allowanceNow()` is the lazy refill; `reserveStatus(safe)`, `reservePolicy(safe)` (cached 10 s).
- `link.ts`: `checkReserve`, `linkReserve` (stores the setup as a proposal on the Reserve Safe and sends it through `deliver`).
- `signer.ts`: the separate reserve executor `Signer` (dev anvil key, KMS stub), signs only `execTransactionWithRole`. `prepareRoleCall` signs without sending; `sendRoleCall` composes prepare + submit for non-durable callers.
- `view.ts`: the JSON for the page, sidebar and chat header.
- `executor/`: the off-chain executor. `run.ts` claims a `reserve_runs` row and drives it; `broadcast.ts` is the durable broadcast protocol; `chain.ts`/`fixture-chain.ts` are the chain seam (real viem / MOCK stand-in); `store.ts` owns the link row lock and the link-generation fingerprint; `use-now.ts` is "Use reserve now".

## The durable broadcast protocol (BP-52)

A `reserve_runs` row is the unit of recovery. A pending row is handled according to its evidence.

- **Unsigned claim.** A lease exists and there is no signed transaction, hash, nonce, executor address,
  or handoff time. Recovery can take over an expired lease by replacing its exact value. Handoff,
  failure and deletion also require the exact lease, so an older worker cannot change the run.
  Recovery fails an expired unsigned claim older than `CLAIM_DEAD_MS` (30 minutes).
- **Signed handoff.** The signed transaction, deterministic hash, nonce and executor address commit
  together. The row still has a lease and `broadcast_at` is null. Only this state proves the app had
  signed without entering submission.
- **Submission intent.** Under the link lock, the app checks the current link generation, role
  membership, position, allowance and balance. For a manual run it also checks that the requesting
  wallet still owns both Safes. A refusal releases the nonce and discards the signed transaction.
  Committing `broadcast_at` is the point of no return. After that commit, the first sender and
  recovery workers relay only the same signed bytes. A later owner, position or link change cannot
  cancel that commit or strand the nonce. The role and allowance still apply on-chain. Revocation
  can make the transaction revert, and a mined revert consumes its nonce.
- **Legacy or incomplete evidence.** An available hash is checked for its receipt. If the sender or
  nonce is missing, recovery verifies both against the exact mined transaction and records them when
  settling the run. An unresolved row without a known sender blocks fresh allocations on that chain.
  A row with no lease or hash stays pending for operator review because a pre-migration worker may
  already have sent a transaction.

Preparation, intent and sending each lock the same link row. Preparation also locks the exact
unsigned claim and allocates the nonce under a transaction-scoped advisory lock on the chain and
executor. Each executor holds one unresolved reservation. A second reserve waits until the first
settles or releases its nonce. The next allocation uses the greater of the pending RPC nonce and
one above the executor's highest locally recorded mined nonce. Sending requires no signing key or
policy reads. The send transaction locks the pending run and checks the exact stored bytes and
committed intent. Receipt waiting occurs after this short transaction.

Turn-off checks pending runs under the link lock. It can discard a signed handoff while
`broadcast_at` is still null. It returns HTTP 409 while an intent is pending or a legacy
broadcast is unresolved, and the owner can retry after settlement. A successful turn-off prevents
any further submission under that link.

Success or revert requires a receipt whose transaction hash matches the signed handoff. Receipt
waiting disables automatic replacement detection. After the receipt-lookup grace period, if the
stored executor's nonce has advanced at a finalized block, recovery rechecks the original receipt.
An advanced nonce alone cannot prove which transaction used it. A missing or different receipt
leaves the run pending and raises an operator alert.

### Pending runs that need operator review

Use the run ID, chain, hash, executor address and nonce when investigating. For a legacy run without
a hash, use the loan, reserve and original attempt's chain history to locate the transaction. Confirm
its outcome from chain evidence and record the sender and nonce when settling a mined run. If a
finalized nonce has advanced and the original hash has no receipt, locate the transaction by the stored
executor and nonce in finalized chain history. Verify its sender, nonce, recipient, value, calldata and receipt.
A different transaction can only be treated as the intended repayment if those facts prove it.
Keep an unresolved row pending while its outcome is uncertain. Keep signed transaction bytes out of
logs and support communications.

Drain older reserve workers before deploying this protocol to an environment where signing is enabled.
Resolve pending rows from versions that used `broadcast_at` for signing before final authorization.
Those rows cannot establish that the final authorization check passed.

The role has no `approve`, no token target, no send and no delegatecall; the approval to the Pool is signed once by the owners in the same batch.
