/**
 * Pass-2 of indexing: compute embeddings for any chunks that don't have one yet.
 * Idempotent — safe to call repeatedly. Skips entirely if no embedder is configured.
 */
import type { Store } from "./store.ts";
import {
  f32ToBuffer,
  pickEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.ts";

export interface EmbedPassResult {
  provider: string;
  model: string | null;
  embedded: number;
  skipped: number;
  durationMs: number;
}

export async function runEmbeddingPass(
  store: Store,
  log: (msg: string) => void = () => {},
  embedder: EmbeddingProvider | null = pickEmbeddingProvider(),
): Promise<EmbedPassResult> {
  const t0 = Date.now();
  if (!embedder) {
    log("[embed] no embedder configured (set EMBEDDING_BASE_URL for local embeddings); skipping pass.");
    return { provider: "none", model: null, embedded: 0, skipped: 0, durationMs: 0 };
  }

  // If the embedder identity changed since the last pass, ALL existing embeddings
  // are invalid (different model = different vector space, possibly different dim).
  // Wipe and re-embed.
  const currentTag = `${embedder.name}/${embedder.model}`;
  const lastTag = store.getMeta("embedder");
  if (lastTag && lastTag !== currentTag) {
    log(`[embed] embedder changed (${lastTag} → ${currentTag}); invalidating prior embeddings.`);
    store.invalidateAllEmbeddings();
  }

  const pending = store.chunksMissingEmbedding();
  if (pending.length === 0) {
    log(`[embed] up to date (provider=${embedder.name} model=${embedder.model}).`);
    return {
      provider: embedder.name,
      model: embedder.model,
      embedded: 0,
      skipped: 0,
      durationMs: Date.now() - t0,
    };
  }

  log(
    `[embed] embedding ${pending.length} chunks via ${embedder.name}/${embedder.model}…`,
  );

  let embedded = 0;
  let skipped = 0;

  for (let i = 0; i < pending.length; i += embedder.batchSize) {
    const batch = pending.slice(i, i + embedder.batchSize);
    const start = i + 1;
    const end = i + batch.length;
    log(`[embed] batch ${start}-${end}/${pending.length}…`);

    try {
      const vectors = await embedder.embed(batch.map((c) => c.text), {
        kind: "document",
      });
      for (let j = 0; j < batch.length; j++) {
        const v = vectors[j];
        if (!v) {
          skipped++;
          continue;
        }
        store.updateChunkEmbedding(batch[j]!.symbol_id, f32ToBuffer(v));
        embedded++;
      }
      store.setMeta("embedder", `${embedder.name}/${embedder.model}`);
      store.setMeta("embedded_at", new Date().toISOString());
    } catch (err) {
      skipped += batch.length;
      log(`[embed] batch ${start}-${end} failed: ${(err as Error).message}`);
      log("[embed] stopping early; rerun the same index command to resume remaining chunks.");
      break;
    }
  }

  return {
    provider: embedder.name,
    model: embedder.model,
    embedded,
    skipped,
    durationMs: Date.now() - t0,
  };
}
