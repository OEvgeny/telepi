# Lean gateway and worker split

## Decision

Keep the gateway as Telegram's single receiver and single sender, but remove pi, session, queue, retry, compaction, and run-lifecycle decisions from the long-lived gateway process.

Use three process roles:

1. **Gateway** — Telegram transport plus durable ingress/egress.
2. **Reconciler** — a short one-shot process that reads disk state and decides what a topic should do next.
3. **Run worker** — one separate systemd user unit for one active pi run. It owns the RPC client until that run settles.

Disk state is the source of truth. Unix sockets may wake processes or reduce polling latency, but correctness must not depend on an open socket, stdout pipe, or in-memory queue.

This replaces the earlier proposal to buffer worker events only in memory. Recent failures show that a small durable spool is needed in the first useful version, not as a later enhancement.

## Why the current shape fails

`src/gateway.js` currently combines all of these jobs:

- Telegram polling, authorization, update normalization, media download, callback answers, and sending;
- global Telegram pacing, formatting, splitting, edits, reactions, typing, and cancel-button maintenance;
- topic routing, busy detection, steering, pending queues, retry memory, and prompt-inbox claiming;
- pi RPC startup, event interpretation, transcript-tail recovery, cancellation, and settlement;
- model-error classification, automatic session unlink/retry, and compaction subprocesses;
- debug snapshots and sent-message indexing.

That coupling has produced concrete failure modes:

- A gateway crash killed active image-generation pi/tool processes because they shared `telepi-gateway.service`'s cgroup.
- Detached long-running service supervisors remained in the gateway cgroup even after reparenting. They now prevent a drain-first restart and would be killed by a forced restart.
- Busy, pending, steered, retry, cancel, typing, and reply-anchor state lives in memory. `gateway-inflight-debug.json` explicitly is not restored.
- Telegram updates can be confirmed while their queued/steered work exists only in memory. A crash can therefore lose accepted work.
- The prompt inbox deletes a file after dispatch, not after durable acceptance or completion.
- `topic:prompt` can bypass the gateway's `inFlight` map and open the same session concurrently, producing competing transcript branches.
- A long provider timeout can keep a topic busy for many minutes while later messages accumulate behind opaque retries. Process success is not the same as model success.
- Typing is driven by a gateway interval tied to an in-memory run object, so cleanup wedges can display activity that says nothing useful about worker health.
- Shared and agent-specific Telegram tools send directly with per-process rate limiters. The gateway is therefore not actually the single sender, and aggregate flood control is impossible.
- A restarted gateway cannot reattach to a worker's stdout pipe. A reconnecting socket alone still loses in-memory output if either side dies.

The gateway is not primarily failing because it is one large file. It fails because transport ownership, run ownership, and durable acceptance are the same lifecycle.

## Target responsibilities

### Gateway: transport only

The gateway should:

- hold the bot token and singleton Telegram polling lease;
- fetch updates, authorize users, normalize transport metadata, and download attachments;
- durably write each accepted inbound envelope before advancing the saved Telegram offset;
- answer callback queries promptly and write their requested action to ingress/control state;
- watch the delivery spool and perform every Telegram send/edit/reaction/upload through one fair global limiter;
- record Telegram receipts and sent-message routing metadata;
- emit short-lived typing leases only while a live worker requests them;
- kick a reconciler after durable ingress and on startup;
- expose transport health.

It should not:

- import the pi SDK or `src/pi-session.js`;
- own an RPC client, pi PID, transcript cursor, session lock, model error, or compaction decision;
- decide whether a message is steering versus queued;
- retain the authoritative topic queue in a JavaScript `Map`;
- interpret raw pi events beyond validating a versioned delivery request;
- spawn maintained services or long-lived run workers as children of its own systemd unit.

Telegram formatting and splitting remain gateway responsibilities because they are properties of the transport.

### Reconciler: short decision worker

A reconciler invocation should:

