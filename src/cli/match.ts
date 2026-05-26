import type { Embedding, ImageEmbedding } from "./embed.js";

export interface MatchInput {
  description: string;
  vector: Embedding;
}

export interface Assignment {
  description: string;
  image: ImageEmbedding;
  score: number;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/**
 * Greedy stable assignment. Vectors are expected to be L2-normalized so the
 * dot product equals cosine similarity.
 *
 * - Builds the full similarity matrix.
 * - Repeatedly picks the highest-scoring (description, image) pair where
 *   neither side has been assigned yet, and locks the pair in.
 * - Yields a deterministic, "highest unique match wins" result; ties break by
 *   input order which is stable across runs.
 */
export function assign(
  descriptions: MatchInput[],
  images: ImageEmbedding[]
): { assignments: Assignment[]; unassigned: string[] } {
  if (descriptions.length === 0 || images.length === 0) {
    return { assignments: [], unassigned: descriptions.map((d) => d.description) };
  }

  type Triple = { di: number; ii: number; score: number };
  const triples: Triple[] = [];
  for (let di = 0; di < descriptions.length; di++) {
    const d = descriptions[di]!;
    for (let ii = 0; ii < images.length; ii++) {
      const im = images[ii]!;
      triples.push({
        di,
        ii,
        score: dot(d.vector, im.vector),
      });
    }
  }
  triples.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.di !== b.di) return a.di - b.di;
    return a.ii - b.ii;
  });

  const takenD = new Set<number>();
  const takenI = new Set<number>();
  const assignments: Assignment[] = [];

  for (const t of triples) {
    if (takenD.has(t.di) || takenI.has(t.ii)) continue;
    takenD.add(t.di);
    takenI.add(t.ii);
    assignments.push({
      description: descriptions[t.di]!.description,
      image: images[t.ii]!,
      score: t.score,
    });
    if (
      takenD.size === descriptions.length ||
      takenI.size === images.length
    ) {
      break;
    }
  }

  const unassigned: string[] = [];
  for (let di = 0; di < descriptions.length; di++) {
    if (!takenD.has(di)) unassigned.push(descriptions[di]!.description);
  }

  return { assignments, unassigned };
}
