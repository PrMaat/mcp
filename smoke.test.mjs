#!/usr/bin/env node
/**
 * Offline smoke test for the MCP server.
 *
 * Verifies protocol compliance WITHOUT needing a live MYCLAW_APT or
 * network access, so it runs clean in any CI pod.
 *
 * Checks:
 *   1. Server boots and logs its readiness line to stderr
 *   2. initialize returns protocolVersion 2024-11-05 + serverInfo
 *   3. tools/list returns exactly 6 tools with the expected names
 *   4. Every tool has a description and an inputSchema (shape sanity)
 *   5. tools/call with a bogus tool name returns JSON-RPC error -32602
 *
 * Run:   node smoke.test.mjs
 * Exit:  0 on all green, 1 otherwise.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "server.mjs");
const EXPECTED_TOOLS = [
  "myclaw_me",
  "myclaw_verify",
  "myclaw_rooms_list",
  "myclaw_room_read",
  "myclaw_room_post",
  "myclaw_audit_proof",
];

let passed = 0, failed = 0;
const log = (ok, name, detail) => {
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok) passed++; else failed++;
};

// Run the server with a sentinel MYCLAW_APT so boot doesn't warn,
// but we never make real API calls so the value doesn't matter.
const child = spawn("node", [SERVER], {
  env: { ...process.env, MYCLAW_APT: "apt_SMOKE_TEST_PLACEHOLDER" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

let stdoutBuf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  stdoutBuf += d.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); }
    }, 5000);
  });
}

async function main() {
  // Give the server a moment to boot.
  await new Promise((r) => setTimeout(r, 100));

  log(stderrBuf.includes("ready"), "server emits readiness log on stderr",
    stderrBuf.includes("ready") ? undefined : `stderr: ${stderrBuf.slice(0, 200)}`);

  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  log(init.result?.protocolVersion === "2024-11-05",
    "initialize returns protocolVersion 2024-11-05",
    init.result?.protocolVersion);
  log(init.result?.serverInfo?.name === "myclawpassport-mcp",
    "initialize returns expected serverInfo.name");
  log(!!init.result?.capabilities?.tools,
    "initialize declares tools capability");

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await call("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  const expected = [...EXPECTED_TOOLS].sort();
  log(names.length === EXPECTED_TOOLS.length,
    `tools/list returns exactly ${EXPECTED_TOOLS.length} tools`,
    `got ${names.length}`);
  log(JSON.stringify(names) === JSON.stringify(expected),
    "tools/list returns the expected tool names",
    names.join(","));

  for (const t of list.result?.tools || []) {
    log(typeof t.description === "string" && t.description.length > 10,
      `tool ${t.name} has a meaningful description`);
    log(t.inputSchema && t.inputSchema.type === "object",
      `tool ${t.name} has a JSON-Schema object inputSchema`);
  }

  const bogus = await call("tools/call", { name: "definitely_not_a_real_tool", arguments: {} });
  log(bogus.error?.code === -32602,
    "tools/call with unknown tool returns JSON-RPC error -32602",
    `got code ${bogus.error?.code}`);

  child.kill();
  const total = passed + failed;
  console.log(`\n${passed}/${total} assertions passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  console.error("stderr so far:", stderrBuf);
  child.kill();
  process.exit(1);
});
