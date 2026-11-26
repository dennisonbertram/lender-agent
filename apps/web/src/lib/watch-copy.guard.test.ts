import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// VC-01 AC1: the monitoring status wording lives only in lib/watch-copy.ts.
const src = join(__dirname, "..");
const PHRASES = /Not watching (this Safe|right now)|Can't check your loans|The last check failed/;
const files = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
});

describe("watch wording guard", () => {
  it("the old monitoring phrases appear only in lib/watch-copy.ts", () => {
    const hits = ["components", "app", "lib"].flatMap((d) => files(join(src, d)))
      .filter((p) => !p.endsWith(join("lib", "watch-copy.ts")) && PHRASES.test(readFileSync(p, "utf8")));
    expect(hits.map((p) => p.replace(src, ""))).toEqual([]);
  });
});
