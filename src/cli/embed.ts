import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const MODEL_ID = "Xenova/clip-vit-base-patch16";

// We lazy-load @huggingface/transformers because it is large and prints
// progress on import.
type ClipBundle = {
  tokenizer: any;
  textModel: any;
  processor: any;
  visionModel: any;
  RawImage: any;
};

let _bundlePromise: Promise<ClipBundle> | null = null;

async function loadClip(): Promise<ClipBundle> {
  if (_bundlePromise) return _bundlePromise;
  _bundlePromise = (async () => {
    const mod: any = await import("@huggingface/transformers");
    // Caching for ONNX weights so subsequent runs are instant.
    if (mod.env) {
      mod.env.allowLocalModels = true;
      mod.env.useBrowserCache = false;
    }
    const [tokenizer, textModel, processor, visionModel] = await Promise.all([
      mod.AutoTokenizer.from_pretrained(MODEL_ID),
      mod.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, {
        quantized: true,
      }),
      mod.AutoProcessor.from_pretrained(MODEL_ID),
      mod.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
        quantized: true,
      }),
    ]);
    return {
      tokenizer,
      textModel,
      processor,
      visionModel,
      RawImage: mod.RawImage,
    };
  })();
  return _bundlePromise;
}

export type Embedding = number[];

export interface ImageEmbedding {
  file: string; // absolute path
  publicPath: string; // path served by web server (e.g. /semantic-pool/foo.jpg)
  hash: string;
  vector: Embedding;
}

interface CacheShape {
  model: string;
  images: Record<string, { hash: string; vector: Embedding }>;
}

async function md5File(file: string): Promise<string> {
  const data = await fs.readFile(file);
  return crypto.createHash("md5").update(data).digest("hex");
}

function normalize(v: Float32Array | number[]): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  const norm = Math.sqrt(sum) || 1;
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / norm;
  return out;
}

async function readCache(cachePath: string): Promise<CacheShape> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as CacheShape;
    if (parsed.model !== MODEL_ID) {
      return { model: MODEL_ID, images: {} };
    }
    return parsed;
  } catch {
    return { model: MODEL_ID, images: {} };
  }
}

async function writeCache(cachePath: string, cache: CacheShape): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache));
}

export interface EmbedImagesOptions {
  cwd: string;
  poolDir: string; // absolute
  publicDir: string; // absolute — used to build public URL
  cachePath: string;
}

function drawProgressBar(current: number, total: number, cached: number, embedded: number) {
  const width = 30;
  const percentage = total > 0 ? Math.floor((current / total) * 100) : 100;
  const filledLength = total > 0 ? Math.round((width * current) / total) : width;
  const emptyLength = width - filledLength;
  const filled = "█".repeat(filledLength);
  const empty = "░".repeat(emptyLength);
  
  process.stdout.write(
    `\r   Progress: [${filled}${empty}] ${percentage}% | ${current}/${total} (Cached: ${cached}, Embedded: ${embedded})`
  );
}

export async function embedImages(
  imageFiles: string[], // absolute paths
  opts: EmbedImagesOptions
): Promise<ImageEmbedding[]> {
  const cache = await readCache(opts.cachePath);
  const results: ImageEmbedding[] = [];

  // Pre-compute hashes (concurrent file reads).
  const hashes = await Promise.all(imageFiles.map((f) => md5File(f)));

  let cachedCount = 0;
  let embeddedCount = 0;

  if (imageFiles.length > 0) {
    drawProgressBar(0, imageFiles.length, 0, 0);
  }

  let clip: ClipBundle | null = null;
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i]!;
    const hash = hashes[i]!;
    const cached = cache.images[file];
    const publicPath = "/" + path
      .relative(opts.publicDir, file)
      .split(path.sep)
      .join("/");

    if (cached && cached.hash === hash) {
      results.push({ file, publicPath, hash, vector: cached.vector });
      cachedCount++;
      drawProgressBar(i + 1, imageFiles.length, cachedCount, embeddedCount);
      continue;
    }

    if (!clip) clip = await loadClip();
    const image = await clip.RawImage.read(file);
    const inputs = await clip.processor(image);
    const out = await clip.visionModel(inputs);
    const tensor = out.image_embeds;
    const vector = normalize(tensor.data as Float32Array);
    cache.images[file] = { hash, vector };
    results.push({ file, publicPath, hash, vector });
    embeddedCount++;
    drawProgressBar(i + 1, imageFiles.length, cachedCount, embeddedCount);
  }

  if (imageFiles.length > 0) {
    process.stdout.write("\n");
  }

  // Prune cache entries for files that no longer exist in the pool.
  const present = new Set(imageFiles);
  for (const key of Object.keys(cache.images)) {
    if (!present.has(key)) delete cache.images[key];
  }

  await writeCache(opts.cachePath, cache);
  return results;
}

export async function embedTexts(texts: string[]): Promise<Embedding[]> {
  if (texts.length === 0) return [];
  const clip = await loadClip();
  const inputs = clip.tokenizer(texts, { padding: true, truncation: true });
  const out = await clip.textModel(inputs);
  const tensor = out.text_embeds;
  const data = tensor.data as Float32Array;
  const dims = tensor.dims as [number, number];
  const batch = dims[0];
  const dim = dims[1];
  const result: Embedding[] = [];
  for (let b = 0; b < batch; b++) {
    const slice = data.subarray(b * dim, (b + 1) * dim);
    result.push(normalize(slice));
  }
  return result;
}
