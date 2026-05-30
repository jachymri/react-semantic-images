#!/usr/bin/env node
/**
 * match-images
 *
 * Reads unmatched descriptions (null entries) from the manifest produced by
 * `npx collect-descriptions`, embeds them with a local CLIP model, and
 * assigns the best-matching image from the pool to each one.
 *
 * Existing matched entries are never overwritten.  To rematch a description,
 * set its value to null in the manifest and re-run this command.
 *
 * Usage:
 *   npx match-images
 *   npx match-images --pool public/my-pool --out public/semantic-manifest.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { embedImages, embedTexts } from "./embed.js";
import { assign } from "./match.js";

const SCORE_THRESHOLD = 0.2;

interface CliArgs {
  pool: string;
  out: string;
  publicDir: string;
  cache: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    pool: "public/semantic-pool",
    out: "public/semantic-manifest.json",
    publicDir: "public",
    cache: "node_modules/.cache/react-semantic-images/embeddings.json",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`Missing value for ${a}`); process.exit(2); }
      return v;
    };
    switch (a) {
      case "--pool":   args.pool      = next(); break;
      case "--out":    args.out       = next(); break;
      case "--public": args.publicDir = next(); break;
      case "--cache":  args.cache     = next(); break;
      case "-h":
      case "--help":   args.help = true; break;
      default: console.error(`Unknown argument: ${a}`); process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`match-images — assign pool images to collected descriptions

Usage:
  npx match-images [options]

Options:
  --pool <dir>    Directory of pool images  (default: public/semantic-pool)
  --out <file>    Manifest file             (default: public/semantic-manifest.json)
  --public <dir>  Public web root           (default: public)
  --cache <file>  Embedding cache           (default: node_modules/.cache/react-semantic-images/embeddings.json)
  -h, --help      Show this help

Run \`npx collect-descriptions\` first to populate the manifest with descriptions.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const cwd = process.cwd();
  const poolDir  = path.resolve(cwd, args.pool);
  const outFile  = path.resolve(cwd, args.out);
  const publicDir = path.resolve(cwd, args.publicDir);
  const cachePath = path.resolve(cwd, args.cache);

  // ── 1. Read manifest; find unmatched (null) entries ──────────────────────
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await fs.readFile(outFile, "utf8"));
  } catch {
    console.error(
      `❌  No manifest at ${path.relative(cwd, outFile)}.\n` +
      `   Run \`npx collect-descriptions --url http://localhost:3000\` first.`
    );
    process.exit(1);
  }

  const pending = Object.entries(manifest)
    .filter(([, v]) => v === null)
    .map(([d]) => d);

  console.log(`📋 Manifest: ${Object.keys(manifest).length} total, ${pending.length} unmatched.`);

  if (pending.length === 0) {
    console.log("✅  All descriptions already matched. Nothing to do.");
    console.log("   To rematch a description, set its value to null in the manifest.");
    return;
  }

  // ── 2. Discover pool images ───────────────────────────────────────────────
  const imageFiles = await fg(["**/*.{jpg,jpeg,png,webp,gif,avif}"], {
    cwd: poolDir,
    absolute: true,
    caseSensitiveMatch: false,
  }).catch(() => {
    console.error(`❌  Could not read pool directory: ${poolDir}`);
    process.exit(1);
  }) as string[];

  console.log(`🖼  Pool: ${imageFiles.length} image(s) in ${path.relative(cwd, poolDir)}`);

  if (imageFiles.length === 0) {
    console.error("❌  Pool is empty — add images to the pool directory first.");
    process.exit(1);
  }

  // Exclude images already assigned to other descriptions.
  const usedPaths = new Set(
    Object.values(manifest)
      .filter((v): v is string | { image: string } => v !== null)
      .map((v) => (typeof v === "string" ? v : v.image))
  );

  // ── 3. Embed ──────────────────────────────────────────────────────────────
  console.log("🧠 Generating image embeddings (cached by MD5)…");
  const allEmbeddings = await embedImages(imageFiles, { cwd, poolDir, publicDir, cachePath });
  const available = allEmbeddings.filter((e) => {
    const pub = "/" + path.relative(publicDir, e.file).split(path.sep).join("/");
    return !usedPaths.has(pub);
  });

  console.log("🧠 Generating text embeddings…");
  const textVectors = await embedTexts(pending);
  const textInputs  = pending.map((description, i) => ({ description, vector: textVectors[i]! }));

  // ── 4. Match ──────────────────────────────────────────────────────────────
  console.log("🎯 Running cosine-similarity assignment…");
  const { assignments, unassigned } = assign(textInputs, available);

  for (const a of assignments)
    if (a.score < SCORE_THRESHOLD)
      console.warn(`⚠️  Poor match for "${a.description}" (score ${a.score.toFixed(2)}) — consider adding a better image.`);

  if (unassigned.length > 0) {
    console.warn(`⚠️  ${unassigned.length} description(s) unmatched (pool may be too small):`);
    for (const d of unassigned) console.warn(`     • "${d}"`);
  }

  // ── 5. Write manifest ─────────────────────────────────────────────────────
  for (const a of assignments)
    manifest[a.description] = { image: a.image.publicPath, score: Number(a.score.toFixed(4)) };

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\n✅  Matched ${assignments.length} description(s) → ${path.relative(cwd, outFile)}\n`);
  for (const a of assignments)
    console.log(`  ${a.score.toFixed(3)}  "${a.description}" → ${a.image.publicPath}`);

  // ── 6. Update .gitignore ──────────────────────────────────────────────────
  await updateGitignore(manifest, poolDir, publicDir, cwd);
}

async function isGitRepo(startDir: string): Promise<boolean> {
  let dir = startDir;
  while (true) {
    try {
      await fs.stat(path.join(dir, ".git"));
      return true;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

async function updateGitignore(
  manifest: Record<string, unknown>,
  poolDir: string,
  publicDir: string,
  cwd: string,
): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    return; // not a git repo — skip
  }

  const gitignorePath = path.join(cwd, ".gitignore");
  const poolRel = path.relative(cwd, poolDir).split(path.sep).join("/");
  const publicRel = path.relative(cwd, publicDir).split(path.sep).join("/");

  // All matched image paths from the full manifest (not just this run).
  const matched = Object.values(manifest)
    .filter((v): v is string | { image: string } => v !== null)
    .map((v) => {
      const pub = typeof v === "string" ? v : v.image;
      // pub is a web path like /semantic-pool/img.jpg — prepend publicDir
      return `${publicRel}/${pub.replace(/^\//, "")}`;
    });

  const lines = [
    `# react-semantic-images: ignore unmatched pool images`,
    `${poolRel}/*`,
    ...matched.map((p) => `!${p}`),
  ];
  const block =
    `# --- react-semantic-images ---\n` +
    lines.join("\n") + "\n" +
    `# --- end react-semantic-images ---`;

  let existing = "";
  try { existing = await fs.readFile(gitignorePath, "utf8"); } catch { /* create */ }

  const marker = /# --- react-semantic-images ---[\s\S]*?# --- end react-semantic-images ---/;
  const updated = marker.test(existing)
    ? existing.replace(marker, block)
    : existing.trimEnd() + (existing ? "\n\n" : "") + block + "\n";

  await fs.writeFile(gitignorePath, updated);
  console.log(`\n📝 .gitignore updated — ${matched.length} matched image(s) kept, rest ignored.`);
}

main().catch((err) => {
  console.error("❌ match-images failed:", err);
  process.exit(1);
});
