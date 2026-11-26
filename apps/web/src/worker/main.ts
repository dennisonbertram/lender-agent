// Entry for `pnpm worker`. MOCK=1 uses the fixture chain reader.
import os from "node:os";
import { getDb } from "@/server/db/client";
import { getServices } from "@/server/services";
import { startLoop } from "./loop";
import "./jobs";

async function main() {
  const db = await getDb();
  // MOCK=1 state (fixture chain, fake Safe service) lives in one process: run the worker inside the
  // web server instead (src/instrumentation.ts). A separate MOCK worker sees its own empty world.
  const services = getServices();
  const reader = services.reader;
  const workerId = `${os.hostname()}-${process.pid}`;
  const loop = startLoop({ db, reader, services, workerId });
  console.log(`[worker] ${workerId} started${process.env.MOCK === "1" ? " (MOCK)" : ""}`);
  const shutdown = async () => {
    await loop.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
