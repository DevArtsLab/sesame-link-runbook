// devin-pi-bridge.mjs
// Stands in for `pi` inside Sesame Link: the daemon launches this as
// `pi -e <extension.ts>` with SESAME_PI_ADAPTER_DIR (+ optional
// SESAME_PI_CONTROL_SOCKET). Instead of loading a Pi extension, this process
// itself serves the Link control-socket protocol (JSON-lines over a unix
// socket) and drives `devin acp` over stdio JSON-RPC.
//
// Wire protocol mirrored from the adapter embedded in the sesame-link binary:
//   requests  { id, type, ... }
//   responses { type:'response', id, ok, result | error, dispatch }
//   events    { type:'event', epoch, seq, sessionId, data }

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

const HOME = process.env.HOME || os.homedir();
const DEVIN =
  process.env.DEVIN_BIN || path.join(HOME, ".local", "bin", "devin");
const CREDENTIALS =
  process.env.DEVIN_CREDENTIALS ||
  path.join(HOME, ".local", "share", "devin", "credentials.toml");
const FRAME_BYTES = 1024 * 1024;
const TOKEN = /^[a-zA-Z0-9_-]{1,100}$/;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MUTATIONS = new Set([
  "submit",
  "abort",
  "configure",
  "rename",
  "compact",
  "reload",
]);
const MODELS = [
  {
    provider: "devin",
    id: "devin",
    name: "Devin (this Mac)",
    reasoning: true,
    input: ["text", "image"],
  },
];
// How a session/request_permission from `devin acp` is answered while nobody
// is watching a terminal. 'allow_once' grants each tool call individually.
const PERMISSION_PICK = process.env.BRIDGE_PERMISSION_PICK || "allow_once";

const adapterDir = process.env.SESAME_PI_ADAPTER_DIR;
if (!adapterDir) {
  console.error(
    "devin-pi-bridge: SESAME_PI_ADAPTER_DIR is not set; run through sesame-link",
  );
  process.exit(2);
}
const socketPath =
  process.env.SESAME_PI_CONTROL_SOCKET || path.join(adapterDir, "control.sock");

// Args the daemon passes through to `pi` (--offline, -e <ext>, --session-dir, ...).
const argv = process.argv.slice(2);
const argAfter = (flag) => argv[argv.indexOf(flag) + 1];
const guidanceFile = argv.includes("--append-system-prompt")
  ? argAfter("--append-system-prompt")
  : null;
const sessionDir = argv.includes("--session-dir") ? argAfter("--session-dir") : null;
if (sessionDir) {
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch {}
}
const sessionFile = path.join(sessionDir || adapterDir, "devin-session.jsonl");
const ledgerFile = path.join(adapterDir, "attempts.jsonl");

const say = (...args) => console.log("[bridge]", ...args);

// ---------------------------------------------------------------------------
// Attempt ledger: same JSONL shape as Pi's adapter (version 1 records).
// ---------------------------------------------------------------------------
const ledger = {
  entries: new Map(),
  fd: null,
  open() {
    try {
      fs.chmodSync(adapterDir, 0o700);
    } catch {}
    this.fd = fs.openSync(
      ledgerFile,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND,
      0o600,
    );
    const content = fs.readFileSync(this.fd, "utf8");
    for (const line of content.trim().split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (record.version === 1 && record.outcome !== undefined) {
          const entry = this.entries.get(record.operationId);
          if (entry) Object.assign(entry, record.outcome);
        } else if (record.version === 1) {
          this.entries.set(record.operationId, record);
        }
      } catch {}
    }
  },
  append(record) {
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(this.fd);
  },
  claim(operationId, command) {
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const previous = this.entries.get(operationId);
    if (previous) {
      if (previous.digest !== digest)
        throw new Error("Operation ID already belongs to a different command");
      return { duplicate: true, record: previous };
    }
    const record = {
      version: 1,
      operationId,
      digest,
      sessionId: command.sessionId,
      command: command.type,
      attemptedAt: Date.now(),
      delivery: "unknown",
    };
    this.append(record);
    this.entries.set(operationId, record);
    return { duplicate: false, record };
  },
  record(operationId, outcome) {
    const entry = this.entries.get(operationId);
    if (!entry) throw new Error("Unknown operation");
    this.append({ version: 1, operationId, outcome });
    Object.assign(entry, outcome);
  },
  close() {
    try {
      fs.closeSync(this.fd);
    } catch {}
  },
};

