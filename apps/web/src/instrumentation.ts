// Next calls `register()` once when the server starts. With MOCK=1 the fixture chain and the fake
// Safe service live in this process's memory, so a separate `pnpm worker` would see an empty world:
// run the worker loop inside the web server instead (also with WORKER_IN_PROCESS=1). In real mode
// `pnpm worker` stays the separate process and nothing starts here.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MOCK !== "1" && process.env.WORKER_IN_PROCESS !== "1") return;
  const g = globalThis as { __lenderWorkerLoop?: unknown };
  if (g.__lenderWorkerLoop) return; // dev reloads call register() again
  const [{ getDb }, { getServices }, { startLoop }] = await Promise.all([import("@/server/db/client"), import("@/server/services"), import("@/worker/loop")]);
  await import("@/worker/jobs");
  const services = getServices();
  g.__lenderWorkerLoop = startLoop({ db: await getDb(), reader: services.reader, services, workerId: "in-process" });
  console.log("[worker] started in the web server process");
}
