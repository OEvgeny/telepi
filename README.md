# telepi

Telegram topic gateway for [pi](https://github.com/badlogic/pi-mono) agents.

The gateway watches Telegram bot updates, extracts `chat_id` and `message_thread_id`, looks up that pair in `config/telepi.yaml`, and routes the message to the bound pi session. Unknown topics are ignored so another machine can own them.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and add it to a forum-enabled group with topics.
2. Copy `.env.example` to `.env` and set `TELEPI_BOT_TOKEN`.
3. Copy `config/telepi.example.yaml` to `config/telepi.yaml` and adjust; after that, manage it only through the `telepi` CLI.
4. `npm install`

## Pi Grounding

The gateway scopes pi execution per topic with:

- `--session-id <id>` for stable session identity
- `--session-dir <dir>` for shared session storage
- `--skill <path>` for agent-specific `SKILL.md` instructions
- `--extension <path>` for agent-specific pi extensions
- `--model <provider/model>` from per-topic config; topics without their own model inherit from the agent's main topic

The gateway also runs `pi` from the entity folder, so project-local context files such as `AGENTS.md` are scoped to that entity.

## Commands

```bash
npm install
npm run telepi -- validate
npm run telepi -- telegram:me
npm run telepi -- agents
npm run telepi -- topics
npm run telepi -- icons
```

Create an agent entity:

```bash
npm run telepi -- agent:create --id helper --name Helper
```

`agent:create` creates a seed Telegram topic by default, using `manager.chat_id` from `config/telepi.yaml`. Extra topics inherit the agent branding unless `--style`, `--avatar`, or `--color` is supplied.

Telegram topic icons are not arbitrary emoji. They must be one of Telegram's forum topic icon stickers; `telepi icons` lists each available emoji and its `custom_emoji_id`. If an agent avatar matches one of those emoji, Telepi uses it as `icon_custom_emoji_id`; otherwise the topic falls back to its color.

Create and bind an additional Telegram topic:

```bash
npm run telepi -- topic:create --chat-id <chat_id> --name Helper --agent helper
```

Bind an existing topic:

```bash
npm run telepi -- topic:bind --chat-id <chat_id> --topic-id <topic_id> --name Helper --agent helper
```

Set a per-topic model (the agent's main topic acts as the default for its other topics):

```bash
npm run telepi -- topic:set-model --name Helper --model <provider/model>
```

Start a topic with a fresh pi session without deleting old transcript files:

```bash
npm run telepi -- session:list --topic Helper --files
npm run telepi -- session:unlink --name Helper --reason "fresh conversation"
npm run telepi -- session:restore --name Helper --session-id helper-1001
```

`session:unlink` changes only the topic mapping's active `session_id`; the old `.telepi/pi-sessions/*.jsonl` files are preserved and recorded under `sessions.unlinked` in `config/telepi.yaml`.

Compact a long-running session in place:

```bash
npm run telepi -- session:compact --topic Helper [--instructions "..."] [--model <provider/model>]
```

Send a prompt into a topic from the command line (used by timers and scripts):

```bash
npm run telepi -- topic:prompt --topic Helper --text "..." [--no-echo] [--from "Name"] [--source "provenance"]
```

Run the gateway:

```bash
npm run gateway
```

While a routed pi session is running, the gateway sends Telegram `typing` chat actions scoped to the topic. It does not rename topics for transient status; topic edits are reserved for real metadata changes.

Agent runs use an idle timeout, not a fixed wall-clock timeout: by default a run is stopped only after 15 minutes without pi events. Set `idle_timeout_ms` on an agent to tune that value, or set `hard_timeout_ms` to add an absolute maximum runtime.

By default, Telegram receives only assistant text messages. To expose more pi stream message kinds, add an explicit allowlist under `telegram`, an `agent`, or a specific `topic`; topic settings override agent settings, and agent settings override global Telegram settings:

```yaml
telegram:
  display_messages:
    - assistant/message
    - custom
    - custom/something
    - tool
```

Category entries such as `assistant`, `custom`, or `tool` include all subtypes in that category. Specific entries such as `assistant/reasoning` or `custom/something` include only that subtype.

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

Install as a systemd user service after adjusting paths in `systemd/telepi-gateway.service` if this repo is not at `~/telepi`:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/telepi-gateway.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now telepi-gateway
```

Only one long-polling process can use a Telegram bot token at a time; stop any other consumer of the same token first.
