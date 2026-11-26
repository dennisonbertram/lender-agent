// One place that spawns anvil for the fork helpers, so no path can leave an anvil or a replay server behind:
// failures during start stop both, stop() waits for anvil to exit, and anything still running when this process
// ends (test timeout, crash, Ctrl-C) is killed by the exit hooks.
import { spawn, type ChildProcess } from "node:child_process";
import { anvilBinary, type Replay } from "./fork-replay";

const running = new Set<ChildProcess>();
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  const killAll = () => { for (const p of running) { try { p.kill("SIGKILL"); } catch { /* gone */ } } };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { killAll(); process.exit(128); });
  process.on("uncaughtException", (e) => { killAll(); throw e; });
}

export type AnvilProc = { stop: () => Promise<void> };

/** Spawn anvil on `port` forking `replay`, wait until `ready()` succeeds. Throws (after cleaning up) when it cannot start. */
export async function launchAnvil(args: string[], replay: Replay, ready: () => Promise<unknown>, timeoutMs: number): Promise<AnvilProc> {
  hookExit();
  const proc = spawn(anvilBinary(), [...args, "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  running.add(proc);
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<void>((resolve) => { if (proc.exitCode !== null) resolve(); else proc.once("exit", () => resolve()); });
  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= (async () => {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
      if (proc.exitCode === null) { proc.kill("SIGKILL"); await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]); }
    }
    running.delete(proc);
    await replay.stop();
  })());
  proc.once("error", () => { void stop(); });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`anvil exited: ${stderr}`);
      try { await ready(); break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`anvil did not start: ${stderr}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { stop };
}
