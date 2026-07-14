# Worker split next steps

## Goal

Split telepi into a thin Telegram gateway and per-run workers so gateway restarts do not kill busy pi runs. The gateway should become a sturdy edge/supervisor: it connects to Telegram, routes updates, manages worker processes, and rate-limits Telegram delivery. Feature-heavy pi/runtime behavior should move into workers.

This design intentionally does **not** require a durable event log at first. It targets gateway restart resilience, not host-crash or worker-crash recovery.

## Working assumptions

- One worker per active topic run/message.
- A worker owns the pi RPC process/session for that run.
- The gateway owns Telegram polling and decides which topic is busy.
- The gateway owns worker lifecycle for workers it spawned.
- During gateway restart, active workers keep running and buffer unacknowledged gateway events in memory.
- During gateway restart, steering/cancel may be briefly unavailable; that is acceptable.
- If the worker or host dies, in-memory buffered events may be lost; solving that later would require a durable outbox.

## Target shape

### Gateway responsibilities

- Claim singleton gateway ownership before polling Telegram.
- Bind the worker IPC endpoint.
- Spawn workers for new topic runs.
- Adopt already-running workers after restart.
- Route incoming Telegram updates:
  - new message to idle topic: start worker;
  - message/reaction/button for busy topic: send control message to worker;
  - unavailable worker/control path: queue or reject according to existing semantics.
- Deliver Telegram output or delivery requests through the existing gateway-side rate limiter.
- Stop polling promptly on graceful shutdown.
- Drain or hand off workers on shutdown instead of killing them by accident.

### Worker responsibilities

- Start and own the pi RPC client/process.
- Convert pi events into a small worker protocol.
- Keep unacknowledged outbound events in memory until gateway acks them.
- Reconnect to the gateway IPC endpoint after disconnect.
- Resend unacknowledged events after reconnect.
- Accept control messages from gateway: steer, abort/cancel, possibly status.
- Exit only when the run is done, cancelled, or unrecoverably failed.

## IPC

Prefer a Unix domain socket over stdout pipes.

Suggested path:

```text
.telepi/gateway.sock
```

Stdout/stderr should remain logs/debug output, not the authoritative messaging stream. A restarted gateway cannot reattach to a dead stdout pipe; a reconnecting socket protocol is a better match.

### Protocol sketch

All messages can be newline-delimited JSON.

Worker to gateway:

```json
{"v":1,"type":"hello","runId":"...","topicKey":"chat:topic","pid":1234,"lastSeq":12}
{"v":1,"type":"event","runId":"...","seq":13,"event":{"type":"assistant_text","text":"..."}}
{"v":1,"type":"done","runId":"...","seq":14,"ok":true}
```

Gateway to worker:

```json
{"v":1,"type":"ack","runId":"...","seq":13}
{"v":1,"type":"control","runId":"...","action":"steer","envelope":{}}
{"v":1,"type":"control","runId":"...","action":"abort"}
```

Protocol rules:

- `runId` identifies one worker run.
- `seq` is monotonic per run for worker-originated events.
- Gateway acks only after it has accepted responsibility for the event.
- Worker keeps `seq > lastAckedSeq` in memory.
- On reconnect, worker sends `hello`, then resends unacked events.
- EOF/disconnect is not completion. `done` is completion.

## Minimal disk state

Avoid a durable event log for the first version. Keep only small process/adoption metadata.

Suggested per-run file:

```text
.telepi/workers/<runId>.json
```

Contents:

```json
{
  "runId": "...",
  "pid": 1234,
  "topicKey": "chat:topic",
  "agent": "...",
  "sessionId": "...",
  "startedAt": "..."
}
```

This is not a queue. It is for restart adoption, duplicate prevention, observability, and cleanup.

A `pid.lock` alone is close but too opaque. The extra metadata lets the new gateway mark topics busy before workers reconnect.

## Gateway restart / handoff

Need exactly one active Telegram poller.

Use a gateway singleton lock/lease, e.g.

```text
.telepi/gateway.lock
```

Graceful restart path:

1. Old gateway receives shutdown signal.
2. Old gateway stops Telegram polling immediately.
3. Old gateway stops accepting new updates/runs.
4. Old gateway closes or drains worker IPC so workers reconnect.
5. New gateway claims gateway lock.
6. New gateway binds `.telepi/gateway.sock`.
7. New gateway scans `.telepi/workers/*.json` and marks live PIDs/topics as busy.
8. New gateway waits a short grace period for worker `hello` messages.
9. New gateway starts Telegram polling.

Important race: the new gateway must not start a second worker for a topic whose old worker is still alive but has not reconnected yet. Treat live worker metadata as busy until the PID is gone or adoption times out.

## What this does and does not solve

Solves:

- gateway code can be thinner and safer;
- gateway restart does not automatically kill active pi runs;
- workers can keep running while gateway restarts;
- worker output is replayed across gateway reconnect as long as the worker process stays alive;
- feature complexity moves away from the Telegram poller.

Does not solve yet:

- host crash recovery;
- worker crash recovery;
- durable replay of worker output after worker death;
- exactly-once Telegram delivery for tools that send directly to Telegram instead of asking the gateway to send.

If those guarantees become necessary, add a durable outbox later. Until then, avoid SQLite/spool complexity.

## Incremental implementation plan

1. Extract current run state into a `WorkerRegistry` abstraction inside the gateway, without changing process boundaries.
2. Define the NDJSON worker protocol and pure encode/decode/validation helpers with tests.
3. Add a worker CLI mode that can run one topic message and speak the protocol over stdio in a local harness.
4. Replace stdio with Unix socket reconnect logic.
5. Add per-run metadata files and live-PID adoption on gateway startup.
6. Teach gateway restart/shutdown to stop polling before handing workers off.
7. Move one output path at a time behind gateway-owned delivery requests.
8. Only after the split is stable, decide whether a durable outbox is worth adding.