// ---------------------------------------------------------------------------
// Session file: linear JSONL history in Pi's entry shape ({id,parentId,message}).
// ---------------------------------------------------------------------------
const session = {
  id: randomUUID(),
  cwd: process.cwd(),
  name: "Devin",
  model: MODELS[0],
  thinking: "off",
  entries: [],
  leafId: null,
  writeHeader() {
    fs.appendFileSync(
      sessionFile,
      JSON.stringify({
        type: "session",
        id: this.id,
        timestamp: new Date().toISOString(),
        cwd: this.cwd,
      }) + "\n",
    );
  },
  appendMessage(role, content) {
    const entry = {
      id: randomUUID(),
      parentId: this.leafId,
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role, content: [{ type: "text", text: content }] },
    };
    this.entries.push(entry);
    this.leafId = entry.id;
    fs.appendFileSync(sessionFile, JSON.stringify(entry) + "\n");
    return entry;
  },
};

// ---------------------------------------------------------------------------
// Event log + broadcast.
// ---------------------------------------------------------------------------
const epoch = randomUUID();
let seq = 0;
const events = [];
let eventBytes = 0;
const peers = new Set();

function send(peer, value) {
  if (peer.destroyed) return;
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > FRAME_BYTES || peer.writableLength > 2 * FRAME_BYTES) {
    peer.destroy();
    return;
  }
  peer.write(line);
}

function emit(data) {
  let event = { type: "event", epoch, seq: ++seq, sessionId: session.id, data };
  let size = Buffer.byteLength(JSON.stringify(event));
  if (size > FRAME_BYTES / 2) {
    event.data = {
      type: "event_omitted",
      originalType: data.type,
      reason: "size_limit",
      recoverFrom: "history",
    };
    size = Buffer.byteLength(JSON.stringify(event));
  }
  events.push(event);
  eventBytes += size;
  while (events.length > 256 || eventBytes > 4 * FRAME_BYTES) {
    eventBytes -= Buffer.byteLength(JSON.stringify(events.shift()));
  }
  for (const peer of peers) send(peer, event);
}

