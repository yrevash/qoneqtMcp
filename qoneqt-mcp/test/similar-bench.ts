#!/usr/bin/env bun
/**
 * Quick benchmark: find_similar_component with the full hybrid stack vs BM25-only.
 * Spawns the MCP server twice (once with EMBEDDING_BASE_URL set, once without) and
 * runs the same queries through both for a side-by-side.
 */
import { spawn } from "bun";

const WORKSPACE = "/home/yrevash/qoneqtMCP/Qoneqt-Web-App-v1";

const QUERIES = [
  "a settings panel with toggle switches",
  "a card showing a user with verified blue tick badge",
  "an avatar with image upload and crop",
  "a comment thread with replies",
  "a dropdown menu with icons",
];

async function runOnce(env: Record<string, string>): Promise<Record<string, string>> {
  const proc = spawn(["bun", "run", "src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, ...env, QONEQT_MCP_WORKSPACE: WORKSPACE },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let id = 0;
  const pending = new Map<number, (msg: any) => void>();
  let buffer = "";
  (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          }
        } catch {}
      }
    }
  })();
  // drain stderr quietly
  (async () => {
    const reader = proc.stderr.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();

  function send(method: string, params: any = {}, isNotif = false) {
    if (isNotif) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      proc.stdin.flush();
      return Promise.resolve(null);
    }
    const requestId = ++id;
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n",
    );
    proc.stdin.flush();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60_000);
      pending.set(requestId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bench", version: "0.0.1" },
  });
  await send("notifications/initialized", {}, true);

  const out: Record<string, string> = {};
  for (const q of QUERIES) {
    const r = await send("tools/call", {
      name: "find_similar_component",
      arguments: { query: q, top: 5 },
    });
    out[q] = (r.result?.content?.[0]?.text ?? "(empty)") as string;
  }
  proc.kill();
  return out;
}

console.log("=== Run A: BM25 only (no EMBEDDING_BASE_URL) ===");
const a = await runOnce({ EMBEDDING_BASE_URL: "" });

console.log("=== Run B: BM25 + Qwen3 8B dense + Qwen3 8B reranker (full local hybrid) ===");
const b = await runOnce({
  EMBEDDING_BASE_URL: "http://localhost:11434/v1",
  QONEQT_MCP_EMBED_MODEL: "qwen3-embedding:8b",
  RERANK_BASE_URL: "http://127.0.0.1:8081",
  QONEQT_MCP_RERANK_MODEL: "Qwen/Qwen3-Reranker-8B",
});

for (const q of QUERIES) {
  console.log("\n========================================================================");
  console.log(`QUERY: ${q}`);
  console.log("\n--- A: bm25 only ---");
  console.log(extractTop(a[q] ?? "", 3));
  console.log("\n--- B: hybrid (dense + rerank) ---");
  console.log(extractTop(b[q] ?? "", 3));
}

function extractTop(text: string, n: number): string {
  const lines = text.split("\n");
  const stagesLine = lines.find((l) => l.startsWith("stages:")) ?? "";
  const out: string[] = [stagesLine];
  let count = 0;
  for (const l of lines) {
    if (/^\d+\.\s/.test(l)) {
      out.push(l);
      count++;
      if (count >= n) break;
    }
  }
  return out.join("\n");
}
