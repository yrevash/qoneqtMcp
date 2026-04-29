/**
 * Embedding + reranker providers.
 *
 * Pick order (first match wins):
 *
 *   Embedder
 *     1. EMBEDDING_BASE_URL set            → LocalEmbeddingProvider (Ollama / TEI / vLLM / any OpenAI-compat /v1/embeddings)
 *     2. else                              → null (BM25-only mode)
 *
 *   Reranker
 *     1. RERANK_BASE_URL set               → LocalRerankProvider (TEI-style /rerank)
 *     2. else                              → null (no rerank stage)
 *
 * All providers conform to the same EmbeddingProvider / RerankProvider interface.
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** Vector dimensionality. May start at a default and be updated after the first response. */
  dim: number;
  readonly batchSize: number;
  embed(input: string[], opts?: { kind?: "document" | "query" }): Promise<Float32Array[]>;
}

export interface RerankProvider {
  readonly name: string;
  readonly model: string;
  rerank(
    query: string,
    documents: string[],
    topK: number,
  ): Promise<{ index: number; score: number }[]>;
}

// =====================================================
// Provider selection
// =====================================================

export function pickEmbeddingProvider(): EmbeddingProvider | null {
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  if (baseUrl) {
    const model =
      process.env.QONEQT_MCP_EMBED_MODEL ?? "qwen3-embedding:8b";
    return new LocalEmbeddingProvider(baseUrl, model, process.env.EMBEDDING_API_KEY);
  }
  return null;
}

export function pickRerankProvider(): RerankProvider | null {
  const baseUrl = process.env.RERANK_BASE_URL;
  if (baseUrl) {
    const model =
      process.env.QONEQT_MCP_RERANK_MODEL ?? "Qwen/Qwen3-Reranker-8B";
    return new LocalRerankProvider(baseUrl, model);
  }
  return null;
}

// =====================================================
// Local (Ollama / TEI / vLLM — anything OpenAI-compatible)
// =====================================================

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly batchSize: number;
  dim = 1024; // overwritten after first response
  private readonly timeoutMs: number;

  constructor(
    private baseUrl: string,
    public readonly model: string,
    private apiKey: string | undefined = undefined,
  ) {
    // Strip trailing slash; allow base URLs that already include /v1 or that don't.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.batchSize = parsePositiveInt(process.env.QONEQT_MCP_EMBED_BATCH_SIZE, 4, 1, 128);
    this.timeoutMs = parsePositiveInt(process.env.QONEQT_MCP_EMBED_TIMEOUT_MS, 900_000, 30_000, 3_600_000);
  }

  async embed(input: string[]): Promise<Float32Array[]> {
    if (input.length === 0) return [];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const openAiUrl = this.baseUrl.endsWith("/v1")
      ? `${this.baseUrl}/embeddings`
      : `${this.baseUrl}/v1/embeddings`;
    const ollamaBase = this.baseUrl.replace(/\/(?:v1|api)$/, "");
    const ollamaUrl = `${ollamaBase}/api/embed`;
    const urls = this.baseUrl.endsWith("/api")
      ? [ollamaUrl]
      : [openAiUrl, ollamaUrl];

    let lastError: string | null = null;
    for (const url of urls) {
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ model: this.model, input }),
      });
      if (!res.ok) {
        lastError = `local embed ${res.status} at ${url}: ${await res.text()}`;
        if (res.status === 404 && url !== urls[urls.length - 1]) continue;
        throw new Error(lastError);
      }
      return this.parseEmbeddingResponse(await res.json(), input.length);
    }
    throw new Error(lastError ?? "local embed failed");
  }

  private parseEmbeddingResponse(json: unknown, inputLength: number): Float32Array[] {
    const openAi = json as { data?: { embedding: number[]; index: number }[] };
    if (Array.isArray(openAi.data)) {
      const out = new Array<Float32Array>(inputLength);
      for (const item of openAi.data) {
        out[item.index] = Float32Array.from(item.embedding);
      }
      if (out[0]) this.dim = out[0].length;
      return out;
    }

    const ollama = json as { embeddings?: number[][]; embedding?: number[] };
    const embeddings = Array.isArray(ollama.embeddings)
      ? ollama.embeddings
      : Array.isArray(ollama.embedding)
        ? [ollama.embedding]
        : null;
    if (!embeddings) {
      throw new Error("local embed response did not contain embeddings");
    }
    const out = embeddings.map((v) => Float32Array.from(v));
    if (out[0]) this.dim = out[0].length;
    return out;
  }
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.floor(parsed);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

class LocalRerankProvider implements RerankProvider {
  readonly name = "local";
  constructor(private baseUrl: string, public readonly model: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async rerank(
    query: string,
    documents: string[],
    topK: number,
  ): Promise<{ index: number; score: number }[]> {
    if (documents.length === 0) return [];
    const url = `${this.baseUrl}/rerank`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        documents,
        top_n: Math.min(topK, documents.length),
        return_documents: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`local rerank ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      results: { index: number; relevance_score: number }[];
    };
    return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}

// =====================================================
// Float32Array <-> Buffer helpers (for SQLite BLOB)
// =====================================================

export function f32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToF32(buf: Buffer | Uint8Array): Float32Array {
  const u8 = buf instanceof Buffer ? buf : Buffer.from(buf);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function embedInBatches(
  provider: EmbeddingProvider,
  inputs: string[],
  opts: { kind: "document" | "query"; onProgress?: (done: number, total: number) => void },
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (let i = 0; i < inputs.length; i += provider.batchSize) {
    const batch = inputs.slice(i, i + provider.batchSize);
    const out = await provider.embed(batch, { kind: opts.kind });
    for (const v of out) results.push(v);
    opts.onProgress?.(Math.min(i + provider.batchSize, inputs.length), inputs.length);
  }
  return results;
}
