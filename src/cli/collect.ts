#!/usr/bin/env node
/**
 * collect-descriptions
 *
 * Crawls a running dev/preview server with a headless browser, lets React
 * render every page, and harvests the descriptions that <SemanticImage>
 * components register into window.__SEMANTIC_DESCRIPTIONS__.
 *
 * New descriptions are written to the manifest as `null` entries (not yet
 * matched to an image). Existing matched entries are left untouched.
 * Run `npx match-images` afterwards to fill in the image URLs.
 *
 * Usage:
 *   npx collect-descriptions --url http://localhost:3000
 *   npx collect-descriptions --url http://localhost:3000 --out public/semantic-manifest.json
 */

import { promises as fs } from "node:fs";
import path from "node:path";

interface CliArgs {
  url: string;
  out: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: "http://localhost:3000",
    out: "public/semantic-manifest.json",
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
      case "--url":  args.url  = next(); break;
      case "--out":  args.out  = next(); break;
      case "-h":
      case "--help": args.help = true;   break;
      default: console.error(`Unknown argument: ${a}`); process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`collect-descriptions — harvest <SemanticImage> descriptions from a running site

Usage:
  npx collect-descriptions [options]

Options:
  --url <url>   Root URL to crawl  (default: http://localhost:3000)
  --out <file>  Manifest file path (default: public/semantic-manifest.json)
  -h, --help    Show this help
`);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error(
      "❌  collect-descriptions requires Playwright.\n" +
      "    Install it once:\n" +
      "      npm install --save-dev playwright\n" +
      "      npx playwright install chromium"
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const cwd = process.cwd();
  const outFile = path.resolve(cwd, args.out);

  console.log(`🌐 Crawling ${args.url} …`);

  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch();
  const page = await browser.newPage();

  // Silence browser console noise.
  page.on("console", () => {});
  page.on("pageerror", () => {});

  const origin = new URL(args.url).origin;
  const visited = new Set<string>();
  const queue: string[] = [args.url];
  const descriptions = new Set<string>();

  while (queue.length > 0) {
    const url = queue.shift()!;
    const clean = url.split("#")[0]!; // strip fragment
    if (visited.has(clean)) continue;
    visited.add(clean);

    try {
      await page.goto(clean, { waitUntil: "networkidle", timeout: 15_000 });
    } catch {
      console.warn(`   ⚠️  Skipping ${clean} (load timeout or error)`);
      continue;
    }

    // Read whatever <SemanticImage> components have registered on this page.
    const found: string[] = await page.evaluate(() =>
      window.__SEMANTIC_DESCRIPTIONS__
        ? [...(window.__SEMANTIC_DESCRIPTIONS__ as Set<string>)]
        : []
    );
    for (const d of found) descriptions.add(d);
    console.log(`   ✓ ${clean}  (${found.length} description${found.length === 1 ? "" : "s"})`);

    // Enqueue unvisited same-origin links.
    const links: string[] = await page.evaluate(
      (orig: string) =>
        Array.from(document.querySelectorAll("a[href]"))
          .map((a) => (a as HTMLAnchorElement).href.split("#")[0]!)
          .filter((href: string) => {
            try { return new URL(href).origin === orig; } catch { return false; }
          }),
      origin
    );
    for (const link of links) {
      if (!visited.has(link) && !queue.includes(link)) queue.push(link);
    }
  }

  await browser.close();

  // Merge into existing manifest — new descriptions as null, leave existing entries alone.
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(outFile, "utf8"));
  } catch { /* file doesn't exist yet — start fresh */ }

  let added = 0;
  for (const d of descriptions) {
    if (!(d in existing)) { existing[d] = null; added++; }
  }

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(existing, null, 2) + "\n");

  console.log(
    `\n✅  ${descriptions.size} description(s) found across ${visited.size} page(s).` +
    `\n   ${added} new entr${added === 1 ? "y" : "ies"} added to ${path.relative(cwd, outFile)}.` +
    (added > 0 ? "\n   Run `npx match-images` to assign images." : "")
  );
}

main().catch((err) => {
  console.error("❌  collect-descriptions failed:", err);
  process.exit(1);
});
