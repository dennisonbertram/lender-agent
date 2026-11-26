# Local setup and operations

This runbook describes the current code in `apps/web`. Commands assume the repository root as the working directory. The project pins pnpm 10.0.0 and CI uses Node.js 24. Use those versions for a matching local environment.

## Install and run the mock

```sh
pnpm install --frozen-lockfile
pnpm mock dev
```

Open <http://localhost:3000>. The wrapper sets mock mode, clears inherited database, model, email, fork, and signer credentials, sends configured RPC and Safe service URLs to a closed local port, and binds the server to loopback before Next.js loads `.env*` files. Mock mode uses in-memory PGlite, fixture chain state, fake Safe services, scripted chat, and local email recording without editing `.env.local`. In mock signer paths, empty key overrides fall back to bundled public Anvil test keys; nonempty invalid keys are still refused. The dedicated local-demo entrypoint selects a deterministic bundled test wallet through its own wagmi connector and does not modify or select a browser extension. It points chain read transports at a closed local port and disables wallet-to-Safe transfers; the app does not simulate those transfers. Other mock proposal actions use fixture behavior and do not represent live transactions. Never fund or use the public Anvil keys on a live network. Keep the mock wrapper out of production builds; `NEXT_PUBLIC_MOCK_WALLET` is compiled into the browser bundle.

The `pnpm mock` wrapper deliberately forces an in-memory database. Its state resets when the server restarts; it does not persist the mock chain or fake Safe service state either.

The original Vite demo is a separate frontend and uses sample data without network or wallet access:

```sh
pnpm demo:dev
```

## Environment configuration

Do not commit real credentials. Use a secret manager or untracked local environment file. Names below are listed only; never paste credential values into documentation or issue reports.

### Required to use real backend features

There is no single set of settings that enables every real feature. For the web app to use a real database and chain-backed services, configure:

| Variable | Required behavior |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection used for queries whenever set, including with raw `MOCK=1`; mock mode does not isolate or replace this database, and first use can apply migrations and write worker state. Required in production when `MOCK` is not `1`; production refuses the PGlite fallback. |
| `RPC_URL_8453`, `RPC_URL_42161` | Optional by code because viem has public defaults, but recommended for private and reliable RPC access on both served lending networks: Base (8453) and Arbitrum (42161). |
| `ANTHROPIC_API_KEY` | Required for real-model chat. `LLM_PROVIDER` defaults to `anthropic`; `LLM_MODEL` defaults in code. Without a key, chat reports that it is not configured. |
| `PROPOSER_SIGNER=key`, `PROPOSER_PRIVATE_KEY` | Configure both for real proposer signing. The `key` signer signs stored proposals; its key is server-side, not an owner key. Protect it as a signing secret. The default `dev` signer requires `DEV_PROPOSER_KEY` (Anvil keys only); `kms` is a stub. |
| `CRON_SECRET` | Required to authorize `GET /api/cron/worker`; without it the route returns 401. |

Safe Transaction Service URLs default to the official endpoints for supported chain IDs. `SAFE_TX_SERVICE_URL_<chainId>` can override a URL, and `SAFE_API_KEY` adds a bearer token if the chosen service requires one. Queries use `DATABASE_URL`. If that URL uses transaction pooling, set `DATABASE_URL_UNPOOLED` to a direct or session-pooled PostgreSQL URL for migrations. The migration client holds a session advisory lock until it closes the same connection; a transaction pooler cannot guarantee that session affinity. If `DATABASE_URL_UNPOOLED` is unset, migrations use `DATABASE_URL`, which must preserve session-level locks.

### Optional or feature-specific settings