- scan one topic or all dirty topics;
- acquire an atomic per-topic reconciliation lock;
- read current route/config, topic state, session lock state, queued envelopes, worker unit state, heartbeats, and receipts;
- validate the active worker by systemd unit plus invocation identity, never PID alone;
- deliver a steering/control envelope to a worker that is explicitly accepting it;
- otherwise leave the envelope queued;
- start the next run or maintenance worker as a separate systemd user unit when both topic and session are idle;
- finalize completed/interrupted runs and kick the next queued item;
- exit once state is stable.

Multiple reconciler processes may overlap. Atomic claims and locks must make that harmless. A second reconciler should wait briefly or leave a wake marker rather than silently abandoning work.

### Run worker: one pi lifecycle

A run worker should:

- read a sealed run descriptor from disk;
- acquire the session lock for its whole RPC lifetime;
- start and own pi RPC using the current `src/pi-session.js` logic;
- write heartbeat and phase state independently of pi event silence;
- poll or receive durable controls for steer and abort;
- acknowledge steering only after `client.steer()` has accepted it;
- translate pi events into a small semantic delivery protocol;
- classify `stopReason: "error"` as failure even if pi exits with code 0;
- use transcript watermarks for the existing persisted-final-answer fallback;
- write an atomic terminal result, release the session lock, kick reconciliation, and exit.

A run worker may last hours if a legitimate tool does. It is still bounded to one run and belongs in its own systemd unit/slice, outside `telepi-gateway.service`.

### Maintenance worker

Compaction, unlink/recovery, and similar SDK-backed operations use the same session lock and separate worker boundary. `/compact` becomes an inbound command that the reconciler starts only when the session is idle. This preserves the existing rule that the long-lived gateway must not cache pi's SDK/model catalog.

## Runtime state

All runtime state belongs under a gitignored, mode-`0700` directory:

```text
.telepi/runtime/
  telegram-offset.json
  ingress/<update-id>.json
  updates/<update-id>.json
  topics/<topic-key>/
    route.json
    state.json
    inbox/<envelope-id>.json
    controls/<control-id>.json
    accepted/<envelope-id>.json
  sessions/<session-key>/lock/
  runs/<run-id>/
    descriptor.json
    state.json
    result.json
  delivery/
    pending/<request-id>.json
    sending/<request-id>.json
    sent/<request-id>.json
    failed/<request-id>.json
```

Use write-to-temp plus atomic rename for records. Use atomic directory creation for claims/locks. Records need a schema version. An actionable envelope exists in exactly one queue directory: reconciliation renames it from global `ingress/` into a topic `inbox/`, never copies it into two authoritative queues. `updates/` holds only deduplication/classification receipts after an update leaves global ingress.

### Topic state

Suggested `state.json`:

```json
{
  "v": 1,
  "topicKey": "opaque-topic-key",
  "phase": "idle",
  "runId": null,
  "workerUnit": null,
  "workerInvocation": null,
  "workerPid": null,
  "sessionId": "session-id",
  "currentEnvelopeId": null,
  "acceptsSteering": false,
  "queueDepth": 0,
  "startedAt": null,
  "heartbeatAt": null,
  "lastResult": null
}
```

PID is diagnostic only. PID reuse makes it unsafe as an ownership proof. Validate the systemd unit and invocation ID, and include the host boot ID where useful.

### Run descriptor

The descriptor freezes the inputs needed for one run: run ID, topic key, agent, session ID, entity directory, model, skills/extensions, initial envelope ID, transcript watermark, and configured timeouts. It must contain data, not an arbitrary shell command.

### Inbound envelope

Each envelope has a stable ID derived from Telegram `update_id` plus message/callback identity. Replayed updates become no-ops after checking global ingress, topic queues, active run descriptors, and terminal update receipts.

The gateway saves the next Telegram offset only after every lower update has either:

- been durably written to ingress/topic inbox; or
- been durably classified as ignored/handled transport-only.

On restart, the gateway resumes from the saved offset and safely deduplicates Telegram replays.

## Queue and steering semantics

Durable ingress is the queue. Do not copy it into another authoritative in-memory queue.