// ---------------------------------------------------------------------------
// Devin ACP subprocess.
// ---------------------------------------------------------------------------
const devin = {
  child: null,
  sessionId: null,
  starting: null,
  reqId: 0,
  pending: new Map(),
  buf: "",
  running: false, // a session/prompt is in flight
  queue: [], // followUp prompts while running
  currentOp: null, // { operationId, runId, text, assistantText }
  runId: null,
  tools: new Set(),

  key() {
    if (this._key) return this._key;
    const toml = fs.readFileSync(CREDENTIALS, "utf8");
    this._key = toml.match(/windsurf_api_key\s*=\s*"([^"]+)"/)?.[1];
    if (!this._key)
      throw new Error(
        "No windsurf_api_key in devin credentials.toml; run `devin auth login`",
      );
    return this._key;
  },

  call(method, params) {
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  },

  notify(method, params) {
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {}
  },

  async ensure() {
    if (this.sessionId) return;
    if (this.starting) return this.starting;
    this.starting = this.spawn();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  },

  async spawn() {
    say("starting devin acp");
    this.child = spawn(DEVIN, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child.stderr.on("data", () => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => this.onData(d));
    this.child.on("exit", (code) => {
      say("devin acp exited", code);
      const err = new Error("Devin agent exited");
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      const wasRunning = this.running;
      this.child = null;
      this.sessionId = null;
      if (wasRunning && this.currentOp)
        this.finishRun("failed", "Devin agent exited mid-run");
    });
    const init = await this.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "sesame-link-devin-bridge", version: "0.1.0" },
    });
    say("acp initialized");
    await this.call("authenticate", {
      methodId: "devin-browser",
      _meta: { api_key: this.key() },
    });
    say("acp authenticated");
    // Forward a Link-provided MCP config when the daemon writes one; fall back
    // to none if the ACP server refuses stdio MCP specs.
    const mcpServers = readMcpServers(path.join(adapterDir, "mcp.json"));
    let created;
    try {
      created = await this.call("session/new", { cwd: session.cwd, mcpServers });
    } catch (error) {
      say("session/new with mcp failed, retrying without:", error.message);
      created = await this.call("session/new", { cwd: session.cwd, mcpServers: [] });
    }
    this.sessionId = created.sessionId;
    say("acp session", this.sessionId);
    emit({ type: "session", state: state() });
  },

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  },

  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // Agent -> client request: permission prompts, fs, terminal.
      this.answerAgentRequest(msg);
      return;
    }
    if (msg.method === "session/update") this.onUpdate(msg.params?.update ?? {});
    // _cognition.ai/* housekeeping notifications are ignored.
  },

  answerAgentRequest(msg) {
    const respond = (result) =>
      this.child?.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
      );
    if (msg.method === "session/request_permission") {
      const options = msg.params?.options ?? [];
      const pick =
        options.find((o) => o.kind === PERMISSION_PICK) ??
        options.find((o) => String(o.kind).startsWith("allow")) ??
        options[0];
      emit({ type: "ui_prompt_start" });
      respond({ outcome: { outcome: "selected", optionId: pick?.optionId } });
      emit({ type: "ui_prompt_end" });
      say("permission auto-answered:", pick?.name ?? pick?.optionId ?? "none");
      return;
    }
    // Unsupported agent->client requests get a proper JSON-RPC error, not an
    // empty result (a missing result/error member is a malformed response and
    // can leave the ACP server waiting on a reply that never parses).
    try {
      this.child?.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Not implemented: ${msg.method}` },
        }) + "\n",
      );
    } catch {}
  },

  async submit(operationId, text, images, mode) {
    const op = { operationId, runId: randomUUID(), text, images, assistantText: "" };
    if (this.queue.length >= 64) throw new Error("Prompt queue full");
    if (this.running && mode === "followUp") {
      this.queue.push(op);
      return op;
    }
    if (this.running && mode === "steer") {
      this.notify("session/cancel", { sessionId: this.sessionId });
    }
    this.queue.push(op);
    this.pump();
    return op;
  },

  async pump() {
    if (this.running || !this.queue.length) return;
    const op = this.queue.shift();
    this.currentOp = op;
    this.runId = op.runId;
    this.running = true;

    const entry = session.appendMessage("user", op.text);
    emit({ type: "input", text: op.text, source: "extension" });
    emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: op.text }] },
    });
    this.deliver(op.operationId, entry.id);
    emit({ type: "before_agent_start" });
    emit({ type: "agent_start" });

    try {
      const prompt = [{ type: "text", text: op.text }];
      // The daemon's remote-operation guidance goes in once, like Pi's
      // --append-system-prompt, as an embedded resource on the first prompt.
      if (!this.guidanceSent) {
        const guidance = readGuidance();
        if (guidance) {
          prompt.unshift({
            type: "resource",
            resource: {
              uri: `file://${guidanceFile}`,
              mimeType: "text/plain",
              text: guidance,
            },
          });
        }
        this.guidanceSent = true;
      }
      for (const image of op.images ?? []) {
        prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      const result = await this.call("session/prompt", {
        sessionId: this.sessionId,
        prompt,
      });
      this.finishRun(
        result?.stopReason === "cancelled" ? "interrupted" : "completed",
        null,
        result?.stopReason,
      );
    } catch (error) {
      this.finishRun("failed", String(error.message ?? error));
    }
  },

  onUpdate(update) {
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" && update.content?.type === "text") {
      this.currentOp && (this.currentOp.assistantText += update.content.text);
      emit({
        type: "message_update",
        update: { type: "text_delta", contentIndex: 0, delta: update.content.text },
      });
    } else if (kind === "agent_thought_chunk" && update.content?.type === "text") {
      emit({
        type: "message_update",
        update: { type: "thinking_delta", contentIndex: 0, delta: update.content.text },
      });
    } else if (kind === "tool_call") {
      this.tools.add(update.toolCallId);
      emit({
        type: "tool_execution_start",
        toolCallId: update.toolCallId,
        toolName: update.title,
        input: update.rawInput,
      });
    } else if (kind === "tool_call_update") {
      emit({ type: "tool_execution_update", toolCallId: update.toolCallId, update });
      if (update.status === "completed" || update.status === "failed") {
        this.tools.delete(update.toolCallId);
        emit({
          type: "tool_execution_end",
          toolCallId: update.toolCallId,
          status: update.status,
          output: update.rawOutput,
        });
      }
    }
  },

  deliver(operationId, entryId) {
    try {
      ledger.record(operationId, { delivery: "delivered", entryId });
    } catch {
      return;
    }
    emit({ type: "command_delivered", operationId, entryId });
  },

  finishRun(outcome, error, stopReason = "end_turn") {
    const op = this.currentOp;
    this.running = false;
    this.runId = null;
    this.currentOp = null;
    this.tools.clear();
    if (!op) return;
    const entry = session.appendMessage(
      "assistant",
      op.assistantText || (error ? `Error: ${error}` : ""),
    );
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: entry.message.content[0].text }],
        stopReason,
      },
    });
    emit({ type: "agent_end", endedRunId: op.runId, state: state() });
    emit({ type: "agent_settled" });
    try {
      ledger.record(op.operationId, { completion: outcome });
    } catch {}
    if (outcome === "completed" || outcome === "interrupted") {
      emit({ type: "command_completed", operationId: op.operationId, outcome });
    } else {
      emit({
        type: "command_failed",
        operationId: op.operationId,
        error: error ?? "failed",
      });
    }
    say(`run ${outcome} (op ${op.operationId})`);
    this.pump();
  },

  cancel(runId) {
    if (this.runId !== runId) throw new Error("Run changed; interruption refused");
    this.notify("session/cancel", { sessionId: this.sessionId });
  },
};