| Variable | Use |
| --- | --- |
| `MOCK=1` | Enables fixture chain and Safe services, scripted chat, and mock signer defaults. It does not select or isolate the database: if `DATABASE_URL` is set, the app uses that PostgreSQL database and may migrate or write worker state. Use `pnpm mock dev` for an isolated local demo; its wrapper clears database URLs and forces in-memory PGlite. Keep raw `MOCK` unset for real-service mode. |
| `NEXT_PUBLIC_MOCK_WALLET=1` | Enables the public development wallet bundle; the wallet is installed only when no browser extension exists. Set only for local mock use, and keep unset in production builds. |
| `PGLITE_DIR` | Local PGlite data directory when no `DATABASE_URL` is set. The `pnpm mock` wrapper forces in-memory PGlite regardless of this setting. |
| `DATABASE_URL_UNPOOLED` | Direct PostgreSQL URL for migrations, useful when `DATABASE_URL` is pooled. If absent, migrations use `DATABASE_URL`. |
| `RPC_URL_<chainId>` | RPC endpoint for an individual supported chain. Comma-separated URLs may be provided where the client supports fallback URLs. |
| `RPC_URL_1`, `RPC_URL_10`, `RPC_URL_137`, `RPC_URL_100` | Optional RPC overrides for Ethereum, Optimism, Polygon, and Gnosis respectively. Safe setup supports these networks, but lending is not served there. |
| `RPC_URL_84532` | Optional Base Sepolia RPC override for development/check flows only. Base Sepolia is not available in the Safe setup picker or for lending. |
| `SAFE_TX_SERVICE_URL_<chainId>` | Transaction Service endpoint override for a supported chain. |
| `SAFE_API_KEY` | Optional bearer token for the Safe Transaction Service. |
| `LLM_PROVIDER`, `LLM_MODEL` | Provider/model selection. Only `anthropic` is implemented. |
| `MOCK_LLM=anthropic` | Optional only with `MOCK=1` and `ANTHROPIC_API_KEY`; makes mock chain/Safe flows use the real Anthropic model. This sends chat context to Anthropic and may incur usage charges. Leave unset for the scripted, offline mock. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Both are needed to send alert email through Resend. If missing or invalid, email delivery is disabled. |
| `PRIVACY_EMAIL` | Optional valid email address shown on the hosted Privacy Policy page for privacy questions. If unset or invalid, the page asks users to contact the operator privately. |
| `APP_URL` | Base URL used to construct alert email links; defaults to `http://localhost:3000`. |
| `LIFI_API_KEY` | Optional LI.FI quote API key for cross-network moves. |
| `RELAYER`, `DEV_RELAYER_KEY` | Development relayer selection: `RELAYER=dev` plus a key enables relayer-sponsored Safe deployment; otherwise the relayer is a refusing stub. Use only with local development chains. The relayer code does not restrict the key to Anvil keys, so never point it at a public network. |
| `EXECUTOR_SIGNER`, `DEV_EXECUTOR_KEY` | Reserve transaction executor selection. `dev` accepts Anvil keys only; `kms` is a stub. The executor key must differ from the proposer key. Do not configure the dev signer for real funds. |
| `SPONSOR_PER_SAFE`, `SPONSOR_PER_CREATOR`, `SPONSOR_DAILY`, `SPONSOR_MAX_COST_WEI`, `SPONSOR_DAILY_SPEND_WEI` | Safe creation sponsorship budget overrides. Setting any of the three count limits to `0` disables sponsorship. Zero cost limits reject deployments with positive gas cost. These do not configure a relayer. |
| `RESERVE_RECEIPT_TIMEOUT_MS`, `WORKER_STALL_LIMIT_MS`, `MONITOR_INTERVAL_MS`, `PROPOSAL_POLL_MS`, `MOVES_POLL_MS`, `DEPOSIT_POLL_MS`, `RELAYER_BALANCE_INTERVAL_MS` | Operational timing controls with defaults in code. Set only after reviewing the relevant worker behavior. |
| `FORK=1`, `FORK_SAFES` | Local Anvil fork development mode, not production. Requires `RPC_URL_8453` to point only to a localhost Anvil instance. Refused in production and incompatible with `MOCK=1`. |
| `FORK_RPC_URL_<chainId>` | RPC overrides used by fork scripts/tests. Not an app production setting. |
| `NEXT_PUBLIC_FORK_RPC_URL` | Browser-side fork wallet configuration for fork development. |

