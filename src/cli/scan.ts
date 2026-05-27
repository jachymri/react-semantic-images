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

/**
 * Returns true if the `description` JSX attribute is a prop passthrough
 * (i.e. an identifier or member expression, not a literal). This is the
 * signature of a wrapper component definition:
 *
 *   <SemanticImage description={description} ... />   // Identifier ✓
 *   <SemanticImage description={props.description} /> // MemberExpression ✓
 */
function isDescriptionPassthrough(attrs: JSXAttribute[]): boolean {
  const descAttr = attrs.find(
    (a) => a.name.type === "JSXIdentifier" && a.name.name === "description"
  );
  if (!descAttr || !descAttr.value) return false;
  if (descAttr.value.type !== "JSXExpressionContainer") return false;
  const expr = descAttr.value.expression;
  return expr.type === "Identifier" || expr.type === "MemberExpression";
}

/** Extract a literal string from the `description` attribute, null if not literal. */
function extractLiteralDescription(attrs: JSXAttribute[]): string | null {
  const descAttr = attrs.find(
    (a) => a.name.type === "JSXIdentifier" && a.name.name === "description"
  );
  if (!descAttr || !descAttr.value) return null;

  if (descAttr.value.type === "StringLiteral") {
    return descAttr.value.value;
  }
  if (descAttr.value.type === "JSXExpressionContainer") {
    const expr = descAttr.value.expression;
    if (expr.type === "StringLiteral") return expr.value;
    if (
      expr.type === "TemplateLiteral" &&
      expr.expressions.length === 0
    ) {
      return expr.quasis[0]?.value.cooked ?? null;
    }
  }
  return null;
}

/**
 * Walk up the Babel path to find the name of the enclosing React component.
 * Handles: function declarations, arrow/function-expression variable declarators,
 * and class declarations.
 */
function getEnclosingComponentName(p: NodePath<JSXOpeningElement>): string | null {
  let cur: any = p.parentPath;
  while (cur) {
    const node = cur.node;

    // function Foo() {} / export function Foo() {}
    if (cur.isFunctionDeclaration?.() && node.id?.type === "Identifier") {
      return node.id.name as string;
    }

    // const Foo = () => {} / const Foo = function() {}
    if (cur.isVariableDeclarator?.() && node.id?.type === "Identifier") {
      const init = node.init;
      if (
        init?.type === "ArrowFunctionExpression" ||
        init?.type === "FunctionExpression"
      ) {
        return node.id.name as string;
      }
    }

    // class Foo extends React.Component {}
    if (cur.isClassDeclaration?.() && node.id?.type === "Identifier") {
      return node.id.name as string;
    }

    cur = cur.parentPath;
  }
  return null;
}

export async function scanProject(
  cwd: string,
  patterns: string[] = DEFAULT_GLOBS
): Promise<SemanticUsage[]> {
  const files = await fg(patterns, { cwd, ignore: IGNORE, absolute: true });

  // ──────────────────────────────────────────────────────────────────
  // 1. Read all source files up-front.
  // ──────────────────────────────────────────────────────────────────
  const sourcesMap = new Map<string, string>();
  for (const file of files) {
    try {
      sourcesMap.set(file, await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. AST cache — each file is parsed at most once.
  // ──────────────────────────────────────────────────────────────────
  const astCache = new Map<string, any>();

  function getAst(file: string): any | null {
    if (astCache.has(file)) return astCache.get(file);
    const src = sourcesMap.get(file);
    if (!src) return null;
    try {
      const ast = parse(src, {
        sourceType: "module",
        plugins: ["jsx", "typescript", "decorators-legacy", "classProperties"],
        errorRecovery: true,
      });
      astCache.set(file, ast);
      return ast;
    } catch {
      astCache.set(file, null);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. Iteratively discover all wrapper component names.
  //
  //    A wrapper is any component that renders a *known* semantic
  //    image component and forwards `description` as a prop reference
  //    (Identifier / MemberExpression) rather than a literal.
  //
  //    We start with {"SemanticImage"} and expand the set until no new
  //    names are found. This handles arbitrary levels of nesting:
  //      SemanticImage  ←wrapped by→  SemanticImg  ←wrapped by→  HeroImg
  // ──────────────────────────────────────────────────────────────────
  const semanticNames = new Set<string>(["SemanticImage"]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const [file, source] of sourcesMap) {
      // Cheap string pre-filter: skip files that can't mention any known name.
      if (![...semanticNames].some((n) => source.includes(n))) continue;

      const ast = getAst(file);
      if (!ast) continue;

      traverse(ast, {
        JSXOpeningElement(p) {
          const name = p.node.name;
          if (name.type !== "JSXIdentifier" || !semanticNames.has(name.name)) return;

          const attrs = p.node.attributes.filter(
            (a): a is JSXAttribute => a.type === "JSXAttribute"
          );

          // Only a passthrough usage is the signature of a wrapper definition.
          if (!isDescriptionPassthrough(attrs)) return;

          const wrapperName = getEnclosingComponentName(p);
          if (wrapperName && !semanticNames.has(wrapperName)) {
            semanticNames.add(wrapperName);
            changed = true;
          }
        },
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. Collect literal usages across all known semantic component names.
  //    Wrapper definition sites (description is a passthrough) are skipped
  //    here — they carry no literal description of their own.
  // ──────────────────────────────────────────────────────────────────
  const usages: SemanticUsage[] = [];

  for (const [file, source] of sourcesMap) {
    if (![...semanticNames].some((n) => source.includes(n))) continue;

    const ast = getAst(file);
    if (!ast) continue;

    traverse(ast, {
      JSXOpeningElement(p) {
        const name = p.node.name;
        if (name.type !== "JSXIdentifier" || !semanticNames.has(name.name)) return;

        const attrs = p.node.attributes.filter(
          (a): a is JSXAttribute => a.type === "JSXAttribute"
        );

        // Skip wrapper definitions — their description is a prop, not a literal.
        if (isDescriptionPassthrough(attrs)) return;

        const description = extractLiteralDescription(attrs);

        if (!description) {
          const hasDescAttr = attrs.some(
            (a) => a.name.type === "JSXIdentifier" && a.name.name === "description"
          );
          if (hasDescAttr) {
            console.warn(
              `⚠️  Skipping <${name.name} /> in ${path.relative(cwd, file)}:` +
                `${p.node.loc?.start.line ?? "?"} — description must be a literal string.`
            );
          }
          return;
        }

        let lock = false;
        const lockAttr = attrs.find(
          (a) => a.name.type === "JSXIdentifier" && a.name.name === "lock"
        );
        if (lockAttr) {
          if (!lockAttr.value) {
            // <SemanticImg lock ... /> — shorthand boolean true.
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

  // ──────────────────────────────────────────────────────────────────
  // 5. Deduplicate: same description counts once; lock wins if any
  //    occurrence marks it locked.
  // ──────────────────────────────────────────────────────────────────
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
