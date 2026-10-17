# telepi

Telegram topic gateway for [pi](https://github.com/badlogic/pi-mono) agents.

The gateway watches Telegram bot updates, extracts `chat_id` and `message_thread_id`, looks up that pair in `config/telepi.yaml`, and routes the message to the bound pi session. Unknown topics are ignored so another machine can own them. `src/gateway.js` owns broker and session-queue orchestration, `src/pi/sdk-driver.js` controls a fresh Telepi-aware SDK worker for each run, and `src/telegram/adapter.js` owns concrete in-process Telegram polling, hydration, callbacks, and rendering.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and enable topics for it; telepi routes messages between those bot topics.
2. Copy `.env.example` to `.env` and set `TELEPI_BOT_TOKEN`.
3. Copy `config/telepi.example.yaml` to `config/telepi.yaml` and adjust; after that, manage it only through the `telepi` CLI.
4. `npm install`

## Pi Grounding

For every run the gateway starts `src/pi/rpc-bridge.js`, which connects to the existing broker Unix socket and starts `src/pi/worker.js` as a fresh child process. The bridge passes Pi's native JSONL RPC bodies through that socket while retaining stdin/stdout only at the worker boundary. The worker loads the installed Pi SDK, verifies that the configured chat/topic still points at the expected agent and session, builds the topic runtime, and delegates the native protocol to `runRpcMode()`.

The runtime combines:

- the configured session id and shared Telepi session directory;
- agent-specific skills and extensions;
- project-wide extensions;
- the topic model override, or the agent's main-topic model;
- host-owned credential and model stores supplied explicitly through Pi's SDK.

New topic mappings use a location-aware session:

```yaml
session:
  id: helper-main
  location:
    type: local
    cwd: entities/helper
```

For these sessions, the entity root is Pi's agent home and `session.location.cwd` is the project working directory. Stable identity and agent-wide instructions belong in `<entity-root>/AGENTS.md`; other agent-home resources use Pi's normal layout directly under that root (`settings.json`, `extensions/`, `skills/`). A different location may provide its own project `AGENTS.md` and `.pi/` resources. Host-global Pi settings and resources are omitted, while shared `auth.json`, `models.json`, and `models-store.json` remain infrastructure. Existing mappings with only `session_id` stay in legacy mode for backward compatibility.

For ordinary topics, Pi's SDK remains inside the fresh worker rather than the long-running gateway, so Pi upgrades cannot leave a stale model/runtime catalog cached in the service process. Experimental Durable topics run in one separately spawned host child; the gateway itself still does not import the agent runtime.

## Commands

```bash
npm install
npm run telepi -- validate
npm run telepi -- telegram:me
npm run telepi -- agents
npm run telepi -- topics
npm run telepi -- icons
```

`validate` also resolves the active Pi CLI, follows its package manifest to the public SDK entry, and checks the SDK exports Telepi requires. Run it after every Pi upgrade before restarting the gateway.

Create an agent entity:

```bash
npm run telepi -- agent:create --id helper --name Helper
```

`agent:create` creates a seed Telegram topic by default, using `manager.chat_id` from `config/telepi.yaml`. Extra topics inherit the agent branding unless `--style`, `--avatar`, or `--color` is supplied. Use `--no-context-files` for agents that should retain their entity `AGENTS.md` identity without also loading project `AGENTS.md`/`CLAUDE.md` files.

Telegram topic icons are not arbitrary emoji. They must be one of Telegram's forum topic icon stickers; `telepi icons` lists each available emoji and its `custom_emoji_id`. If an agent avatar matches one of those emoji, Telepi uses it as `icon_custom_emoji_id`; otherwise the topic falls back to its color.

Create and bind an additional Telegram topic:

```bash
npm run telepi -- topic:create --chat-id <chat_id> --name Helper --agent helper [--cwd <path>]
```

Bind an existing topic:

```bash
npm run telepi -- topic:bind --chat-id <chat_id> --topic-id <topic_id> --name Helper --agent helper [--cwd <path>]
```

Set a per-topic model (the agent's main topic acts as the default for its other topics). Append a pi thinking level to configure effort for both normal turns and compaction:

```bash
npm run telepi -- topic:set-model --name Helper --model <provider/model>
npm run telepi -- topic:set-model --name Helper --model <provider/model>:high
```

Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` (subject to model support).

Opt one topic into the experimental Durable host, or switch it back to the ordinary Pi worker backend:

```bash
npm run telepi -- topic:set-backend --name Helper --backend durable
npm run telepi -- topic:set-backend --name Helper --backend pi
```

The first Durable prompt creates a fresh ownerless conversation in `.telepi/durable-host/telepi.sqlite`; it never imports, rewrites, or deletes the topic's JSONL history. The gateway starts one locked multi-conversation host child only when an enabled topic is opted in. Durable currently reuses Pi's model/settings/context/skill services plus Durable's coding tools, Durable-native Telegram tools, and activity events. It is a pilot backend: semantic outbox receipts, general extension parity, automatic compaction policy hooks, and resource governors remain migration gates, so no topic is opted in by default.

A Durable topic may run its coding tools in an SSH workspace through the official `@earendil-works/pi-env` transport:

```bash
npm run telepi -- topic:set-backend --name Helper --backend durable
npm run telepi -- topic:set-location --name Helper --type ssh --host <ssh-config-alias> --user <remote-user> --cwd /remote/project [--agent-dir /remote/deployment/effective] [--port 22] [--identity-file <path>] [--ssh-config-file <path>]
npm run telepi -- topic:ssh-host-key --name Helper
# Compare a displayed SHA256 fingerprint through an independent channel first:
npm run telepi -- topic:ssh-host-key --name Helper --accept SHA256:<verified-fingerprint>
```

`topic:set-location` writes the active, normally gitignored Telepi config, records the replaced Pi session mapping, and rotates to a fresh Durable endpoint; old JSONL and Durable history remains intact. Host keys are kept separately in `.telepi/durable-host/ssh-known-hosts` and are never accepted automatically. Use `topic:ssh-host-key --forget` only before separately scanning and verifying a legitimate replacement key.

Without `--agent-dir`, stable agent identity and agent-wide skills remain local while project `AGENTS.md`/`CLAUDE.md` and `.pi/skills` come from the remote workspace. With `--agent-dir`, identity, settings-declared packages, and skills are resolved through SSH from that remote deployment instead; no local agent path is rendered as remote project context. A packaged browser extension is adapted into a Durable `browser` tool whose process, Chromium, sessions, and evidence stay remote. Durable-native Telegram tools remain gateway-local, except image bytes are read from the selected execution environment before upload. Model credentials and the Durable database always remain local. `pi-env` is transport, not a sandbox: remote tools have the authority of the configured SSH account, so use a dedicated account or container when isolation is required. SSH locations are rejected by the ordinary Pi backend.

Start a topic with a fresh pi session without deleting old transcript files:

```bash
npm run telepi -- session:list --topic Helper --files
npm run telepi -- session:unlink --name Helper --reason "fresh conversation"
npm run telepi -- session:restore --name Helper --session-id helper-1001
```

`session:unlink` changes only the topic mapping's active session id; the old `.telepi/pi-sessions/*.jsonl` files are preserved and recorded under `sessions.unlinked` in `config/telepi.yaml`. Both `session:unlink` and `session:restore` post a Telegram notice identifying the previous and new downstream sessions and explaining whether conversational context is fresh or restored.

Compact a long-running session:

```bash
npm run telepi -- session:compact --topic Helper [--instructions "..."] [--model <provider/model>]
```

By default there is no active-session size limit. Configure one through the CLI:

```bash
npm run telepi -- session:limit --size 32MiB
npm run telepi -- session:limit                 # show the current limit
npm run telepi -- session:limit --unlimited
```

After a successful compaction, a transcript at or above the configured limit is checkpointed into a fresh session containing only pi's retained tail, the successful compaction entry, and subsequent context entries. The topic is relinked only after the checkpoint produces the same model-facing message context. The original transcript remains unchanged in session history and the new header records it as `parentSession`.

`extensions/compaction-reasoning-budget.js` caps Strata reasoning at 512 tokens only for Pi's stock compaction operation. Pi's completion limit is shared by reasoning and the visible summary, so this deliberately leaves most of the allowance for the checkpoint itself. The extension intercepts manual and automatic compaction and calls Pi's unchanged `compact()` implementation through an overridden model stream; this is necessary because Pi's built-in summary stream bypasses `before_provider_request`. Telepi preloads the same policy for every routed Pi profile, regardless of agent directory or working directory; ordinary turns are unchanged. Durable applies the same request override only at its summarization model boundary.

Direct Pi can use the identical policy by linking the extension into its agent directory (repeat for a non-default `PI_CODING_AGENT_DIR`):

```bash
ln -s /path/to/telepi/extensions/compaction-reasoning-budget.js \
  ~/.pi/agent/extensions/compaction-reasoning-budget.js
```

Send a direct Telegram message to a topic without invoking pi or the gateway:

```bash
npm run telepi -- topic:send --topic Helper --text "..." [--reply-to <message-id>] [--quote]
```

Submit a prompt into the running gateway broker from the command line (used by agents, timers, and scripts):

```bash
npm run telepi -- topic:prompt --topic Helper --text "..." [--no-echo] [--from "Name"] [--source "provenance"]
```

`topic:prompt` returns after the broker accepts the message. Unless `--no-echo` is used, its synthetic Telegram prompt is labeled with a quoted `📨 Message from <Agent>` header when invoked inside a routed Telepi agent, or `📨 Posted message` for other callers. The broker is the sole owner of per-topic dispatch: it starts an idle session, steers a running session, or queues the message for a safe boundary. Pi sessions also receive a `telepi_send_message` tool. Its `to` value should be the exact topic mapping name, which is the routable alias for that topic's specific session. An agent id is accepted only when the agent has exactly one enabled topic; raw session ids are not routable.

The gateway also owns a few Telegram slash commands directly:

- `/help` — show gateway-owned commands.
- `/stop` — stop the current turn in that topic without sending another prompt to the agent. This clears steers already queued inside that turn, prevents newer messages from steering into the stopping worker, and bounds graceful Pi shutdown before terminating that per-message worker. It is the sole active-turn stop control; streamed messages do not carry a Cancel keyboard.
- `/compact [instructions]` — compact the current topic's pi session.
- `/retry` — rerun the last non-command prompt remembered for that chat/topic.

For cron jobs, webhooks, or local scripts that should not shell out to the CLI, enable a prompt inbox with environment variables in the gateway service:

```dotenv
TELEPI_PROMPT_INBOX_DIR=/absolute/path/to/prompt-inbox
TELEPI_PROMPT_INBOX_TOPIC=Helper          # optional default topic name
TELEPI_PROMPT_INBOX_INTERVAL_MS=60000     # optional; minimum 1000
```

The inbox processes one `.txt` file at a time. Files may start with `Topic: Helper` to override the default topic; empty files are deleted, busy topics leave files queued, and invalid files are renamed to `.failed` to avoid loops.

Run the gateway:

```bash
npm run gateway
```

While a routed pi session is running, the gateway sends Telegram `typing` chat actions scoped to the topic. If the run produces no visible Telegram output for one minute, the gateway also posts one preformatted activity message and edits it once per minute. The three-line snapshot reports the Pi model-step count, tool-call count, completed output tokens, current observable phase and duration, and previous completed step. It is removed when visible output resumes or the run ends. Raw reasoning, tool arguments, and tool output are never included. The gateway does not rename topics for transient status; topic edits are reserved for real metadata changes.

Agent runs have no destructive timeout by default. A model request, prompt preflight compaction, or long-running tool can legitimately remain silent, so absence of pi events is not treated as failure; the topic stays busy until the run finishes or the user sends `/stop`. Prompt acknowledgement is not subject to the generic RPC control-response timeout because Pi acknowledges only after preflight work completes. A prompt failure never causes Telepi to unlink the active session or silently retry in a fresh one. Operators can explicitly set `idle_timeout_ms` for legacy idle-stop behavior or `hard_timeout_ms` for an absolute maximum runtime.

## Background Commands

Every routed Pi session and Durable conversation receives `telepi_run_command(command, wait_seconds?)`. It starts a non-interactive Bash command as a detached job in the session's selected local or SSH workspace. The tool waits up to 180 seconds by default; if the command is still running, it returns while the command continues and reports persistent output and status paths. Agents can inspect the output path with `read` in a later turn. Set `wait_seconds` to `0` to return immediately.

Job records live under `${XDG_STATE_HOME:-$HOME/.local/state}/telepi/jobs` in the execution environment. The detached command survives the short-lived Pi worker, Durable environment cleanup, and gateway restarts, but it is not restarted after a machine reboot. `/stop` stops the agent turn, not a command already launched with this tool; use ordinary `bash` when turn cancellation should also cancel the command. Interactive commands are not supported.

By default, Telegram receives only assistant text messages. To expose more pi stream message kinds, add an explicit allowlist under `telegram`, an `agent`, or a specific `topic`; topic settings override agent settings, and agent settings override global Telegram settings:

```yaml
telegram:
  display_messages:
    - assistant/message
    - custom
    - custom/something
    - tool
```

Category entries such as `assistant`, `custom`, or `tool` include all subtypes in that category. Specific entries such as `assistant/reasoning` or `custom/something` include only that subtype. Agent overrides can be managed without hand-editing config:

```bash
telepi agent:display-messages --id <agent> --set assistant/message assistant/reasoning
telepi agent:display-messages --id <agent> --clear
```

Enabled `assistant/reasoning` updates are coalesced into one italic Telegram message per user turn. Later reasoning summaries edit and append to that message instead of creating a noisy sequence; a continuation is used only if Telegram's message-size limit is reached.

## Formatting

Outbound messages are converted from model markdown to Telegram MarkdownV2 using a vendored copy of [telegram-markdown-v2](https://github.com/AndyRightNow/telegram-markdown-v2) (see `vendor/`). If conversion fails or inflates a chunk past Telegram's 4096-char limit, the chunk is sent as plain text instead — models are never restricted in what they can output.

## Attachments

Inbound Telegram photos, image documents, and other uploads are downloaded under `.telepi/cache/` and listed in the prompt with their local path, filename, MIME type, and size. Agents view them with pi's `read` tool — vision-capable models see image content by reading the file path; nothing is inlined as base64.

Outbound images are sent by a pi extension tool:

```text
telepi_send_image(file_path, caption?)
```

The gateway loads `extensions/telepi-telegram.ts` for each routed session and passes the current `chat_id`, `topic_id`, and message id through environment variables, so agents normally only need to provide `file_path` and optionally `caption`.

## Inline Buttons

`extensions/telepi-telegram.ts` also registers `telepi_buttons(text, buttons)` for agents that should offer tappable choices:

- `buttons` is a flat list of up to 24 entries; rows are laid out automatically.
- Each entry is a plain string (label doubles as the payload), `{label, data}` when the routed-back payload should differ, or `{label, url}` for link buttons.
- A tap is answered, the keyboard is removed (one-shot), and the label/`data` is routed back into the same topic session as a normal user reply.

Button state lives in `.telepi/cache/button-callbacks.jsonl`, one record per sent message.

## Running as a service

Install as a systemd user service after adjusting paths in `systemd/telepi-gateway.service` if this repo is not at `~/telepi` or Node is not in `~/.nix-profile/bin`. The unit sets a boot-stable runtime `PATH`; Telepi discovers Pi without a login shell across managed/Nix, local, npm, and pnpm user installs. Set `TELEPI_PI_BIN` in `.env` only when an explicit installation must win over that search order:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/telepi-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now telepi-gateway
```

Only one long-polling process can use a Telegram bot token at a time; stop any other consumer of the same token first.