`SESSION_SECRET` is not read by the current session implementation. Do not set it expecting it to sign sessions.

## Configure a real backend safely

1. Start with a dedicated non-production database and RPC access for Base and Arbitrum. Keep `MOCK` and `NEXT_PUBLIC_MOCK_WALLET` unset. Do not use public development keys or real user wallets for initial setup.
2. Configure `DATABASE_URL`. If it uses transaction pooling, set `DATABASE_URL_UNPOOLED` to a direct or session-pooled connection for migrations. Configure `RPC_URL_8453` and `RPC_URL_42161`, the required model key, and a strong `CRON_SECRET`. Add Safe Transaction Service overrides or API credentials only if your service requires them. The app can fall back to public RPC defaults, but this is not recommended for a hosted service.
3. Safe setup can be sponsored when a relayer and budget are configured. Without sponsorship (the default real-mode configuration), the app asks the connected Safe creator's wallet to submit the deployment transaction and pay network gas; this path is implemented. The default relayer is a refusing stub. `RELAYER=dev` provides only a development sender and should not be used to sponsor public-network deployments.
4. Do not enable reserve execution with a real key: the production KMS signer is also a stub. The dev executor only permits known Anvil keys. Keep Reserve execution unavailable until a production signer is implemented and reviewed.
5. Keep proposer signing distinct from user/owner wallets. The proposer key signs only stored proposals and is not an owner key. Users still review and approve Safe transactions with their own Safe owners; never put owner wallet secrets on the server.
6. Configure exactly one worker mode (below), then build and start the app. Review the environment, database target, RPC target, and transaction signing configuration before accepting user traffic.

Lending is served on Base (8453) and Arbitrum (42161). Safe creation supports six networks; Safe setup support on a network does not make lending available there. Base Sepolia is limited to development/check flows and is not offered for Safe setup or lending.

## Database migrations and reset boundaries

Migrations are applied automatically on the first database use by the app or worker. With `DATABASE_URL`, the app takes a PostgreSQL session advisory lock and applies the checked-in Drizzle migrations using `DATABASE_URL_UNPOOLED` when supplied, otherwise `DATABASE_URL`. The migration connection closes to release the lock. Queries use `DATABASE_URL`. Use a direct or session-pooled URL for migrations; a transaction-pooled URL does not preserve the required session. With no URL outside production, the app creates PGlite and applies the same migrations; in production, real mode errors instead of silently using PGlite.

There is no separate `db:migrate` command in the package scripts. Review migration files in `apps/web/drizzle/` before deploying a schema change and back up the target database using your database provider's supported process. Do not use the mock reset endpoint against real data.

`POST /api/mock/reset` and `POST /api/mock/safe-wallet` exist only with `MOCK=1`; they return not found in other modes. Reset replaces the current in-process mock world and is intended for local/E2E use; it does not drop or reset PostgreSQL. However, raw `MOCK=1` with `DATABASE_URL` still uses that database and can write worker state there. Use `pnpm mock dev` for the isolated demo: it clears database URLs and forces in-memory PGlite, so restarting it starts with a fresh database. A direct PGlite setup with `PGLITE_DIR` can persist data; inspect and preserve that directory before cleanup because removing it destroys its contents.

## Build and serve

From the repository root:

```sh
pnpm build
pnpm start
```

`pnpm start` serves the previously built Next.js app on port 3000 by default. Keep the same runtime environment at build/start where required by Next.js public variables. For a local mock preview, use the wrapper for both commands:

```sh
pnpm mock build
pnpm mock start
```

## Release and worker operation

