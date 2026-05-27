#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { scanProject } from "./scan.js";
import { embedImages, embedTexts } from "./embed.js";
import { assign } from "./match.js";

const SCORE_THRESHOLD = 0.2;

interface CliArgs {
  pool: string;
  out: string;
  src: string[];
  publicDir: string;
  cache: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    pool: "public/semantic-pool",
    out: "public/semantic-manifest.json",
    src: [],
    publicDir: "public",
    cache: "node_modules/.cache/react-semantic-images/embeddings.json",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`Missing value for argument: ${a}`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case "--pool": args.pool = next(); break;
      case "--out": args.out = next(); break;
      case "--public": args.publicDir = next(); break;
      case "--cache": args.cache = next(); break;
      case "--src": args.src.push(next()); break;
      case "-h":
      case "--help": args.help = true; break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`match-images — semantic image matching CLI

Usage:
  npx match-images [options]

Options:
  --pool <dir>     Directory of unassigned images (default: public/semantic-pool)
  --out <file>     Output manifest path        (default: public/semantic-manifest.json)
  --public <dir>   Public web root             (default: public)
  --src <glob>     Source glob to scan         (repeatable; default: src/, app/, pages/, components/)
  --cache <file>   Embedding cache file        (default: node_modules/.cache/react-semantic-images/embeddings.json)
  -h, --help       Show this help
`);
}

async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const poolDir = path.resolve(cwd, args.pool);
  const outFile = path.resolve(cwd, args.out);
  const publicDir = path.resolve(cwd, args.publicDir);
  const cachePath = path.resolve(cwd, args.cache);

  console.log("🔍 Scanning source for <SemanticImage /> usages…");
  const patterns = args.src.length > 0 ? args.src : undefined;
  const usages = await scanProject(cwd, patterns);
  console.log(`   Found ${usages.length} unique description(s).`);

  if (usages.length === 0) {
    console.log("Nothing to match. Writing empty manifest.");
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify({}, null, 2) + "\n");
    return;
  }

  // Load existing manifest for lock preservation.
  const existing = await readJsonSafe<
    Record<string, string | { image: string; score?: number }>
  >(outFile, {});

  // Discover image pool.
  let imageFiles: string[];
  try {
    imageFiles = await fg(["**/*.{jpg,jpeg,png,webp,gif,avif}"], {
      cwd: poolDir,
      absolute: true,
      caseSensitiveMatch: false,
    });
  } catch (err) {
    console.error(`❌ Could not read pool directory: ${poolDir}`);
    throw err;
  }
  console.log(`🖼  Image pool: ${imageFiles.length} file(s) in ${path.relative(cwd, poolDir)}`);

  if (imageFiles.length === 0) {
    console.warn("⚠️  No images in the pool. Writing empty manifest.");
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify({}, null, 2) + "\n");
    return;
  }

  // Partition: locked descriptions whose previous mapping exists in the
  // manifest AND whose target file still exists in the pool.
  const lockedAssignments: Record<
    string,
    { image: string; score?: number } | string
  > = {};
  const lockedImagePaths = new Set<string>();
  const remainingDescriptions = [] as { description: string }[];

  const imagePathByPublic = new Map<string, string>();
  for (const f of imageFiles) {
    const publicPath =
      "/" + path.relative(publicDir, f).split(path.sep).join("/");
    imagePathByPublic.set(publicPath, f);
  }

  for (const u of usages) {
    const previous = existing[u.description];
    if (u.lock && previous) {
      const prevPath = typeof previous === "string" ? previous : previous.image;
      if (imagePathByPublic.has(prevPath)) {
        lockedAssignments[u.description] = previous;
        lockedImagePaths.add(imagePathByPublic.get(prevPath)!);
      } else {
        remainingDescriptions.push({ description: u.description });
      }
    } else {
      remainingDescriptions.push({ description: u.description });
    }
  }

  if (Object.keys(lockedAssignments).length > 0) {
    console.log(`🔒 Preserving ${Object.keys(lockedAssignments).length} locked mapping(s).`);
  }

  const availableImages = imageFiles.filter((f) => !lockedImagePaths.has(f));

  // Embed every image in the pool (locked ones too, so the cache stays warm
  // for next time the user unlocks them). Only the locked file paths are
  // excluded from the assignment step itself.
  console.log("🧠 Generating image embeddings (cached by MD5)…");
  const imageEmbeddings = await embedImages(imageFiles, {
    cwd,
    poolDir,
    publicDir,
    cachePath,
  });
  const availableEmbeddings = imageEmbeddings.filter(
    (e) => !lockedImagePaths.has(e.file)
  );

  console.log("🧠 Generating text embeddings…");
  const textVectors = await embedTexts(
    remainingDescriptions.map((d) => d.description)
  );
  const textInputs = remainingDescriptions.map((d, i) => ({
    description: d.description,
    vector: textVectors[i]!,
  }));

  console.log("🎯 Running cosine-similarity assignment…");
  const { assignments, unassigned } = assign(textInputs, availableEmbeddings);

  for (const a of assignments) {
    if (a.score < SCORE_THRESHOLD) {
      console.warn(
        `⚠️ Warning: Poor semantic match for description: "${a.description}". Using closest available asset.`
      );
    }
  }

  if (unassigned.length > 0) {
    console.warn(
      `⚠️  ${unassigned.length} description(s) had no remaining image to assign:`
    );
    for (const d of unassigned) console.warn(`     • "${d}"`);
  }

  const manifest: Record<
    string,
    { image: string; score?: number } | string
  > = { ...lockedAssignments };
  for (const a of assignments) {
    manifest[a.description] = {
      image: a.image.publicPath,
      score: Number(a.score.toFixed(4)),
    };
  }

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `✅ Wrote ${Object.keys(manifest).length} mapping(s) → ${path.relative(cwd, outFile)}`
  );

  // Report scores for transparency.
  if (assignments.length > 0) {
    console.log("\nMatches:");
    for (const a of assignments) {
      console.log(
        `  ${a.score.toFixed(3)}  "${a.description}" → ${a.image.publicPath}`
      );
    }
  }
  if (Object.keys(lockedAssignments).length > 0) {
    console.log("\nLocked:");
    for (const [d, p] of Object.entries(lockedAssignments)) {
      const displayPath = typeof p === "string" ? p : p.image;
      const displayScore =
        typeof p === "string"
          ? ""
          : p.score !== undefined
          ? ` (score: ${p.score.toFixed(3)})`
          : "";
      console.log(`  🔒       "${d}" → ${displayPath}${displayScore}`);
    }
  }
}

main().catch((err) => {
  console.error("❌ match-images failed:");
  console.error(err);
  process.exit(1);
});
