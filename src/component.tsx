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
  /** If true, the CLI will never reassign a different asset to this description on future runs. */
  lock?: boolean;
  /** Optional pre-loaded manifest to enable direct SSR and zero-flash loading. */
  manifest?: SemanticManifest;
  /**
   * Optional custom image component (e.g. `next/image`). It must accept `src` and `alt` props.
   * Any extra props passed to `<SemanticImage />` are forwarded to it.
   */
  as?: React.ElementType;
  /** Override the default manifest URL (`/semantic-manifest.json`). */
  manifestUrl?: string;
  /** Optional fallback src to render when no match is found. Defaults to an inline SVG placeholder. */
  fallbackSrc?: string;
}

const DEFAULT_MANIFEST_URL = "/semantic-manifest.json";

// Inline SVG placeholder rendered as data URL when no match is found.
const PLACEHOLDER_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">` +
      `<rect width="400" height="300" fill="#e5e7eb"/>` +
      `<g fill="#9ca3af" font-family="system-ui,sans-serif" font-size="16" text-anchor="middle">` +
      `<text x="200" y="150">semantic image</text>` +
      `<text x="200" y="172" font-size="12">no match</text>` +
      `</g></svg>`
  );

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
  lock: _lock, // consumed only by the CLI; intentionally unused at runtime
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
    PLACEHOLDER_SVG;

  const Component: React.ElementType = as || "img";
  const resolvedAlt = alt ?? description;

  return <Component src={resolvedSrc} alt={resolvedAlt} {...rest} />;
};

SemanticImage.displayName = "SemanticImage";