For an idle topic:

1. Reconciler claims the oldest envelope.
2. It acquires the session lock or leaves the envelope queued.
3. It writes a run descriptor and starting state.
4. It starts `telepi-worker@<run-id>.service` through systemd.
5. The worker confirms running state before the claim is finalized.

For a busy topic:

1. If worker state says `acceptsSteering`, reconciler writes a control referencing the original envelope ID.
2. Worker calls `client.steer()` and atomically writes an accepted receipt.
3. Only that receipt marks the inbound envelope consumed.
4. If the worker settles first, the unaccepted envelope remains queued for the next run.

This is the durable equivalent of today's `run.steered` replay logic.

A session lock is separate from a topic lock. Two topic mappings or a direct CLI command must never open the same session concurrently. `topic:prompt` should enqueue through this path by default; an offline/direct mode must require an explicit flag and the same session lock.

`/retry` derives its source envelope from durable ingress/history, not `lastPromptByTopic` memory.

## Gateway-owned delivery

Workers should emit semantic requests, not call Telegram:

```json
{"v":1,"id":"...","runId":"...","kind":"text","chatId":"...","topicId":"...","replyTo":"...","text":"..."}
{"v":1,"id":"...","runId":"...","kind":"photo","chatId":"...","topicId":"...","path":"...","caption":"..."}
{"v":1,"id":"...","runId":"...","kind":"buttons","chatId":"...","topicId":"...","text":"...","buttons":[]}
{"v":1,"id":"...","runId":"...","kind":"typing_lease","topicKey":"...","validUntil":"..."}
```

The gateway claims delivery files, applies one global paced/fair queue, sends them, and records Telegram message IDs in receipts. Tool calls that need the result wait for the receipt; a gateway restart merely pauses them.

Migrate these output paths:

1. assistant/reasoning/tool display text;
2. shared `telepi_send_image` and `telepi_buttons`;
3. agent-specific generators/upscalers and any direct Bot API calls.

During migration, direct-send tools must be explicitly marked as legacy because they bypass global ordering and replay.

A filesystem spool gives at-least-once delivery. Telegram has no idempotency key for `sendMessage`, so a crash after Telegram accepts a send but before the receipt is written is inherently ambiguous and may duplicate once. Keep `sending/` records and surface that state; do not claim exactly-once delivery. Edits and reactions with known message IDs are easier to retry safely.

Typing uses expiring worker leases. If heartbeats or leases stop, the gateway stops refreshing typing automatically. “Worker process alive” and “model currently producing output” should be reported separately.

## Restart and recovery

### Gateway restart

Once workers are separate systemd units and ingress/egress is durable:

1. Gateway stops polling and releases any delivery claim.
2. Workers continue; output accumulates in `delivery/pending`.
3. New gateway resumes the saved Telegram offset.
4. It recovers `sending` records, drains pending output, and kicks reconciliation.
5. It resumes valid typing leases from live worker state.

No worker adoption socket is required for correctness. A Unix socket may provide wakeups and live events, but workers must tolerate it disappearing.

### Worker crash

Reconciler compares worker unit state, result, transcript watermark, and accepted controls:

- initial user message not persisted: requeue automatically;
- user persisted but no terminal result: mark interrupted and require an explicit retry policy;
- terminal assistant/result persisted: finalize and deliver any missing durable output;
- accepted steering without completion: preserve it in recovery state rather than losing it.

Do not infer a stuck worker from silent pi events. The worker heartbeat proves process health while a phase field explains whether it is waiting on model, tool, delivery receipt, or settlement.

### Host reboot

Host reboot kills workers. On boot, stale run state is reconciled as interrupted. Automatic inference replay should remain conservative because tools may have had external side effects before the crash.

## Prompt inbox and commands

Prompt inbox polling does not belong in the gateway. Replace it with a small path/timer service that calls `telepi enqueue`; the source file is removed only after the envelope is durably accepted.

