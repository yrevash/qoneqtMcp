import type { Store } from "../index/store.ts";
import type { ChunkRow } from "../lib/types.ts";
import {
  bufferToF32,
  cosineSim,
  type EmbeddingProvider,
  type RerankProvider,
} from "../index/embeddings.ts";

const RRF_K = 60;
const FIRST_STAGE_TOP = 50;

export interface SimilarOpts {
  store: Store;
  embedder: EmbeddingProvider | null;
  reranker: RerankProvider | null;
}

export async function findSimilarComponentTool(
  ctx: SimilarOpts,
  args: { query: string; kind?: "component" | "hook"; top?: number; rerank?: boolean },
): Promise<string> {
  const topK = Math.min(args.top ?? 10, 30);

  const allChunks = ctx.store
    .allComponentChunks()
    .filter((c) => (args.kind ? c.kind === args.kind : true));
  if (allChunks.length === 0) {
    return `no component/hook chunks indexed yet. run reindex first.`;
  }
  const chunkById = new Map<number, ChunkRow>();
  for (const c of allChunks) chunkById.set(c.symbol_id, c);

  // ---- Stage 1: BM25 (FTS5)
  const bm25Hits = ctx.store
    .ftsSearchChunks(escapeFtsQuery(args.query), FIRST_STAGE_TOP * 2)
    .filter((h) => chunkById.has(h.symbol_id));
  const bm25Ranks = new Map<number, number>();
  bm25Hits.forEach((h, i) => bm25Ranks.set(h.symbol_id, i + 1));

  // ---- Stage 2: dense (if embedder available + chunks have embeddings)
  const denseRanks = new Map<number, number>();
  let dense: { id: number; score: number }[] = [];
  let denseUsed = false;
  if (ctx.embedder) {
    const candidates = allChunks.filter((c) => c.embedding && c.embedding.length > 0);
    if (candidates.length > 0) {
      const [qVec] = await ctx.embedder.embed([args.query], { kind: "query" });
      if (qVec) {
        denseUsed = true;
        dense = candidates
          .map((c) => ({
            id: c.symbol_id,
            score: cosineSim(qVec, bufferToF32(c.embedding!)),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, FIRST_STAGE_TOP * 2);
        dense.forEach((d, i) => denseRanks.set(d.id, i + 1));
      }
    }
  }

  // ---- Stage 3: RRF merge
  const rrfScores = new Map<number, number>();
  const candidateIds = new Set<number>([
    ...bm25Ranks.keys(),
    ...denseRanks.keys(),
  ]);
  for (const id of candidateIds) {
    const bmRank = bm25Ranks.get(id) ?? null;
    const dnRank = denseRanks.get(id) ?? null;
    let score = 0;
    if (bmRank != null) score += 1 / (RRF_K + bmRank);
    if (dnRank != null) score += 1 / (RRF_K + dnRank);
    rrfScores.set(id, score);
  }
  let merged = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FIRST_STAGE_TOP);

  // ---- Stage 4: optional rerank
  const wantRerank = args.rerank !== false;
  let rerankUsed = false;
  if (wantRerank && ctx.reranker && merged.length > 0) {
    const docs = merged.map(([id]) => {
      const c = chunkById.get(id)!;
      return formatChunkForRerank(c);
    });
    try {
      const reranked = await ctx.reranker.rerank(args.query, docs, topK);
      const reorder = reranked.map((r) => merged[r.index]!);
      merged = reorder;
      rerankUsed = true;
    } catch (err) {
      // Rerank failures shouldn't kill the tool; fall back to RRF order.
      console.error(`[qoneqt-mcp] rerank failed: ${(err as Error).message}`);
    }
  }

  const top = merged.slice(0, topK);
  return formatSimilarResults(top, chunkById, {
    query: args.query,
    bm25Used: bm25Hits.length > 0,
    denseUsed,
    rerankUsed,
    embedderName: ctx.embedder?.name ?? null,
    rerankerName: ctx.reranker?.name ?? null,
    totalCandidates: candidateIds.size,
  });
}

function formatChunkForRerank(c: ChunkRow): string {
  return `${c.name} (${c.kind}) — ${c.file_path}:${c.start_line}\n${c.text}`;
}

function formatSimilarResults(
  hits: [number, number][],
  byId: Map<number, ChunkRow>,
  meta: {
    query: string;
    bm25Used: boolean;
    denseUsed: boolean;
    rerankUsed: boolean;
    embedderName: string | null;
    rerankerName: string | null;
    totalCandidates: number;
  },
): string {
  const stages = [
    meta.bm25Used ? "bm25" : null,
    meta.denseUsed ? `dense(${meta.embedderName})` : null,
    meta.rerankUsed ? `rerank(${meta.rerankerName})` : null,
  ]
    .filter(Boolean)
    .join(" + ");

  if (hits.length === 0) {
    return `no similar components found for "${meta.query}". stages: ${stages || "none — set EMBEDDING_BASE_URL for local embeddings"}`;
  }

  const lines = [
    `find_similar_component "${meta.query}"`,
    `stages: ${stages}  candidates: ${meta.totalCandidates}  showing: ${hits.length}`,
    "",
  ];
  let i = 1;
  for (const [id, score] of hits) {
    const c = byId.get(id)!;
    lines.push(
      `${i}. ${c.name}  [${c.kind}]  ${c.file_path}:${c.start_line}-${c.end_line}  (score=${score.toFixed(4)})`,
    );
    const preview = firstNonEmptyLines(c.text, 4);
    for (const pl of preview) lines.push(`     ${pl}`);
    i++;
  }
  return lines.join("\n");
}

function firstNonEmptyLines(s: string, n: number): string[] {
  return s
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, n);
}

/**
 * FTS5 has special syntax (NEAR, AND, OR, ", *, etc.). We strip it for safety
 * and let the porter tokenizer do its work on the remaining identifier-like
 * tokens.
 */
function escapeFtsQuery(q: string): string {
  return (
    q
      .replace(/[^a-zA-Z0-9\s_-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => `${t}*`)
      .join(" OR ") || q
  );
}
