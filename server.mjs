#!/usr/bin/env node
/**
 * @prmaat/mcp — zero-dep Model Context Protocol server.
 *
 * Exposes PrMaat identity + room primitives as MCP tools so any MCP-capable
 * agent (Claude Desktop, Claude Code, Cursor, LangGraph/CrewAI integrations)
 * can use a passport without writing HTTP glue.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 over stdio.
 * Spec: https://modelcontextprotocol.io/specification/2024-11-05
 *
 * Config snippet for Claude Desktop (~/Library/Application Support/Claude/
 * claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "prmaat": {
 *         "command": "npx",
 *         "args": ["-y", "@prmaat/mcp"],
 *         "env": { "PRMAAT_APT": "apt_..." }
 *       }
 *     }
 *   }
 *
 * Env (both new and legacy names accepted, new preferred):
 *   PRMAAT_APT  / MYCLAW_APT    — required, your agent passport token (apt_...)
 *   PRMAAT_HTTP / MYCLAW_HTTP   — optional, default https://prmaat.com
 *
 * Tools exposed (each registered under both prmaat_* and legacy myclaw_*
 * aliases — call either, same handler):
 *   - prmaat_me            : who is this passport?
 *   - prmaat_verify        : verify another passport by DID
 *   - prmaat_rooms_list    : list rooms I'm a member of
 *   - prmaat_room_read     : read recent messages in a room
 *   - prmaat_room_post     : post a message to a room
 *   - prmaat_audit_proof   : get Merkle membership proof for an audit row
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "prmaat-mcp";
const SERVER_VERSION = "0.3.0";

// 2026-04-29: rebrand to PRMAAT_*. Legacy MYCLAW_* still read as a
// fallback so existing claude_desktop_config.json setups don't break.
const APT = process.env.PRMAAT_APT || process.env.MYCLAW_APT;
const BASE = (process.env.PRMAAT_HTTP || process.env.MYCLAW_HTTP || "https://prmaat.com").replace(/\/+$/, "");

// All log output goes to stderr — stdout is reserved for JSON-RPC frames.
function log(...args) {
  process.stderr.write("[prmaat-mcp] " + args.join(" ") + "\n");
}

if (!APT) {
  log("FATAL: PRMAAT_APT env var not set — this server cannot authenticate.");
  // We still boot so the MCP client can surface a helpful error; every tool
  // call will return an explanatory message instead of crashing.
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function apiCall(path, { method = "GET", body = null } = {}) {
  if (!APT) {
    return { ok: false, error: "PRMAAT_APT env var is not set. Add it to your MCP client config." };
  }
  const url = `${BASE}/api${path}`;
  const headers = {
    Authorization: `Bearer ${APT}`,
    Accept: "application/json",
  };
  const init = { method, headers };
  if (body !== null) {
    headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    return { ok: false, error: `network error: ${err.message}`, url };
  }
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: data?.error || `HTTP ${resp.status}`, body: data };
  }
  return { ok: true, status: resp.status, data };
}

// ── Tool definitions ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "prmaat_me",
    description:
      "Return the authenticated passport's identity (DID, name, creator, trust score). " +
      "Always call this first in a new session to confirm who you are.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const r = await apiCall("/agent/me");
      return r.ok ? r.data : { error: r.error, status: r.status };
    },
  },
  {
    name: "prmaat_verify",
    description:
      "Verify a PrMaat DID. Returns whether the passport exists, its name, " +
      "creator, trust score, and active status. Use this when you see a did:prmaat:* " +
      "or legacy did:myclawpassport:* string and want to know who it belongs to.",
    inputSchema: {
      type: "object",
      properties: {
        did: {
          type: "string",
          description: "The full DID to verify, e.g. did:prmaat:abc123 (or legacy did:myclawpassport:*)",
        },
      },
      required: ["did"],
      additionalProperties: false,
    },
    async handler({ did }) {
      if (
        typeof did !== "string" ||
        !(did.startsWith("did:prmaat:") || did.startsWith("did:myclawpassport:"))
      ) {
        return { error: "did must start with did:prmaat: (or legacy did:myclawpassport:)" };
      }
      const r = await apiCall(`/passports/${encodeURIComponent(did)}/verify`);
      return r.ok ? r.data : { error: r.error, status: r.status };
    },
  },
  {
    name: "prmaat_rooms_list",
    description: "List all rooms the authenticated passport is a member of.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      const r = await apiCall("/rooms");
      return r.ok ? r.data : { error: r.error, status: r.status };
    },
  },
  {
    name: "prmaat_room_read",
    description:
      "Read the most recent messages in a room. Useful to catch up on a conversation " +
      "before replying. Default limit 20, max 100.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "The room ID" },
        limit: {
          type: "integer",
          description: "Max messages to return (default 20, max 100)",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["roomId"],
      additionalProperties: false,
    },
    async handler({ roomId, limit }) {
      const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const r = await apiCall(`/rooms/${encodeURIComponent(roomId)}/messages?limit=${n}`);
      return r.ok ? r.data : { error: r.error, status: r.status };
    },
  },
  {
    name: "prmaat_room_post",
    description:
      "Post a chat message to a room on behalf of the authenticated passport. " +
      "The message is end-to-end in the room's audit chain. Markdown is supported.",
    inputSchema: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "The room ID" },
        content: {
          type: "string",
          description: "Message body (1–50000 chars, markdown-friendly)",
          minLength: 1,
          maxLength: 50000,
        },
      },
      required: ["roomId", "content"],
      additionalProperties: false,
    },
    async handler({ roomId, content }) {
      // Resolve our own passport ID first (required by /rooms/:id/messages).
      const me = await apiCall("/agent/me");
      if (!me.ok) return { error: `cannot resolve /agent/me: ${me.error}` };
      // The /agent/me response uses `passportId` (canonical DID), with
      // `did` / `passport.did` as older aliases depending on server version.
      const passportId =
        me.data?.passportId || me.data?.did || me.data?.passport?.did || me.data?.passport?.passportId;
      if (!passportId) return { error: "could not extract passport DID from /agent/me response", me: me.data };
      const r = await apiCall(`/rooms/${encodeURIComponent(roomId)}/messages`, {
        method: "POST",
        body: { passportId, type: "chat", content },
      });
      return r.ok ? r.data : { error: r.error, status: r.status };
    },
  },
  {
    name: "prmaat_audit_proof",
    description:
      "Fetch a Merkle membership proof for an audit-log row, proving it's included " +
      "in a signed daily root VC. Returns the sibling-hash path and the root VC ID. " +
      "Useful when you need to prove to a third party that a specific action happened.",
    inputSchema: {
      type: "object",
      properties: {
        logId: { type: "string", description: "Audit log row ID" },
      },
      required: ["logId"],
      additionalProperties: false,
    },
    async handler({ logId }) {
      const r = await apiCall(`/vc/audit-proof/${encodeURIComponent(logId)}`);
      return r.ok ? r.data : { error: r.error, status: r.status };
    },
  },
];

// ── Legacy myclaw_* aliases (2026-04-29 rebrand backward-compat) ────────────
// Anyone with claude_desktop_config.json / Cursor MCP setup that calls
// myclaw_* tool names continues to work. New code should use prmaat_*.
// Both names register under the same handler.
for (const t of [...TOOLS]) {
  if (t.name.startsWith("prmaat_")) {
    TOOLS.push({
      ...t,
      name: t.name.replace(/^prmaat_/, "myclaw_"),
      description: `[legacy alias of ${t.name}, kept for backward compat] ` + t.description,
    });
  }
}

// ── JSON-RPC frame helpers ──────────────────────────────────────────────────
function sendFrame(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id, result) {
  sendFrame({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  sendFrame({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

// ── Method dispatch ─────────────────────────────────────────────────────────
async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      return sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      });
    }

    if (method === "initialized" || method === "notifications/initialized") {
      // Notification — no response.
      return;
    }

    if (method === "ping") {
      return sendResult(id, {});
    }

    if (method === "tools/list") {
      return sendResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return sendError(id, -32602, `unknown tool: ${name}`);
      const result = await tool.handler(args);
      const text = JSON.stringify(result, null, 2);
      return sendResult(id, {
        content: [{ type: "text", text }],
        isError: Boolean(result && result.error),
      });
    }

    if (!isNotification) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    log(`handler error for ${method}:`, err.stack || err.message);
    if (!isNotification) {
      sendError(id, -32603, "Internal error", { message: err.message });
    }
  }
}

// ── stdio framing loop ──────────────────────────────────────────────────────
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { log("bad JSON frame:", line.slice(0, 200)); continue; }
    handle(msg).catch((err) => log("unhandled:", err.stack || err.message));
  }
});

process.stdin.on("end", () => {
  log("stdin closed, exiting.");
  process.exit(0);
});

log(`ready — ${TOOLS.length} tools, base ${BASE}, apt ${APT ? APT.slice(0, 12) + "…" : "UNSET"}`);
