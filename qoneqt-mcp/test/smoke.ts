#!/usr/bin/env bun
import { spawn } from "bun";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const WORKSPACE = "/home/yrevash/qoneqtMCP/Qoneqt-Web-App-v1";

// Reset memories so smoke test is reproducible.
await rm(resolve(WORKSPACE, ".qoneqt-mcp/memories"), { recursive: true, force: true });

const proc = spawn(["bun", "run", "src/server.ts"], {
  cwd: import.meta.dir + "/..",
  env: { ...process.env, QONEQT_MCP_WORKSPACE: WORKSPACE },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

let id = 0;
const pending = new Map<number, (msg: any) => void>();
let buffer = "";

(async () => {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
      } catch {
        // ignore non-JSON
      }
    }
  }
})();

(async () => {
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process.stderr.write("[server] " + decoder.decode(value));
  }
})();

function send(method: string, params: any = {}, isNotification = false) {
  if (isNotification) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    proc.stdin.write(msg);
    proc.stdin.flush();
    return Promise.resolve(null);
  }
  const requestId = ++id;
  const msg = JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n";
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`timeout waiting for ${method}`));
    }, 60_000);
    pending.set(requestId, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(msg);
    proc.stdin.flush();
  });
}

async function call(tool: string, args: any) {
  const r = await send("tools/call", { name: tool, arguments: args });
  if (r.error) throw new Error(`${tool}: ${JSON.stringify(r.error)}`);
  return (r.result?.content?.[0]?.text ?? "(no text)") as string;
}

function header(s: string) {
  console.log("\n========== " + s + " ==========");
}

try {
  header("initialize");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.1" },
  });
  console.log("server:", init.result?.serverInfo);
  await send("notifications/initialized", {}, true);

  header("tools/list");
  const list = await send("tools/list", {});
  const tools = (list.result?.tools ?? []) as { name: string }[];
  for (const t of tools) console.log(`  - ${t.name}`);
  console.log(`(${tools.length} tools)`);

  // ---- Week 3: memory + onboard
  header("call: list_memories (empty)");
  console.log(await call("list_memories", {}));

  header("call: onboard");
  console.log(await call("onboard", {}));

  header("call: list_memories (after onboard)");
  console.log(await call("list_memories", {}));

  header("call: read_memory _index");
  console.log(await call("read_memory", { name: "_index" }));

  header("call: read_memory architecture");
  console.log((await call("read_memory", { name: "architecture" })).split("\n").slice(0, 30).join("\n") + "\n…");

  header("call: write_memory custom-note");
  console.log(
    await call("write_memory", {
      name: "smoke-test-note",
      body: "## Smoke test\n\nThis memory was written by the smoke test.",
      title: "Smoke Test",
      status: "stable",
    }),
  );

  header("call: read_memory smoke-test-note");
  console.log(await call("read_memory", { name: "smoke-test-note" }));

  header("call: delete_memory smoke-test-note");
  console.log(await call("delete_memory", { name: "smoke-test-note" }));

  // ---- Week 3: explain_why
  header("call: explain_why symbol=AuthContext");
  console.log(
    (await call("explain_why", { symbol: "AuthContext", max_commits: 4 }))
      .split("\n")
      .slice(0, 50)
      .join("\n") + "\n…",
  );

  // ---- Week 3: AGENTS.md (dry-run, don't write to v1)
  header("call: generate_agents_md write=false (dry-run)");
  const md = await call("generate_agents_md", { write: false, symlink_claude: false });
  console.log(md.split("\n").slice(0, 30).join("\n") + "\n…\n[dry-run output truncated]");

  // ---- Regression checks for prior weeks
  header("call: stats (regression)");
  console.log(await call("stats", {}));

  header("call: find_endpoint_callers /api/metadata/post (regression)");
  console.log(
    await call("find_endpoint_callers", {
      url_pattern: "/api/metadata/post",
      limit: 5,
    }),
  );
} catch (err) {
  console.error("\nSMOKE TEST FAILED:", err);
  proc.kill();
  process.exit(1);
}

proc.kill();
console.log("\n✓ smoke test passed");