function readMcpServers(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // Single-server spec written by the daemon: {command, args, env, exposure}.
    if (parsed.command) {
      const { exposure: _drop, ...spec } = parsed;
      return [{ name: "sesame-link", ...spec, env: toAcpEnv(spec.env) }];
    }
    const map = parsed.mcpServers ?? parsed.servers ?? {};
    if (Array.isArray(map)) return map;
    return Object.entries(map).map(([name, spec]) => ({
      name,
      ...spec,
      env: toAcpEnv(spec.env),
    }));
  } catch {
    return [];
  }
}

// ACP wants env as [{name, value}], the daemon writes it as a {K: V} map.
function toAcpEnv(env) {
  if (!env) return [];
  if (Array.isArray(env)) return env;
  return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
}

function readGuidance() {
  if (!guidanceFile) return null;
  try {
    return fs.readFileSync(guidanceFile, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State + request handling.
// ---------------------------------------------------------------------------
function activity() {
  if (devin.running || devin.tools.size) return "running";
  return "idle_observed";
}

function state() {
  return {
    protocol: 1,
    epoch,
    seq,
    sessionId: session.id,
    sessionFile,
    leafId: session.leafId,
    cwd: session.cwd,
    name: session.name,
    model: {
      provider: session.model.provider,
      id: session.model.id,
      name: session.model.name,
      input: session.model.input,
    },
    thinking: session.thinking,
    activity: activity(),
    piReportedIdle: activity() === "idle_observed",
    pendingMessages: devin.queue.length > 0,
    runId: devin.runId,
    activeTools: [...devin.tools],
    capabilities: {
      imageInput: true,
      prompt: true,
      steer: true,
      followUp: true,
      interrupt: true,
      nativeTerminal: false,
      durableHistory: true,
      configure: true,
      exactDeliveryReceipt: true,
      atomicNativeAdmission: false,
      remoteNativeDialogs: false,
      linkPermissionEnforcement: false,
    },
  };
}

function readImages(paths) {
  if (!Array.isArray(paths) || paths.length > 4) throw new Error("Invalid images");
  return paths.map((p) => {
    if (typeof p !== "string" || !p.startsWith("/"))
      throw new Error("Invalid image path");
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || (stat.mode & 0o077) !== 0)
        throw new Error("Invalid image file");
      const data = fs.readFileSync(fd);
      const mimeType = data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : data[0] === 255 && data[1] === 216
          ? "image/jpeg"
          : undefined;
      if (!mimeType) throw new Error("Unsupported image");
      return { type: "image", mimeType, data: data.toString("base64") };
    } finally {
      fs.closeSync(fd);
    }
  });
}

function history(request) {
  // The requested leaf bounds the branch's end; `after` bounds its start.
  let branch = session.entries;
  if (request.leafId) {
    const leafIndex = session.entries.findIndex((e) => e.id === request.leafId);
    if (leafIndex === -1) throw new Error("Unknown history leaf");
    branch = session.entries.slice(0, leafIndex + 1);
  }
  let start = 0;
  if (request.after) {
    start = branch.findIndex((e) => e.id === request.after) + 1;
    if (start === 0) throw new Error("History cursor is not on this branch");
  }
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid history limit");
  const entries = [];
  let bytes = 0;
  for (const entry of branch.slice(start)) {
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (bytes + size > FRAME_BYTES * 0.7) break;
    entries.push(entry);
    bytes += size;
    if (entries.length === limit) break;
  }
  return {
    source: "pi_session_file",
    leafId: session.leafId,
    entries,
    next: entries.at(-1)?.id ?? request.after ?? null,
    complete: start + entries.length === branch.length,
    operationCorrelation: "unavailable",
  };
}

async function handleRequest(request) {
  if (request.type === "startup") {
    return { protocol: 1, epoch, started: true, projectTrust: null, answered: null };
  }
  if (request.type === "project_trust")
    throw new Error("No such project trust question");
  if (request.type === "state") return state();
  if (request.type === "events") {
    if (
      request.epoch !== epoch ||
      !Number.isSafeInteger(request.after) ||
      request.after < 0 ||
      request.after > seq
    ) {
      throw new Error("Invalid replay cursor; reload state and history");
    }
    const first = events[0]?.seq ?? seq + 1;
    if (request.after < first - 1)
      throw new Error("Replay gap; reload state and history");
    const out = [];
    let bytes = 0;
    for (const event of events.filter((e) => e.seq > request.after)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > FRAME_BYTES * 0.7) break;
      out.push(event);
      bytes += size;
    }
    return { events: out, next: out.at(-1)?.seq ?? request.after, head: seq };
  }
  if (request.type === "models") return MODELS;
  if (request.type === "deliveries") {
    return Object.fromEntries(
      [...ledger.entries.values()]
        .filter((r) => r.delivery === "delivered")
        .map((r) => [r.operationId, r.entryId]),
    );
  }
  if (request.type === "operation") {
    const record = ledger.entries.get(request.operationId);
    if (!record) throw new Error("Unknown operation");
    return record;
  }
  if (request.sessionId !== session.id)
    throw new Error("Session changed; reload state");
  if (request.type === "history") return history(request);
  if (!MUTATIONS.has(request.type)) throw new Error("Unsupported command");
  if (!TOKEN.test(request.operationId ?? "")) throw new Error("Invalid operationId");

  const command = { sessionId: request.sessionId, type: request.type };
  if (request.type === "submit") {
    if (
      typeof request.text !== "string" ||
      !request.text.trim() ||
      Buffer.byteLength(request.text) > 65536
    )
      throw new Error("Invalid text");
    command.text = request.text;
    if (
      request.images !== undefined &&
      (!Array.isArray(request.images) || request.images.length > 4)
    )
      throw new Error("Invalid images");
    if (request.images?.length) command.images = request.images;
    command.mode = request.mode ?? (command.images?.length ? "followUp" : "steer");
    if (!["steer", "followUp"].includes(command.mode))
      throw new Error("Invalid delivery mode");
  } else if (request.type === "abort") {
    if (typeof request.runId !== "string" || !request.runId)
      throw new Error("Invalid runId");
    command.runId = request.runId;
  } else if (request.type === "rename") {
    if (
      typeof request.name !== "string" ||
      !request.name.trim() ||
      Buffer.byteLength(request.name) > 200
    )
      throw new Error("Invalid name");
    command.name = request.name;
  } else if (request.type === "configure") {
    if (!request.model && request.thinking === undefined)
      throw new Error("Empty configuration");
    if (request.model) command.model = request.model;
    if (request.thinking !== undefined) {
      if (!THINKING.has(request.thinking)) throw new Error("Invalid thinking level");
      command.thinking = request.thinking;
    }
  }

  const existing = ledger.entries.get(request.operationId);
  if (existing) return ledger.claim(request.operationId, command);

  if (command.type === "abort" && devin.runId !== command.runId) {
    throw new Error("Run changed; interruption refused");
  }
  if (
    (command.type === "compact" || command.type === "reload") &&
    activity() !== "idle_observed"
  ) {
    throw new Error(
      `${command.type === "compact" ? "Compaction" : "Reload"} requires observed idle`,
    );
  }
  const images = command.type === "submit" ? readImages(command.images ?? []) : [];

  const receipt = ledger.claim(request.operationId, command);
  emit({ type: "command_attempted", operation: receipt.record });

  // Once claimed, a failure below leaves dispatch unknowable; the daemon can
  // only recover the outcome from the journal, not from "not attempted".
  try {
    return mutate(request, command, receipt, images);
  } catch (error) {
    error.dispatch = "unknown";
    throw error;
  }
}

