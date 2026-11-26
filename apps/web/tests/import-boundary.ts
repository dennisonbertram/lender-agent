import path from "node:path";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

export type SourceReader = (filePath: string) => string | undefined;

export type BoundaryViolation = {
  from: string;
  specifier: string;
  target?: string;
  reason: string;
};

export function runtimeModuleSpecifiers(source: string, fileName = "source.tsx"): string[] {
  const scanner = createScanner(true, fileName.endsWith(".tsx") ? LanguageVariant.JSX : LanguageVariant.Standard, source);
  const tokens: { kind: SyntaxKind; value: string }[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, value: kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText() });
  }
  const specifiers: string[] = [];
  const moduleString = (start: number): string | undefined => {
    if (tokens[start]?.kind === SyntaxKind.StringLiteral) return tokens[start].value;
    let depth = 0;
    for (let i = start; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.kind === SyntaxKind.OpenBraceToken) depth++;
      if (token.kind === SyntaxKind.CloseBraceToken) depth--;
      if (depth === 0 && token.kind === SyntaxKind.FromKeyword && tokens[i + 1]?.kind === SyntaxKind.StringLiteral) return tokens[i + 1].value;
      if (depth === 0 && (token.kind === SyntaxKind.SemicolonToken || (i > start && (token.kind === SyntaxKind.ImportKeyword || token.kind === SyntaxKind.ExportKeyword)))) return undefined;
    }
  };
  const typeOnlyClause = (start: number, end: number): boolean => {
    if (tokens[start]?.value === "type" && tokens[start + 1]?.value !== "from") return true;
    if (tokens[start]?.kind !== SyntaxKind.OpenBraceToken) return false;
    const chunks: (typeof tokens)[] = [];
    let chunk: (typeof tokens)[number][] = [];
    for (const token of tokens.slice(start + 1, end - 1)) {
      if (token.kind === SyntaxKind.CommaToken) {
        chunks.push(chunk);
        chunk = [];
      } else chunk.push(token);
    }
    chunks.push(chunk);
    return chunks.length > 0 && chunks.every((items) =>
      items[0]?.value === "type" && items[1]?.value !== "as" && items.length > 1);
  };
  const typeOnlyImportEquals = (index: number) =>
    tokens[index - 1]?.kind === SyntaxKind.EqualsToken &&
    tokens[index - 3]?.value === "type" &&
    tokens[index - 4]?.kind === SyntaxKind.ImportKeyword;
  const addCall = (index: number) => {
    const argument = tokens[index + 2];
    if (argument?.kind === SyntaxKind.StringLiteral) specifiers.push(argument.value);
    else specifiers.push("<non-literal>");
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === SyntaxKind.ImportKeyword) {
      if (tokens[i + 1]?.kind === SyntaxKind.OpenParenToken) addCall(i);
      else if (tokens[i + 1]?.kind !== SyntaxKind.DotToken) {
        const specifier = moduleString(i + 1);
        const fromIndex = tokens.findIndex((item, index) => index > i && item.kind === SyntaxKind.FromKeyword);
        if (specifier && (fromIndex < 0 || !typeOnlyClause(i + 1, fromIndex))) specifiers.push(specifier);
      }
    } else if (token.kind === SyntaxKind.ExportKeyword) {
      if (tokens[i + 1]?.kind === SyntaxKind.TypeKeyword) continue;
      const specifier = moduleString(i + 1);
      const fromIndex = tokens.findIndex((item, index) => index > i && item.kind === SyntaxKind.FromKeyword);
      if (specifier && !(fromIndex > 0 && typeOnlyClause(i + 1, fromIndex))) specifiers.push(specifier);
    } else if (token.value === "require" && tokens[i + 1]?.kind === SyntaxKind.OpenParenToken && tokens[i - 1]?.kind !== SyntaxKind.DotToken && !typeOnlyImportEquals(i)) {
      addCall(i);
    }
  }
  return specifiers;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveLocal(from: string, specifier: string, sourceRoot: string): string | null {
  if (specifier.startsWith("@/")) return path.resolve(sourceRoot, specifier.slice(2));
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) return path.resolve(path.dirname(from), specifier);
  return null;
}

function resolveFile(base: string, readSource: SourceReader): string | undefined {
  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((extension) => `${base}${extension}`)];
  candidates.push(...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => path.join(base, name)));
  return candidates.find((candidate) => readSource(candidate) !== undefined);
}

export function traceRuntimeImports(entry: string, sourceRoot: string, readSource: SourceReader) {
  const files = new Set<string>();
  const violations: BoundaryViolation[] = [];
  const pending = [path.resolve(entry)];
  const root = path.resolve(sourceRoot);

  while (pending.length) {
    const current = pending.pop()!;
    if (files.has(current)) continue;
    const source = readSource(current);
    if (source === undefined) {
      violations.push({ from: current, specifier: "<entry>", reason: "unresolved source file" });
      continue;
    }
    files.add(current);

    for (const specifier of runtimeModuleSpecifiers(source, current)) {
      if (specifier === "<non-literal>") {
        violations.push({ from: current, specifier, reason: "non-literal runtime import cannot be checked" });
        continue;
      }
      if (specifier.endsWith(".css")) continue;
      const base = resolveLocal(current, specifier, root);
      if (!base) continue;
      const target = resolveFile(base, readSource);
      if (!target) {
        violations.push({ from: current, specifier, target: base, reason: "unresolved local runtime import" });
        continue;
      }
      if (!inside(root, target)) {
        violations.push({ from: current, specifier, target, reason: "runtime import escapes app source" });
        continue;
      }
      if (/\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(target)) {
        violations.push({ from: current, specifier, target, reason: "runtime import reaches test source" });
        continue;
      }
      if (/(^|[/\\])(?:tests?|fixtures?)(?:[/\\]|$)/i.test(target) || /(^|[/\\])data\.[^/\\]+$/i.test(target)) {
        violations.push({ from: current, specifier, target, reason: "runtime import reaches test fixtures or sample data" });
        continue;
      }
      pending.push(target);
    }
  }

  return { files: [...files], violations };
}
