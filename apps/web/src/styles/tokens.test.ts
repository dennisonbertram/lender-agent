import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

// Collect `--name: #hex` pairs per theme, in file order (later definitions win).
function theme(name: "dark" | "light"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const css of [read("./tokens.css"), read("./index.css")]) {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1];
      const hit = name === "dark" ? sel.includes(":root") || sel.includes('[data-theme="dark"]') : sel.includes('[data-theme="light"]');
      if (!hit) continue;
      for (const d of m[2].matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[d[1]] = d[2];
    }
  }
  return out;
}

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe.each(["dark", "light"] as const)("VC-04 tokens (%s)", (name) => {
  const t = theme(name);
  it("muted and secondary differ from card by at least 1.15", () => {
    expect(contrast(t["--muted"], t["--card"])).toBeGreaterThanOrEqual(1.15);
    expect(contrast(t["--secondary"], t["--card"])).toBeGreaterThanOrEqual(1.15);
  });
  it("edge reaches 3:1 on card", () => {
    expect(t["--edge"]).toBeDefined();
    expect(contrast(t["--edge"], t["--card"])).toBeGreaterThanOrEqual(3);
  });
  it("muted-foreground is readable on muted", () => {
    expect(contrast(t["--muted-foreground"], t["--muted"])).toBeGreaterThanOrEqual(4.5);
  });
});
