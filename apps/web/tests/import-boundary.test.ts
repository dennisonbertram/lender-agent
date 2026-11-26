import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runtimeModuleSpecifiers, traceRuntimeImports } from "./import-boundary";

const root = "/workspace/apps/web/src";

describe("runtime import boundary", () => {
  it("follows imports, re-exports, and dynamic imports transitively", () => {
    const sources = new Map([
      [`${root}/page.tsx`, `import { view } from "./view";`],
      [`${root}/view.ts`, `export { view } from "./barrel";`],
      [`${root}/barrel.ts`, `export * from "./sample";`],
      [`${root}/sample.ts`, `export const load = () => import("../tests/fixtures/loan");`],
      ["/workspace/apps/web/tests/fixtures/loan.ts", `export const balance = 1;`],
    ]);
    const graph = traceRuntimeImports(`${root}/page.tsx`, root, (filePath) => sources.get(filePath));

    expect(graph.files).toContain(`${root}/barrel.ts`);
    expect(graph.violations.map((violation) => violation.target)).toContain("/workspace/apps/web/tests/fixtures/loan.ts");
  });

  it("detects a transitive import of root source and sample data", () => {
    const sources = new Map([
      [`${root}/page.tsx`, `export * from "./re-export";`],
      [`${root}/re-export.ts`, `export { sample } from "../../../src/data";`],
      ["/workspace/src/data.ts", `export const sample = 1;`],
    ]);
    const graph = traceRuntimeImports(`${root}/page.tsx`, root, (filePath) => sources.get(filePath));

    expect(graph.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "/workspace/src/data.ts", reason: "runtime import escapes app source" }),
    ]));
  });

  it("ignores type-only imports but includes value re-exports and dynamic imports", () => {
    expect(runtimeModuleSpecifiers(`
      import type { Safe } from "./safe-types";
      import { type Loan } from "./loan-types";
      export type { View } from "./view-types";
      export { value } from "./values";
      void import("./lazy");
    `)).toEqual(["./values", "./lazy"]);
    expect(runtimeModuleSpecifiers('const fixtures = require("../tests/fixtures/legacy-data");')).toEqual(["../tests/fixtures/legacy-data"]);
  });

  it("distinguishes a value named type and import-equals from type-only imports", () => {
    expect(runtimeModuleSpecifiers('import { type as value } from "../tests/fixtures/value";'))
      .toEqual(["../tests/fixtures/value"]);
    expect(runtimeModuleSpecifiers('export { type as value } from "../tests/fixtures/re-export";'))
      .toEqual(["../tests/fixtures/re-export"]);
    expect(runtimeModuleSpecifiers('import { type Thing } from "../tests/fixtures/types";')).toEqual([]);
    expect(runtimeModuleSpecifiers('import runtime = require("../tests/fixtures/runtime");'))
      .toEqual(["../tests/fixtures/runtime"]);
    expect(runtimeModuleSpecifiers('import type Runtime = require("../tests/fixtures/erased");')).toEqual([]);
  });

  it("rejects source imports of test files", () => {
    const sources = new Map([
      [`${root}/page.tsx`, `import { value } from "./value.test";`],
      [`${root}/value.test.ts`, `export const value = true;`],
    ]);
    const graph = traceRuntimeImports(`${root}/page.tsx`, root, (filePath) => sources.get(filePath));

    expect(graph.violations).toEqual([
      expect.objectContaining({ target: `${root}/value.test.ts`, reason: "runtime import reaches test source" }),
    ]);
  });

  it("keeps the actual Next runtime entries inside app source", () => {
    const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sourceRoot = path.join(webRoot, "src");
    const readSource = (filePath: string) =>
      existsSync(filePath) && statSync(filePath).isFile() ? readFileSync(filePath, "utf8") : undefined;
    const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(filePath);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [filePath] : [];
    });
    const entries = sourceFiles(sourceRoot);
    const graphs = entries.map((entry) => traceRuntimeImports(entry, sourceRoot, readSource));

    expect(graphs.flatMap((graph) => graph.violations)).toEqual([]);
    expect(entries).toContain(path.join(sourceRoot, "app", "page.tsx"));
    expect(entries).toContain(path.join(sourceRoot, "app", "layout.tsx"));
  });
});
