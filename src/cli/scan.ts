import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { parse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import type { JSXOpeningElement, JSXAttribute } from "@babel/types";

type TraverseFn = (
  ast: any,
  visitor: {
    JSXOpeningElement?: (path: NodePath<JSXOpeningElement>) => void;
  }
) => void;

// @babel/traverse is a CJS package. Under `module: NodeNext` +
// `verbatimModuleSyntax`, the default import resolves to the whole
// `module.exports` object whose `.default` property is the traverse function.
// At runtime, Node's ESM interop may unwrap `__esModule=true` and give the
// function directly — pick whichever is callable.
const traverse = (
  typeof (_traverse as unknown) === "function"
    ? (_traverse as unknown)
    : (_traverse as any).default
) as unknown as TraverseFn;

export interface SemanticUsage {
  description: string;
  lock: boolean;
  file: string;
  line: number;
}

const DEFAULT_GLOBS = [
  "src/**/*.{js,jsx,ts,tsx,mjs,cjs}",
  "app/**/*.{js,jsx,ts,tsx,mjs,cjs}",
  "pages/**/*.{js,jsx,ts,tsx,mjs,cjs}",
  "components/**/*.{js,jsx,ts,tsx,mjs,cjs}",
];

const IGNORE = ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**"];

export async function scanProject(
  cwd: string,
  patterns: string[] = DEFAULT_GLOBS
): Promise<SemanticUsage[]> {
  const files = await fg(patterns, { cwd, ignore: IGNORE, absolute: true });
  const usages: SemanticUsage[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    // Cheap pre-filter: if the symbol never appears, skip the parse cost.
    if (!source.includes("SemanticImage")) continue;

    let ast;
    try {
      ast = parse(source, {
        sourceType: "module",
        plugins: ["jsx", "typescript", "decorators-legacy", "classProperties"],
        errorRecovery: true,
      });
    } catch {
      continue;
    }

    traverse(ast, {
      JSXOpeningElement(p) {
        const name = p.node.name;
        if (name.type !== "JSXIdentifier" || name.name !== "SemanticImage") {
          return;
        }

        const attrs = p.node.attributes.filter(
          (a): a is JSXAttribute => a.type === "JSXAttribute"
        );

        const descAttr = attrs.find(
          (a) => a.name.type === "JSXIdentifier" && a.name.name === "description"
        );
        if (!descAttr || !descAttr.value) return;

        let description: string | null = null;
        if (descAttr.value.type === "StringLiteral") {
          description = descAttr.value.value;
        } else if (
          descAttr.value.type === "JSXExpressionContainer" &&
          descAttr.value.expression.type === "StringLiteral"
        ) {
          description = descAttr.value.expression.value;
        } else if (
          descAttr.value.type === "JSXExpressionContainer" &&
          descAttr.value.expression.type === "TemplateLiteral" &&
          descAttr.value.expression.expressions.length === 0
        ) {
          description = descAttr.value.expression.quasis[0]?.value.cooked ?? null;
        }

        if (!description) {
          console.warn(
            `⚠️  Skipping <SemanticImage /> in ${path.relative(cwd, file)}:` +
              `${p.node.loc?.start.line ?? "?"} — description must be a literal string.`
          );
          return;
        }

        let lock = false;
        const lockAttr = attrs.find(
          (a) => a.name.type === "JSXIdentifier" && a.name.name === "lock"
        );
        if (lockAttr) {
          if (!lockAttr.value) {
            // `<SemanticImage lock ... />` is shorthand for `lock={true}`.
            lock = true;
          } else if (
            lockAttr.value.type === "JSXExpressionContainer" &&
            lockAttr.value.expression.type === "BooleanLiteral"
          ) {
            lock = lockAttr.value.expression.value;
          } else if (lockAttr.value.type === "StringLiteral") {
            lock = lockAttr.value.value.toLowerCase() === "true";
          }
        }

        usages.push({
          description,
          lock,
          file,
          line: p.node.loc?.start.line ?? 0,
        });
      },
    });
  }

  // Deduplicate: same description used in multiple places counts once. Lock
  // wins if ANY occurrence locks it.
  const map = new Map<string, SemanticUsage>();
  for (const u of usages) {
    const prev = map.get(u.description);
    if (!prev) {
      map.set(u.description, u);
    } else if (u.lock && !prev.lock) {
      map.set(u.description, u);
    }
  }
  return [...map.values()];
}
