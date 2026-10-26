# Sesame Devin Bridge

Work on the bridge that puts Devin Local behind Sesame Link's "Pi" runtime
slot. Use when debugging, extending, or reinstalling the bridge, or when a Pi
session on link.sesame.com misbehaves.

## Layout

- `bridge/devin-pi-bridge.mjs` — the endpoint: serves the Link control-socket
  protocol and drives `devin acp` (stdio JSON-RPC).
- `bridge/pi-shim` — source of truth for `~/.local/bin/pi`; dispatches
  `--version` to `devin version`, `SESAME_PI_ADAPTER_DIR`/`-e` launches to the
  bridge, everything else to `devin`.
- `bridge/PROTOCOL.md` — the reverse-engineered wire spec (requests, events,
  journal, history file).
- `bridge/test/smoke.sh` — spawns the bridge on a temp adapter dir and runs
  `link-client.mjs`; add `--submit` for a real devin prompt (costs ACUs).

## Key facts

- Sesame Link's Pi integration is NOT keystroke relay. The daemon extracts an
  embedded extension into the session dir, spawns
  `pi --offline --append-system-prompt <guidance> -e <ext> --session-dir <dir>`,
  and expects a unix-socket JSON-lines RPC to answer. If the socket never
  answers, sessions fail `503 dependency_unavailable` after ~20s.
- The bridge authenticates `devin acp` via `authenticate` `meta.api_key` read
  from `~/.local/share/devin/credentials.toml` (`windsurf_api_key`). `devin acp`
  deliberately ignores stored CLI creds and env vars.
- `devin acp` boots all configured MCP servers at spawn; first submit is slow.
- Permission prompts are auto-answered by `BRIDGE_PERMISSION_PICK` (default
  `allow_once`); `DEVIN_BIN`, `DEVIN_CREDENTIALS`, `NODE_BIN`,
  `BRIDGE_SCRIPT` env vars override defaults. A Pi session is shell access on
  the host; there is no sandbox — real isolation means a container or
  separate OS user.
- The daemon writes per-session files in the adapter dir: `extension.ts`,
  `adapter.mjs` (its own Pi adapter, unused by us), `mcp.json`,
  `remote-guidance.txt`, `mcp-capability`. The bridge consumes mcp.json and
  the guidance file.

## Debugging

- Daemon log: `~/.local/state/sesame-link/daemon.log`. Session pane:
  `tmux -L sesame-link capture-pane -p -t <session>` shows `[bridge]` lines.
- Every `pi` spawn is logged to
  `~/.local/state/sesame-link/pi-invocations.log` (args + SESAME_* env).
- Attempts journal: `<session dir>/attempts.jsonl` records
  delivery/completion outcomes per operationId.
- After editing the bridge or shim: `sesame-link restart` (runtime detection
  happens at daemon start); sessions already running keep their old bridge.

## Rollback

`rm ~/.local/bin/pi && sesame-link restart` removes the slot entirely.