function mutate(request, command, receipt, images) {
  if (command.type === "submit") {
    // Fire-and-forget: the prompt runs asynchronously; events broadcast progress.
    devin
      .ensure()
      .then(() => devin.submit(request.operationId, command.text, images, command.mode))
      .catch((error) => {
        try {
          ledger.record(request.operationId, { completion: "failed" });
        } catch {}
        emit({
          type: "command_failed",
          operationId: request.operationId,
          error: String(error.message ?? error),
        });
      });
  } else if (command.type === "abort") {
    devin.cancel(command.runId);
  } else if (command.type === "rename") {
    session.name = command.name;
    emit({ type: "session_info_changed", state: state() });
  } else if (command.type === "configure") {
    if (command.model) {
      if (typeof command.model.id !== "string" || !command.model.id)
        throw new Error("Invalid model");
      // The Pi catalog is unavailable, so the app sends model names as free
      // text. Accept anything and best-effort forward it to the agent.
      const known = MODELS.find((m) => m.id === command.model.id);
      session.model = known ?? {
        provider: command.model.provider ?? "devin",
        id: command.model.id,
        name: command.model.id,
        input: ["text", "image"],
      };
      if (!known && devin.sessionId) {
        devin
          .call("session/set_config_option", {
            sessionId: devin.sessionId,
            configId: "model",
            value: command.model.id,
          })
          .catch((error) => say("model configure ignored:", error.message));
      }
      emit({ type: "model_select", state: state() });
    }
    if (command.thinking !== undefined) {
      session.thinking = command.thinking;
      emit({ type: "thinking_level_select", state: state() });
    }
  } else if (command.type === "compact") {
    // Devin manages its own context; nothing to compact remotely.
    try {
      ledger.record(request.operationId, { completion: "completed" });
    } catch {}
    emit({ type: "session_compact", state: state() });
    emit({
      type: "command_completed",
      operationId: request.operationId,
      outcome: "completed",
    });
  } else if (command.type === "reload") {
    try {
      ledger.record(request.operationId, { completion: "completed" });
    } catch {}
    emit({ type: "command_completed", operationId: request.operationId });
  }
  return { ...receipt, state: state() };
}

