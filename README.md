# Sesame Link

Working notes and runbook for [Sesame Link](https://link.sesame.com): the
companion that runs coding sessions on a local machine and makes them
reachable from the Sesame web app on any device.

This is unrelated to Sesame Voice Capture (see `../sesame-voice-escort`).
Voice Capture moves audio in; Sesame Link moves terminal sessions out.

## Contents

- [What it does](#what-it-does)
- [Install and sign-in](#install-and-sign-in)
- [Architecture](#architecture)
- [TLS inspection (the one real gotcha)](#tls-inspection-the-one-real-gotcha)
- [Security posture](#security-posture)
- [Command reference](#command-reference)
- [Daily workflows](#daily-workflows)
- [Troubleshooting](#troubleshooting)
- [Next steps](#next-steps)

## What it does

- Runs agent runtimes (Claude Code, Codex, Pi, Cursor) in tmux on this machine.
- Exposes those sessions to `link.sesame.com` over an outbound websocket, so a
  phone or laptop can start, watch, and steer them.
- Sessions survive disconnects (tmux underneath); you can attach locally with
  `sesame-link sessions` or remotely from the web app.
- Sessions link their work to GitHub PRs through the local `gh` CLI when
  `pull-requests` is enabled.

## Install and sign-in

```bash
curl -fsSL https://storage.googleapis.com/sesame-link/install.sh | sh
sesame-link auth login      # prints a code + link; approve in the browser
```

Requirements: macOS or Linux, tmux >= 3.4 for sessions, plus at least one
runtime on PATH (`claude`, `codex`, etc.). The installer verifies the
Developer ID signature of the downloaded binary.

After sign-in the daemon starts, registers this machine on the account, and is
set to launch at login.

State lives in `~/.local/state/sesame-link/`:

```
auth/production.json            sign-in credential (30-day validity)
remote-access.json              what remote clients may do (see below)
daemon.log                      service log (sesame-link logs)
daemon.lock                     lifecycle lock
machine/credential              machine credential used for the gateway channel
api.sock, api-token             local IPC socket + token for CLI <-> daemon
sessions/, ended-sessions/      live and ended session records
idempotency/                    dedupe keys for remote requests
daemon-intent.json              desired running/stopped state
daemon-launch.json              options the daemon was started with
daemon-launch-limits-current    launch limits in effect
daemon-lifecycle.lock           start/stop serialization
daemon-service-ready            readiness marker
management-environment          resolved service environment
recent-working-directories.json recent session working dirs
session-host.command            helper for session hosting
```

## Architecture

```
browser/phone (link.sesame.com)
        |
        v
sesame-link session service (HTTPS + WSS)
        |
        v  outbound only, no inbound ports
sesame-link daemon -> tmux -> claude / codex / pi / cursor
```

The daemon holds one outbound websocket to
`wss://sesame-link-session-service.fly.dev/v1/gateway/machine`. All remote
control rides that channel; nothing listens on the LAN.

In more detail, on this machine:

```
link.sesame.com (browser / phone)
        |  HTTPS + WSS
        v
sesame-link-session-service.fly.dev   auth API + wss gateway relay
        |  one outbound websocket: /v1/gateway/machine
        v
sesame-link daemon (Rust, launchd, ~/.local/bin/sesame-link)
   |-- gateway ws channel, session lifecycle, launch at login
   |-- local IPC: api.sock + api-token
   |-- state: ~/.local/state/sesame-link/ (0700)
   |        auth/production.json  machine/credential  remote-access.json
   |-- spawns / attaches tmux -> runtime sessions
   |        claude (Claude Code)  codex  pi  cursor
   +-- local tools: gh CLI -> GitHub PRs; runtime executables on PATH
```

Versions drift constantly; `sesame-link status` shows the current daemon,
runtime, and tmux versions.

### Flows

```
REMOTE PATH   phone/browser -> session service -> gateway ws -> daemon
              -> tmux -> runtime        (keystrokes in, terminal out)

LOCAL PATH    terminal -> `sesame-link claude` or `sessions` -> tmux attach
              (bypasses the cloud entirely)

HANDOFF PATH  inside Claude Code: /open-sesame
              -> local conversation moves into a Link-hosted tmux session
              -> becomes reachable from link.sesame.com

PR PATH       session work -> local `gh` -> GitHub PRs surfaced in web app
              (only when `pull-requests` config toggle is on)
```

### Trust boundaries

| Boundary           | Control                                                       |
| ------------------ | ------------------------------------------------------------- |
| remote -> machine  | `remote-access.json` allowlists (see Security posture)        |
| machine -> service | outbound-only WSS; `machine/credential` + 30-day sign-in      |
| revocation         | `sesame-link unpair`; sign-in expires in 30 days              |
| TLS inspection     | embedded webpki roots; needs Do-Not-Inspect rules (see below) |

## TLS inspection (the one real gotcha)

`sesame-link` is a Rust binary built on `hyper-rustls` with `webpki-roots`: a
fixed Mozilla CA bundle compiled in. It does **not** read the OS trust store,
and rustls ignores `SSL_CERT_FILE`. On any network doing TLS interception
(Cloudflare Gateway/WARP, Zscaler, Netskope), every HTTPS call fails
certificate validation and the CLI reports a misleading
"couldn't reach Sesame" — the service is fine, the binary just can't verify
the inspected chain.

Diagnosis recipe:

```bash
curl -Iv https://sesame-link-session-service.fly.dev
# If the cert issuer is a Gateway/proxy CA instead of a public CA,
# TLS inspection is active on this network.
```

Client-side there is no fix — the root store is baked into the binary. The
durable fix is a **Do Not Inspect** policy at the proxy for:

- `sesame-link-session-service.fly.dev` — auth API and the persistent
  `wss://` gateway channel (needed continuously, not just at login)
- `storage.googleapis.com` — release downloads and `sesame-link update`

On Cloudflare Zero Trust that is a Gateway HTTP rule with action
`off`/`Do Not Inspect` and a `http.conn.hostname` selector, placed ahead of
any inspect or security-category rules. Disconnecting the inspection client
only until sign-in works does **not** help: the daemon's websocket fails again
the moment inspection resumes.

Upstream improvement worth reporting: ship `rustls-native-certs` so the
binary merges OS roots like every other tool. Same failure class documented
for Python in `../sesame-voice-escort` (fixed there with a merged CA bundle).

## Security posture

`remote-access.json` in the state directory defines what remote clients may
do on this machine. Defaults observed on this install:

| Setting                                            | Meaning                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `allow_remote_bash_commands: false`                | browsers cannot run arbitrary shell                                  |
| `allow_claude_persistent_directories/rules: false` | sessions cannot permanently widen their own scope                    |
| `allowed_permission_modes`                         | `manual`, `acceptEdits`, `plan`, `auto`, `dontAsk` are all permitted |
| `allowed_remote_runtimes`                          | `claude_code`, `codex`, `pi`, `cursor`                               |
| `allowed_remote_slash_commands`                    | `compact`, `clear`, `context`, `reload-skills`                       |
| `allowed_codex_sandbox_policies`                   | `read_only`, `workspace_write`                                       |
| `allowed_codex_approval_policies`                  | `untrusted`, `on_request`                                            |
| `allowed_codex_approval_reviewers`                 | `user`, `auto_review`                                                |
| `allow_codex_execpolicy_amendments: false`         | sessions cannot widen Codex exec policy                              |
| `allow_codex_network_policy_amendments: false`     | sessions cannot widen Codex network policy                           |
| `allow_codex_persistent_approvals: false`          | Codex approvals do not persist                                       |
| `allowed_codex_filesystem_roots`                   | empty: no extra filesystem roots                                     |
| `allowed_codex_network_destinations`               | empty: no extra network destinations                                 |
| `allowed_cursor_approval_modes`                    | `allowlist`, `auto_review`                                           |

Runtime toggles via `sesame-link config <setting> on|off`:
`claude-mod`, `error-reporting`, `remote-update`, `thinking`,
`pull-requests`.

Hardening suggestions:

- Drop `dontAsk` (and `auto`, if unused) from `allowed_permission_modes` for
  unattended sessions; `manual`/`plan`/`acceptEdits` keeps remote approval in
  the loop.
- Keep `allow_remote_bash_commands` off; it is the highest-blast-radius switch.
- The sign-in is valid 30 days and the machine credential rotates
  independently; `sesame-link unpair` revokes the machine entirely.
- The state directory is owner-only (`0700`); keep it that way.

## Command reference

| Command                                             | Purpose                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `sesame-link auth login`                            | sign in, add this machine (prints a code to verify in the browser) |
| `sesame-link status [--verbose]`                    | daemon, connection, runtimes, version                              |
| `sesame-link start / stop / restart`                | daemon lifecycle                                                   |
| `sesame-link serve`                                 | run in the foreground (debugging)                                  |
| `sesame-link logs`                                  | tail the daemon log                                                |
| `sesame-link sessions`                              | list, attach, create, delete sessions                              |
| `sesame-link claude` (also `codex`, `pi`, `cursor`) | start a runtime session in this folder                             |
| `sesame-link open-sesame`                           | move the enclosing Claude Code conversation into a Link session    |
| `sesame-link install-claude-command`                | installs `/open-sesame` for Claude Code                            |
| `sesame-link connect`                               | link a browser or another client                                   |
| `sesame-link machine`                               | manage this machine and others on the account                      |
| `sesame-link unpair`                                | remove this machine from the account                               |
| `sesame-link doctor`                                | check and repair the installation                                  |
| `sesame-link diagnostics`                           | bundle logs/state into an archive for support                      |
| `sesame-link setup`                                 | check this machine's setup and offer to install `/open-sesame`     |
| `sesame-link update`                                | self-update the binary                                             |
| `sesame-link config`                                | view/change settings toggles                                       |
| `sesame-link uninstall`                             | stop, unpair, remove                                               |

## Daily workflows

- **Continue desk work from the phone:** run `/open-sesame` inside a local
  Claude Code session, then open the web app anywhere.
- **Kick off remote work:** in the web app, start a session and give an
  absolute path on this machine (e.g. `~/projects/<repo>`) as the working
  directory.
- **Attach locally:** `sesame-link sessions` shows a picker; sessions are tmux
  under the hood.
- **Watch a session's PRs:** with `pull-requests` on, sessions surface the
  PRs they open or push to, resolved through the local `gh`.

## Troubleshooting

| Symptom                                   | Likely cause                                              | Fix                                                                          |
| ----------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| "Couldn't reach Sesame" on `auth login`   | TLS inspection vs embedded webpki roots                   | Do-Not-Inspect rule (see above); verify issuer with `openssl s_client`       |
| `status` says "running but not answering" | stale daemon                                              | `sesame-link restart`; check `logs`                                          |
| "tmux isn't installed"                    | daemon started with a different PATH than the login shell | install tmux, then `sesame-link restart` so the tmux server re-inherits PATH |
| Runtime shows `unavailable`               | missing executable                                        | install `claude`/`codex`/etc., or pass an explicit executable flag           |
| Login lock errors                         | stale `auth/login.lock`                                   | remove the lock file and retry                                               |
| Web app can't see sessions                | remote access off or machine revoked                      | `remote-access.json` -> `remote_access_enabled`, else `auth login` again     |

`sesame-link diagnostics` produces the bundle to send when asking for help.

## Next steps

1. Run `sesame-link install-claude-command` so `/open-sesame` is available.
2. Tighten `allowed_permission_modes` in `remote-access.json` before
   unattended use (drop `dontAsk`/`auto`).
3. Add a second runtime (e.g. Codex) if multi-agent sessions are wanted.
4. Report the missing native-roots issue upstream; note the Do-Not-Inspect
   rule in the org's infra docs so it survives policy changes.
5. Keep the sign-in rotation in mind (30 days); `doctor` flags an expired
   credential.

## Privacy note for publishing

This file is safe to publish: it contains no account IDs, machine IDs,
sign-in tokens, credentials, or user paths. Do not paste the contents of
`auth/production.json`, `machine/credential`, or `remote-access.json`
verbatim into public docs — the first two are live secrets and the third
contains a machine identifier.