The GitHub Actions workflow `.github/workflows/ci.yml` runs on pushes and pull requests to this public repository. It installs dependencies, runs typecheck, the Postgres lock test, tests, and a build; it does not deploy. Merging this repository or a fork does not deploy the hosted service. The operator-managed production release is separate: the Vercel project uses root directory `apps/web` and its configured Git source. For an operator release, merge the reviewed, passing change through that configured source, then verify the Vercel production deployment is **Ready** for the exact merge commit and check the public site. `apps/web/vercel.json` supplies the per-minute worker schedule; it is not a deploy workflow. Per-minute cron frequency requires a Vercel plan that supports once-per-minute schedules; confirm current [Vercel Cron Job usage limits](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing) before choosing this mode. If the plan does not support that cadence, operate `pnpm worker` as a standalone process instead. Do not start a separate deployment as part of this release path.

Choose one worker model per deployment:

- **Scheduled route:** the included `apps/web/vercel.json` schedules `GET /api/cron/worker` once per minute. Configure `CRON_SECRET` in the hosting environment and send `Authorization: Bearer <configured-secret>`. The route returns 401 if missing or incorrect. With `MOCK=1` it returns 404. Per-job database locks prevent overlap.
- **Standalone process:** run `pnpm worker` alongside the web app with the same database and service environment. It starts a long-running loop and handles SIGINT/SIGTERM for graceful shutdown. Do not run this and the scheduled route for the same jobs unless you intentionally operate both and understand their shared locking and load.
- **In-process real worker:** `WORKER_IN_PROCESS=1` starts the worker inside the web process in real mode. Use this only when the hosting runtime keeps the process alive; otherwise use a scheduled route or standalone worker. `MOCK=1` starts it in-process automatically.

With mock mode, the worker is started inside the web server through instrumentation. A separate `MOCK=1 pnpm worker` process has its own fixture state and is not useful for the web server's mock world.

## Operational checks

- `GET /api/worker-status` returns `watching` and the last successful monitor tick. A false `watching` value records an unresolved `worker_stalled` operator alert; a later successful tick resolves it.
- Check application logs for startup/database migration failures, RPC errors, worker job results, and failed model/email calls. Avoid logging secrets or signed transaction bytes.
- Confirm the selected database and RPC endpoints belong to the intended environment before running any operation that could submit a transaction.
- Treat a proposal in the Safe Transaction Service as pending until the required Safe owners have approved and the chain confirms execution. A successful API response alone does not prove on-chain completion.
- Email is disabled unless both Resend configuration values are usable. The model is unavailable in real mode without an Anthropic API key.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| App fails at startup with missing `DATABASE_URL` in production | Configure PostgreSQL. Real production mode intentionally does not fall back to PGlite. |
| Migration connection fails with a pooler/DDL error | Set `DATABASE_URL_UNPOOLED` to the direct connection URL and confirm it reaches the same database as `DATABASE_URL`. |
| Chat says the model is not configured | In real mode, set `ANTHROPIC_API_KEY`; `LLM_PROVIDER` must be `anthropic`. In mock mode, unset `MOCK_LLM=anthropic` unless explicitly testing the real model. |
| `/api/cron/worker` returns 401 | Set the host's `CRON_SECRET` and send the exact `Bearer` authorization value. |
| Worker status says it is not watching | Check worker/cron logs, database connectivity, and successful `monitor` ticks. Check the resulting operator alert. |
| Safe creation is not sponsored | This is expected in the default real-mode configuration. The connected creator wallet submits and pays for setup; no relayer key is needed for this path. |
| Reserve action says signer is not configured | Expected for `kms` today. Production Reserve signing is not implemented. |
| Fork mode refuses startup | Use `FORK=1` only in development with `RPC_URL_8453` set to localhost Anvil; remove `MOCK=1`. |
| Mock wallet is not present | Start a development server or build with `NEXT_PUBLIC_MOCK_WALLET=1`. It is compiled into the browser bundle, so rebuild after changing it. An already installed browser wallet is retained. |

## Other checks

```sh
pnpm typecheck
pnpm test
```

The web-app focused checks are available as `pnpm --filter @ai-loan-agent/web typecheck` and `pnpm --filter @ai-loan-agent/web test`. Use the repository's CI or designated test machine for full test/build execution; this runbook is not evidence that a deployment is healthy.