// ---------------------------------------------------------------------------
// Transport: unix-socket JSON-lines server, same envelope as Pi's adapter.
// ---------------------------------------------------------------------------
// Only remove a stale socket: one that exists but refuses a connection. A
// socket that answers could belong to a healthy bridge, like Pi's adapter.
function clearStaleSocket(cb) {
  fs.access(socketPath, fs.constants.F_OK, (err) => {
    if (err) return cb();
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      say(`socket ${socketPath} already has a live listener; exiting`);
      process.exit(1);
    });
    probe.once("error", () => {
      try {
        fs.unlinkSync(socketPath);
      } catch {}
      cb();
    });
  });
}

function main() {
  ledger.open();
  session.writeHeader();

  clearStaleSocket(() => {
    const server = net.createServer((peer) => {
      if (peers.size >= 4) {
        peer.destroy();
        return;
      }
      peers.add(peer);
      peer.on("error", () => {});
      peer.on("close", () => peers.delete(peer));
      peer.setEncoding("utf8");
      let buffer = "";
      let inFlight = 0;
      peer.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > FRAME_BYTES) {
          peer.destroy();
          return;
        }
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (++inFlight > 16) {
            peer.destroy();
            return;
          }
          let request;
          try {
            request = JSON.parse(line);
            if (
              !request ||
              Array.isArray(request) ||
              typeof request !== "object" ||
              typeof request.id !== "string" ||
              !TOKEN.test(request.id)
            ) {
              throw new Error("Invalid request envelope");
            }
          } catch {
            peer.destroy();
            return;
          }
          Promise.resolve()
            .then(() => handleRequest(request))
            .then(
              (result) =>
                send(peer, { type: "response", id: request.id, ok: true, result }),
              (error) =>
                send(peer, {
                  type: "response",
                  id: request.id,
                  ok: false,
                  error: String(error.message ?? error),
                  dispatch: error.dispatch ?? "not_attempted",
                }),
            )
            .finally(() => {
              inFlight--;
            });
        }
      });
    });
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {}
      say(`ready: ${socketPath}`);
      say(`session ${session.id} in ${session.cwd}`);
      emit({ type: "session", state: state() });
    });
    server.on("error", (error) => {
      say("socket error:", error.message);
      process.exit(1);
    });

    const shutdown = () => {
      say("shutting down");
      for (const peer of peers) peer.destroy();
      server.close();
      try {
        devin.child?.kill("SIGTERM");
      } catch {}
      ledger.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });

  // Node does not kill spawned children on exit: leave no orphaned `devin acp`
  // (and its MCP children) behind when this process dies abruptly.
  process.on("exit", () => {
    try {
      devin.child?.kill("SIGTERM");
    } catch {}
  });
  process.on("uncaughtException", (error) => say("uncaught:", error.stack ?? error));
  process.on("unhandledRejection", (error) =>
    say("unhandled rejection:", error?.stack ?? error),
  );
}

main();
