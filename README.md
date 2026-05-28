# react-semantic-images

Instead of manually wiring up image file paths in your components, you write a plain-English description of what the image should show. Two CLI commands take care of the rest — scanning your site, running a local AI model, and assigning the best-matching image from your pool to every slot.

No API keys. No cloud. Runs entirely on your machine.

```tsx
<SemanticImage description="rainy city street at night" width={1200} height={600} />
```

```bash
npx collect-descriptions --url http://localhost:3000
npx match-images
```

---

## How it works

1. You use `<SemanticImage description="...">` in your components wherever you want an image.
2. `collect-descriptions` opens a headless browser, visits every page of your running site, and collects every description into `public/semantic-manifest.json`.
3. You drop image files into `public/semantic-pool/`.
4. `match-images` uses a local [CLIP](https://openai.com/research/clip) model to compare each description against every image and assigns the best match.

The manifest is a plain JSON file you commit to your repo. Re-run the two commands whenever you add new components or new images.

---

## Install

```bash
npm install react-semantic-images
```

Install the headless browser used by `collect-descriptions` (one-time):

```bash
npm install --save-dev playwright
npx playwright install chromium
```

---

## Setup

Create the image pool directory inside your `public` folder:

```
your-project/
└── public/
    └── semantic-pool/    ← put your images here (JPG, PNG, WebP, AVIF)
```

---

## Step 1 — Use the component

```tsx
import { SemanticImage } from "react-semantic-images";

export function Hero() {
  return (
    <SemanticImage
      description="dense foggy forest with rays of light breaking through trees"
      alt="Forest"
      width={1200}
      height={600}
    />
  );
}
```

The description can be anything — a literal string, a variable, a value from a loop or a ternary. It gets collected at runtime, so there are no restrictions on how it is computed.

### Component props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `description` | `string` | ✅ | — | Plain-English description of what the image should show. |
| `as` | `ReactElement` | | `"img"` | Custom image component, e.g. Next.js `next/image`. |
| `manifest` | `object` | | — | Pre-loaded manifest object. Eliminates the loading flash on SSR. |
| `manifestUrl` | `string` | | `"/semantic-manifest.json"` | Custom path to the manifest file. |
| `fallbackSrc` | `string` | | inline SVG | Image shown when no match exists yet. |
| `...rest` | | | | All standard `<img>` attributes are forwarded. |

### With Next.js `next/image`

```tsx
import Image from "next/image";
import { SemanticImage } from "react-semantic-images";

<SemanticImage
  as={Image}
  description="sleek black sports car parked on a wet road at dusk"
  width={800}
  height={500}
/>
```

### Eliminate the loading flash (SSR)

By default the component fetches the manifest on the client after mount.
To render the correct image immediately on the server, inject the manifest into your root layout:

```tsx
// app/layout.tsx  (Next.js App Router)
import manifest from "../public/semantic-manifest.json";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__SEMANTIC_MANIFEST__=${JSON.stringify(manifest)}`
          }}
        />
        {children}
      </body>
    </html>
  );
}
```

Or pass it directly to a single component via the `manifest` prop.

---

## Step 2 — Collect descriptions

Start your dev server, then run:

```bash
npx collect-descriptions --url http://localhost:3000
```

This opens a headless browser, visits every page by following links, and writes all descriptions to `public/semantic-manifest.json` as unmatched entries:

```json
{
  "rainy city street at night": null,
  "dense foggy forest with rays of light": null
}
```

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | `http://localhost:3000` | Root URL to start crawling from. |
| `--out` | `public/semantic-manifest.json` | Where to write the manifest. |

---

## Step 3 — Match images

Drop your images into `public/semantic-pool/`, then run:

```bash
npx match-images
```

The CLIP model embeds both descriptions and images, then assigns the best match for each:

```json
{
  "rainy city street at night": {
    "image": "/semantic-pool/city.jpg",
    "score": 0.31
  }
}
```

| Flag | Default | Description |
|------|---------|-------------|
| `--pool` | `public/semantic-pool` | Directory of pool images. |
| `--out` | `public/semantic-manifest.json` | Manifest file to read from and write to. |
| `--public` | `public` | Public web root (used to build image URLs). |
| `--cache` | `node_modules/.cache/react-semantic-images/embeddings.json` | Cache file for image embeddings. Images are only re-embedded when their content changes. |

The first run downloads the CLIP model weights (~60 MB, cached in `node_modules/.cache`).
Subsequent runs are fast — only new or changed images are re-embedded.

---

## Rematching

**Add a new image to the pool and rematch everything unmatched:**
Just run `npx match-images` again. Already-matched entries are preserved.

**Force a specific description to be rematched:**
Set its value to `null` in the manifest, then run `npx match-images`.

**Start completely from scratch:**
```bash
rm public/semantic-manifest.json
npx collect-descriptions --url http://localhost:3000
npx match-images
```

---

## Troubleshooting

**`playwright: command not found`**
```bash
npm install --save-dev playwright
npx playwright install chromium
```

**`Could not load the "sharp" module using the darwin-arm64 runtime`**

`sharp` installed for the wrong platform. Run this inside the package directory:
```bash
cd node_modules/react-semantic-images
npm install --include=optional sharp
```

**Images still show the placeholder after matching**

The manifest is cached in the browser. Do a hard refresh:
- Mac: `Cmd + Shift + R`
- Windows / Linux: `Ctrl + Shift + R`

**Low match scores (below 0.20)**

The pool images don't visually match the descriptions well. Either rewrite the descriptions to better match what's in the pool, or add more relevant images to the pool.

---

## License

MIT
