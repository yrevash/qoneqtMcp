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
  const statsBefore = store.stats();
  if (pending.length === 0) {
    log(
      `[embed] up to date: ${formatCount(statsBefore.embedded)}/${formatCount(statsBefore.chunks)} chunks embedded (provider=${embedder.name} model=${embedder.model}).`,
    );
    return {
      provider: embedder.name,
      model: embedder.model,
      embedded: 0,
      skipped: 0,
      durationMs: Date.now() - t0,
    };
  }

  log(
    `[embed] embedding ${formatCount(pending.length)} missing chunks via ${embedder.name}/${embedder.model} (batch=${embedder.batchSize}); ${formatCount(statsBefore.embedded)}/${formatCount(statsBefore.chunks)} already saved.`,
  );

  let embedded = 0;
  let skipped = 0;
  const totalBatches = Math.ceil(pending.length / embedder.batchSize);

  for (let i = 0; i < pending.length; i += embedder.batchSize) {
    const batch = pending.slice(i, i + embedder.batchSize);
    const start = i + 1;
    const end = i + batch.length;
    const batchNumber = Math.floor(i / embedder.batchSize) + 1;
    const batchStart = Date.now();
    log(
      `[embed] batch ${batchNumber}/${totalBatches} chunks ${formatCount(start)}-${formatCount(end)}/${formatCount(pending.length)} starting (${formatPercent(i, pending.length)} pending done, elapsed ${formatDuration(batchStart - t0)})…`,
    );

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

      const elapsedMs = Date.now() - t0;
      const batchMs = Date.now() - batchStart;
      const handled = embedded + skipped;
      const remaining = Math.max(0, pending.length - handled);
      const etaMs = handled > 0 ? (elapsedMs / handled) * remaining : null;
      const totalEmbedded = Math.min(statsBefore.chunks, statsBefore.embedded + embedded);
      log(
        `[embed] saved ${formatCount(embedded)}/${formatCount(pending.length)} pending (${formatPercent(embedded, pending.length)}); total saved ${formatCount(totalEmbedded)}/${formatCount(statsBefore.chunks)}; remaining ${formatCount(remaining)}; batch ${formatDuration(batchMs)}, elapsed ${formatDuration(elapsedMs)}, eta ${formatDuration(etaMs)}.`,
      );
    } catch (err) {
      skipped += batch.length;
      log(`[embed] batch ${formatCount(start)}-${formatCount(end)} failed after ${formatDuration(Date.now() - batchStart)}: ${(err as Error).message}`);
      log("[embed] stopping early; rerun the same index command to resume remaining chunks.");
      break;
    }
  }

  const finalStats = store.stats();
  log(
    `[embed] finished pass: saved ${formatCount(embedded)} this run, skipped ${formatCount(skipped)}, total embedded ${formatCount(finalStats.embedded)}/${formatCount(finalStats.chunks)} (${formatPercent(finalStats.embedded, finalStats.chunks)}), duration ${formatDuration(Date.now() - t0)}.`,
  );

  return {
    provider: embedder.name,
    model: embedder.model,
    embedded,
    skipped,
    durationMs: Date.now() - t0,
  };
}

function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatPercent(done: number, total: number): string {
  if (total <= 0) return "100.0%";
  return `${((done / total) * 100).toFixed(1)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h ${restMinutes}m`;
}
