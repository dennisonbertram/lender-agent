import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { setDbForTests } from "@/server/db/client";
import { setServicesForTests, type Services } from "@/server/services";
import { clearJobs, registerJob } from "@/worker/jobs";
import { GET } from "./route";

const call = (auth?: string) => GET(new Request("http://x/api/cron/worker", { headers: auth ? { authorization: auth } : {} }));
const run = vi.fn(async () => {});

beforeEach(async () => {
  setDbForTests(await createTestDb());
  setServicesForTests({ reader: {} } as unknown as Services);
  clearJobs();
  registerJob({ name: "stub", intervalMs: 60_000, run });
  run.mockClear();
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("MOCK", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  setDbForTests(undefined);
  setServicesForTests(undefined);
});

describe("GET /api/cron/worker", () => {
  it("401 without the header or with the wrong secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call("s3cret")).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("401 when CRON_SECRET is unset, even for 'Bearer undefined' or 'Bearer '", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call("Bearer undefined")).status).toBe(401);
  });

  it("404 under MOCK=1", async () => {
    vi.stubEnv("MOCK", "1");
    expect((await call("Bearer s3cret")).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("200 runs due jobs once and returns names and statuses only; a call right after is skipped", async () => {
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ job: "stub", status: "ok" }] });
    expect(run).toHaveBeenCalledTimes(1);
    expect((await (await call("Bearer s3cret")).json()).results).toEqual([{ job: "stub", status: "skipped" }]);
  });

  it("a failing job reports failed without its error text", async () => {
    run.mockRejectedValueOnce(new Error("secret detail"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("Bearer s3cret");
    expect(JSON.stringify(await res.json())).toBe('{"results":[{"job":"stub","status":"failed"}]}');
  });
});
