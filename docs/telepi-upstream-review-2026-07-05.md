# TelePi upstream review — 2026-07-05

Source reviewed: `https://github.com/benedict2310/TelePi`, cloned to `/tmp/benedict-telepi` outside this repository.

## Constraints

- Keep this telepi implementation plain Node.js/JavaScript.
- Do not migrate to TypeScript or adopt Telegram bot libraries.
- Slight vendoring/borrowing of small ideas is acceptable.
- Do not restart the gateway until the operator explicitly approves.

## Useful upstream ideas

1. **Prompt retry memory**
   - Upstream keeps the last prompt per chat/topic and exposes `/retry`.
   - This fits our topic router well and is small: remember the last non-command prompt envelope per chat/topic, then replay it as a fresh run when `/retry` is sent.

2. **External prompt inbox**
   - Upstream supports a directory of `.txt` prompts for cron jobs/webhooks/log watchers.
   - Our timers currently shell out to `topic:prompt`; an inbox gives a simpler local integration point without extra dependencies.
   - Keep it opt-in through environment variables and process only one file per poll to preserve per-topic busy semantics.

3. **Friendlier operator commands**
   - Upstream has `/help` and a richer command surface.
   - Our native gateway commands are intentionally small; add `/help` only for gateway-owned commands (`/help`, `/compact`, `/retry`) so users have discoverability without sending command text into agents.

4. **Callback/background separation**
   - Upstream documents decoupling Telegram callbacks from long prompt lifetimes.
   - Our gateway already dispatches agent runs in the background and handles callbacks in the gateway, so no large architectural change is needed here.

5. **Voice, model picker, session tree, handoff**
   - Valuable but larger features.
   - Defer: they either require optional native/cloud dependencies, a broader session UX, or do not match our current pod/topic architecture.

## Implementation plan for this pass

1. Add a small pure `src/prompt-inbox.js` helper:
   - list `.txt` files by mtime/name;
   - delete empty files;
   - parse optional `Topic: <topic name>` header;
   - leave busy files in place;
   - rename invalid files to `.failed` so a bad prompt does not loop forever.

2. Wire gateway prompt inbox polling:
   - enable with `TELEPI_PROMPT_INBOX_DIR`;
   - default target from `TELEPI_PROMPT_INBOX_TOPIC` if a file lacks `Topic:`;
   - interval from `TELEPI_PROMPT_INBOX_INTERVAL_MS`, default 60s, minimum 1s;
   - dispatch accepted prompts through the normal topic run path with `telepi_message_source=prompt-inbox`.

3. Add `/retry`:
   - remember the last non-command prompt envelope per chat/topic;
   - replay it when the topic is idle;
   - reject clearly if no prompt is remembered or the topic is busy.

4. Add `/help`:
   - answer locally with the gateway-owned command list;
   - include prompt inbox env hints if the inbox is enabled.

5. Verify:
   - syntax checks;
   - config validation;
   - small functional harness for prompt inbox parsing/claiming;
   - no gateway restart until the operator approves.
