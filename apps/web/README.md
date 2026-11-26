# Web app and worker

The Next.js application, API routes, database integration, and worker live here. Repository-wide setup and operational instructions are in [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md). The root [`README.md`](../../README.md) describes the product and distinguishes the app from the retained Vite mockup.

The mock path is for local exploration only. It uses fixture balances and chain state, fake Safe services, scripted chat, and Anvil development keys. The `pnpm mock` wrapper clears inherited credentials and points configured RPC and Safe service URLs at a closed local port. The dedicated local-demo entrypoint selects a synthetic wagmi provider without changing `window.ethereum`; wallet-to-Safe transfers are unavailable because the demo does not simulate them. Do not use it to assess real prices, submit real transactions, or configure production credentials.

Common commands from the repository root:

```sh
pnpm mock dev
pnpm --filter @ai-loan-agent/web typecheck
pnpm --filter @ai-loan-agent/web test
pnpm build
pnpm start
pnpm worker
```

Read [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md) for required versus optional environment settings, migration behavior, worker choices, operational checks, and reset boundaries. Deeper implementation notes remain in the nearby subsystem documentation, including [`src/server/reserve/README.md`](src/server/reserve/README.md).