Gateway-native commands should be limited to transport/status concerns. `/compact`, `/retry`, and future maintenance actions become typed inbound envelopes handled by the reconciler/maintenance worker. Callback queries may receive an immediate transport acknowledgment while their action continues through durable control state.

## Observability

Add `telepi topic:status --topic <name>` backed entirely by runtime files. It should show:

- current run ID/unit/phase and heartbeat age;
- current Telegram message and session ID;
- whether steering/cancel is accepted;
- queued envelope IDs/count and oldest age;
- pending/sending/failed delivery count;
- last terminal result/model error;
- interrupted or ambiguous records needing attention.

This replaces the non-restored debug snapshot and makes queue state inspectable without attaching to the gateway process.

## Migration plan

### Phase 0 — safety prerequisites

- Move every maintained long-running service into its own systemd unit/scope outside the gateway cgroup.
- Add a shared session lock and make direct `topic:prompt`, compaction, and normal runs honor it.
- Define and test versioned state/envelope/delivery schemas plus atomic file helpers.
- Add `topic:status` before changing behavior.

### Phase 1 — durable ingress beside current dispatch

- Persist and deduplicate Telegram updates before advancing a saved offset.
- Mirror current busy/queue state into topic files.
- Route prompt-inbox and CLI prompts through the same ingress API.
- Keep current in-process dispatch temporarily, but make disk the accepted-work record.

### Phase 2 — gateway delivery spool

- Introduce one gateway-side transport scheduler.
- Move streamed assistant text and status output to delivery requests.
- Update shared Telegram tools to write requests and await receipts.
- Keep legacy direct agent tools temporarily, with explicit logging.

### Phase 3 — external run worker

- Extract `startPiForTopic` lifecycle into `telepi worker:run --run-id ...`.
- Launch it as a separate systemd user unit/slice, never as a gateway child.
- Move transcript polling, model-error classification, steering, abort, and settlement into the worker.
- Prove a gateway restart during a run does not stop pi and that queued output arrives afterward.

### Phase 4 — one-shot reconciler

- Move busy/queue/steer/retry/session decisions out of `gateway.js`.
- Gateway only writes ingress and kicks reconciliation.
- Move compaction and automatic recovery into typed maintenance workers.
- Remove `inFlight`, pending/steered arrays, retry memory, and pi imports from the gateway.

### Phase 5 — finish single-sender migration

- Convert agent-specific Telegram sends to the delivery bridge.
- Stop passing the bot token to run workers.
- Remove duplicate per-process Telegram rate limiters.
- Make gateway restart independent of worker drain.

## Required failure tests

Before calling the split complete, automate these cases:

1. Kill/restart gateway during model inference; worker and session continue.
2. Kill/restart gateway while output is pending; new gateway delivers it.
3. Crash gateway in the `sending` ambiguity window; state reports possible duplicate.
4. Send steering exactly as a worker settles; it is either accepted with a receipt or remains queued.
5. Run CLI prompt and Telegram prompt simultaneously for one session; only one holds the session lock.
6. Kill worker before and after the user message transcript watermark; recovery policy differs correctly.
7. Persist a model `stopReason: "error"` with process exit 0; result is failed and user-visible.
8. Stop worker heartbeats; typing lease expires without claiming the run completed.
9. Flood output from several topics; one global limiter remains fair and workers do not own Telegram sleeps.
10. Reboot with stale PID metadata; invocation/boot identity prevents false adoption.
11. Replay a Telegram update after crash; envelope deduplication prevents duplicate inference.
12. Start a maintained service from an agent tool; verification rejects it if it remains in the gateway/worker cgroup.

## Architectural guardrails

Keep the gateway thin after migration with enforceable boundaries:

- no import from pi SDK, `pi-session`, compaction, or model modules;
- no raw pi event parsing;
- no authoritative queue that exists only in memory;
- no bot token in workers after transport migration;
- no long-lived child process in the gateway cgroup;
- protocol/schema changes require versioned fixtures and restart/replay tests;
- sockets are optimization; disk records are correctness.
