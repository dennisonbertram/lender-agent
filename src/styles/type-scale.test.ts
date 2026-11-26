import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../components", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : [],
  );
const all = files(root);

describe("type scale", () => {
  it("has no arbitrary text sizes", () => {
    expect(all.filter((f) => /text-\[\d/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("has no chart font below 12", () => {
    expect(all.filter((f) => /fontSize:\s*(?:[0-9]|1[01])\b/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("styles links as text-link underlined", () => {
    const line = readFileSync(join(root, "ui/button.tsx"), "utf8").match(/^\s*link:\s*"([^"]*)"/m)?.[1] ?? "";
    expect(line).toContain("text-link");
    expect(line).toContain("underline");
  });
});
