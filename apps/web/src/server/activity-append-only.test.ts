import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !f.endsWith("append-only.test.ts") ? [p] : [];
  });
}

describe("activity is append-only", () => {
  it("has no update or delete of the activity table in src", () => {
    const bad = files(join(__dirname, "..")).filter((f) => /\b(update|delete)\(\s*activity\b/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
