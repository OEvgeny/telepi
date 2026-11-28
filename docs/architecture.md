# Architecture

This is the stable shape of telepi. The `telepi-dev` skill keeps only the traps
that have caused real failures; this document explains how the pieces fit so a
change can be placed in the right one. When code and this page disagree, the
code wins — fix the page in the same change.

## Process model

`src/gateway.js` is the single long-lived broker. It receives Telegram updates
through `src/telegram/adapter.js`, resolves the topic against the latest config
on disk, and owns the authoritative per-topic run state: active run, pending
queue, accepted-but-undelivered steers, and `/stop` handling. It also serves
the CLI over `broker.sock`.

A topic on the default `pi` backend starts one fresh worker per message. The
gateway-side driver talks native Pi RPC bodies to `src/pi/rpc-bridge.js` over
that socket; the bridge spawns `src/pi/worker.js`, which loads the installed
`@earendil-works/pi-coding-agent` SDK, verifies that the configured route still
matches, builds the topic runtime, and hands its pipes to `runRpcMode()`. The
long-lived gateway never imports the SDK.

A topic with `backend: durable` uses `src/durable/`: a separately spawned,
shared Harness host (`host.js`) owns SQLite conversations and environments, and
the gateway speaks the versioned `telepi.durable/1` protocol to it. Durable 1.5
removed `watchEvents()`; `src/durable/view-events.js` derives turns, messages,
tools, retries, compactions, and failures from successive conversation views
read with `observeConversation()`. Remote workspaces run through
`@earendil-works/pi-env` inside Durable; the Telegram transport stays
gateway-local and the browser/evidence processes stay remote.

Config is reloaded at every ingress boundary (Telegram update, broker request,
prompt inbox). A malformed write keeps the last valid config so polling
survives a partial CLI save.

## Topic runtime

`buildTopicRuntimeSpec()` in `src/pi/runtime.js` (and `buildDurableEndpointSpec()`
in `src/durable/topic.js` for the other backend) turns one topic into Pi inputs:

- **Location.** A topic with nested `session.location.cwd` uses the entity root
  as Pi's `agentDir` and the location as `cwd`. A legacy `session_id` topic
  keeps the host Pi agent directory. SSH locations exist only for Durable.
- **Identity.** `<entity root>/AGENTS.md` is the agent's stable identity.
  `context_files: false` suppresses project and agent context files but appends
  the identity explicitly, matching `pi --no-context-files
  --append-system-prompt AGENTS.md`.
- **Resources.** Agent skills and extensions plus project extensions are
  resolved with `resolvePath()` against `project.root`, which leaves absolute
  paths absolute. The CLI maintenance commands and `validate` use the same
  resolver; anything else that resolves a configured path must too.
- **Model.** The topic's `model` wins; otherwise the agent's main topic (the
  topic named after the agent) supplies it, with an optional `:thinking` suffix.
  The suffix is an explicit level for that topic's runs: Pi writes a
  `thinking_level_change` entry only when a session has none, so a session that
  already carries a level keeps it, and a fork of that session resumes the
  stored level rather than the pin's.
- **Infrastructure.** `auth.json`, `models.json`, and `models-store.json` stay
  host-owned and are passed explicitly, never inherited from the entity folder.
  Session transcripts live in one shared `sessions_dir`.

Session files are cwd-bound: a session header records `cwd`, and Pi's discovery
matches it. Rotate the session when a topic changes location or backend.

## Compaction

Manual `/compact` runs `telepi session:compact --json` as a subprocess so it
always sees the installed Pi version, and that path builds the bound summary
instructions and the post-compaction notice (`src/pi/compact.js`). Native
automatic compaction does not get those instructions.

`src/compaction-policy.js` installs the provider reasoning-budget policy as an
operation-scoped extension factory for both the live runtime and that
subprocess; `extensions/compaction-reasoning-budget.js` is the same policy for
direct Pi use. It hooks `session_before_compact` and returns a summary produced
by Pi's own `compact()` with an overridden stream, because a stock Pi summary
call bypasses `before_provider_request`.

Keep the cap out of model-wide `samplingParams`: ordinary turns would inherit
it. Pi's `max_tokens` covers hidden reasoning and the visible checkpoint
together, so a cap that is technically honored can still starve a long summary
(a 4096-token reasoning budget exhausted Pi's 13,107-token allowance for a real
update prompt; 512 completed it).

## Telegram boundary

`src/telegram/adapter.js` polls `message`, `edited_message`, `callback_query`,
`message_reaction`, `widget_query`, and `shared_widget_query`. Callback
queries and widget queries are answered without waking the model; button data
and normal messages enter the gateway broker as the user's next turn.

Telegram widgets (Bot API 10.4) are small sandboxed HTML programs. A tap
arrives as a widget query that must be answered within 15 seconds and can
carry at most 64 bytes of state. Telepi answers first, mirrors the absolute
state into the message, and keeps a bounded copy in
`.telepi/cache/widget-states.json` so the state survives a restart and
the agent can read it after the tap.

Buttons live in `.telepi/cache/button-callbacks.jsonl`. `action` buttons are
handled by the adapter without the model; data buttons become the next user
message. Non-sticky keyboards are removed on first tap.

The bot is transport: every outbound message has the shared bot as Telegram
`from`. Reply context is attributed back to the logical agent, and echoed
broker prompts carry a provenance header.

## Debugging artifacts

| Path | Contents |
|------|----------|
| `.telepi/gateway.log` | Gateway stdout and stderr, including crash traces. |
| `.telepi/pi-sessions/*.jsonl` | Pi transcripts, append-only history and the authority for what a turn actually produced. |
| `.telepi/cache/crashes/` | Machine-readable records of uncaught errors, rejections, and abnormal exits. |
| `.telepi/cache/gateway-inflight-debug.json` | Bounded snapshot of in-flight work; a debugging aid, never restored. |
| `.telepi/cache/button-callbacks.jsonl` | Button definitions per keyboard token. |

## Persona sessions

Identity-driven sessions (personas with private life, diaries, scheduled
occasions) are continuity work, not workflows. Telepi supplies stable identity,
occasions, and optional affordances; it does not require action receipts,
declare tool calls real and inner text fake, or force a plan to prove a life
happened. Let Pi compact these sessions under actual context pressure rather
than after every ritual turn — repeated scheduled summaries can preserve one
posture into an attractor.
