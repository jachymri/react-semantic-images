"use client";

import * as React from "react";

export type SemanticManifest = Record<
  string,
  | string
  | {
      image: string;
      score?: number;
    }
>;

export interface SemanticImageProps
  extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  /** Natural-language description of what the image should depict. */
  description: string;
  /** Optional pre-loaded manifest to enable direct SSR and zero-flash loading. */
  manifest?: SemanticManifest;
  /** Custom image component (e.g. Next.js `next/image`). Must accept `src` and `alt` props. */
  as?: React.ElementType;
  /** Override the default manifest URL. Defaults to `/semantic-manifest.json`. */
  manifestUrl?: string;
  /** Fallback image src when no match is found. Defaults to an inline SVG placeholder. */
  fallbackSrc?: string;
}

const DEFAULT_MANIFEST_URL = "/semantic-manifest.json";

// Inline SVG placeholder showing the description text, rendered when no match is found.
function makePlaceholder(description: string): string {
  // Word-wrap the description at ~38 chars per line for the 400px viewBox.
  const words = description.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > 38 && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  const lineHeight = 18;
  const startY = 150 - ((lines.length - 1) * lineHeight) / 2;
  const textNodes = lines
    .map((l, i) => `<text x="200" y="${startY + i * lineHeight}">${l}</text>`)
    .join("");

  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">` +
        `<rect width="400" height="300" fill="#e5e7eb"/>` +
        `<g fill="#9ca3af" font-family="system-ui,sans-serif" font-size="13" text-anchor="middle">${textNodes}</g>` +
      `</svg>`
    )
  );
}

// Module-level cache so the manifest is fetched once per page load.
type ManifestState =
  | { status: "idle" }
  | { status: "loading"; promise: Promise<SemanticManifest> }
  | { status: "ready"; manifest: SemanticManifest }
  | { status: "error"; manifest: SemanticManifest };

const manifestState: { current: ManifestState } = { current: { status: "idle" } };

declare global {
  interface Window {
    __SEMANTIC_MANIFEST__?: SemanticManifest;
    __SEMANTIC_DESCRIPTIONS__?: Set<string>;
  }
}

function readGlobalManifest(): SemanticManifest | undefined {
  if (typeof window !== "undefined" && window.__SEMANTIC_MANIFEST__) {
    return window.__SEMANTIC_MANIFEST__;
  }
  return undefined;
}

function loadManifest(url: string): Promise<SemanticManifest> {
  const state = manifestState.current;
  if (state.status === "ready" || state.status === "error") {
    return Promise.resolve(state.manifest);
  }
  if (state.status === "loading") {
    return state.promise;
  }

  const global = readGlobalManifest();
  if (global) {
    manifestState.current = { status: "ready", manifest: global };
    return Promise.resolve(global);
  }

  if (typeof fetch === "undefined") {
    const empty: SemanticManifest = {};
    manifestState.current = { status: "error", manifest: empty };
    return Promise.resolve(empty);
  }

  const promise = fetch(url, { cache: "force-cache" })
    .then((res) => {
      if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);
      return res.json() as Promise<SemanticManifest>;
    })
    .then((manifest) => {
      manifestState.current = { status: "ready", manifest };
      return manifest;
    })
    .catch(() => {
      const empty: SemanticManifest = {};
      manifestState.current = { status: "error", manifest: empty };
      return empty;
    });

  manifestState.current = { status: "loading", promise };
  return promise;
}

function getCachedManifest(): SemanticManifest | undefined {
  const state = manifestState.current;
  if (state.status === "ready" || state.status === "error") {
    return state.manifest;
  }
  return readGlobalManifest();
}

export const SemanticImage: React.FC<SemanticImageProps> = ({
  description,
  as,
  manifest: inlineManifest,
  manifestUrl = DEFAULT_MANIFEST_URL,
  fallbackSrc,
  alt,
  ...rest
}) => {
  const [mounted, setMounted] = React.useState(false);
  const initial = inlineManifest || getCachedManifest();
  const [manifest, setManifest] = React.useState<SemanticManifest | undefined>(
    initial
  );

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Register this description into the global collector so that
  // `npx collect-descriptions` can harvest it via headless browser.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.__SEMANTIC_DESCRIPTIONS__) window.__SEMANTIC_DESCRIPTIONS__ = new Set();
    window.__SEMANTIC_DESCRIPTIONS__.add(description);
  }, [description]);

  React.useEffect(() => {
    if (inlineManifest) {
      setManifest(inlineManifest);
      return;
    }
    if (manifest) return;
    let cancelled = false;
    loadManifest(manifestUrl).then((m) => {
      if (!cancelled) setManifest(m);
    });
    return () => {
      cancelled = true;
    };
  }, [manifest, inlineManifest, manifestUrl]);

  // If manifest is provided inline, we can render directly on SSR.
  // Otherwise, wait until mounted on client to fetch and display to avoid hydration mismatch.
  const entry = (inlineManifest || mounted) && manifest ? manifest[description] : undefined;
  const resolvedSrc =
    (entry
      ? typeof entry === "string"
        ? entry
        : entry.image
      : undefined) ||
    fallbackSrc ||
    makePlaceholder(description);

  const Component: React.ElementType = as || "img";
  const resolvedAlt = alt ?? description;

  return <Component src={resolvedSrc} alt={resolvedAlt} {...rest} />;
};

SemanticImage.displayName = "SemanticImage";
