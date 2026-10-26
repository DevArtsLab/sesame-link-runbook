# Sesame Link "Pi" control protocol

The contract a process must satisfy to act as a Pi runtime for Sesame Link,
reverse-engineered from the adapter sources embedded in the `sesame-link`
binary (`extension.ts`, `adapter.mjs`, `transport.mjs`, `ledger.mjs`). The
bridge in this repo implements it; any other agent could too.

## Spawn contract

The daemon extracts its embedded adapter files into a per-session directory
and launches:

```
pi --offline --append-system-prompt <dir>/remote-guidance.txt \
   -e <dir>/extension.ts --session-dir <dir>/history
```

Environment:

| Variable                    | Meaning                                            |
| --------------------------- | -------------------------------------------------- |
| `SESAME_PI_ADAPTER_DIR`     | the session dir; must be owner-only (0700)         |
| `SESAME_PI_CONTROL_SOCKET`  | unix socket the endpoint must listen on (optional; default `<dir>/control.sock`) |

Readiness: the daemon connects to the socket and issues requests until
`startup` (and usually `state`) answer. Absence for ~20s fails the session
with `503 dependency_unavailable`.

## Wire format

Newline-delimited JSON over the unix socket. The endpoint is the server; the
daemon is the client (up to 4 peers, 16 in-flight requests per peer, 1 MiB
frames).

```
request:   { "id": "<token>", "type": "<command>", ... }
response:  { "type": "response", "id": "<same>", "ok": true,  "result": <any> }
           { "type": "response", "id": "<same>", "ok": false,
             "error": "<message>", "dispatch": "not_attempted"|"unknown" }
event:     { "type": "event", "epoch": "<uuid>", "seq": <n>,
             "sessionId": "<id>", "data": { "type": "...", ... } }
```

- `id`/`operationId` tokens match `^[a-zA-Z0-9_-]{1,100}$`.
- `dispatch`: `not_attempted` = the command provably never ran;
  `unknown` = it was journaled, outcome is recoverable from the journal only.

## Requests

| Type            | Session ctx required | Purpose                                              |
| --------------- | -------------------- | ---------------------------------------------------- |
| `startup`       | no                   | `{protocol:1, epoch, started, projectTrust, answered}`|
| `project_trust` | no                   | answer a pending folder-trust question               |
| `state`         | yes                  | full session state snapshot                          |
| `events`        | yes                  | replay: `{epoch, after}` -> `{events, next, head}`   |
| `models`        | yes                  | model catalog `[{provider,id,name,reasoning,input}]` |
| `deliveries`    | yes                  | map `operationId -> entryId` for delivered ops       |
| `operation`     | yes                  | journal record for one `operationId`                 |
| `history`       | yes                  | paged session entries `{source, leafId, entries, next, complete}` |
| `submit`        | yes                  | deliver a prompt `{text, images?, mode: steer|followUp}` |
| `abort`         | yes                  | interrupt run `{runId}`                              |
| `rename`        | yes                  | set session name                                     |
| `configure`     | yes                  | set model `{provider?,id}` and/or thinking level     |
| `compact`       | yes                  | compact context (requires `idle_observed`)           |
| `reload`        | yes                  | reload extensions (requires `idle_observed`)         |

All mutations require `sessionId` matching the session's and a valid
`operationId`. Retries with the same `operationId` are deduped by digest.

## `state` shape

```
{ protocol: 1, epoch, seq, sessionId, sessionFile, leafId, cwd, name,
  model: {provider, id, name, input}, thinking,
  activity: "idle_observed"|"running"|"waiting_native"|"unsettled",
  piReportedIdle, pendingMessages, runId, activeTools: [...],
  capabilities: { imageInput, prompt, steer, followUp, interrupt,
                  nativeTerminal, durableHistory, configure,
                  exactDeliveryReceipt, atomicNativeAdmission,
                  remoteNativeDialogs, linkPermissionEnforcement } }
```

## Submit lifecycle (events)

```
command_attempted  -> input            -> message_end (user)
                   -> command_delivered{operationId, entryId}
                   -> before_agent_start -> agent_start
                   -> message_update{text_delta|thinking_delta, delta} ...
                   -> message_end (assistant, stopReason)
                   -> agent_end{endedRunId, state} -> agent_settled
                   -> command_completed{operationId, outcome}
                      (outcome: completed | interrupted | failed; failures use command_failed)
```

## Attempt journal (`attempts.jsonl`)

Append-only JSONL in the adapter dir, `fsync`ed. Two record kinds:

```
{version:1, operationId, digest, sessionId, command, attemptedAt, delivery:"unknown"}
{version:1, operationId, outcome:{delivery:"delivered",entryId} | {completion}}
```

`digest` = sha256 of the canonicalized command; a reused `operationId` must
carry an identical command. Outcomes are published to events only after the
journal holds them.

## Session history file

JSONL whose first line is `{type:"session", id, ...}` (the daemon validates
the id against `sessionId`), followed by entries
`{id, parentId, type:"message", message:{role, content}}` forming a linear
parent chain. `history` requests page this file via `leafId`/`after`/`limit`.
