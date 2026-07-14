#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TOPIC=""
SESSION_ID=""
MODEL=""
ENTITY_DIR=""
WAIT_PID=""
WAIT_TIMEOUT_SECONDS=600
REASON="safe gateway restart"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic) TOPIC="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --wait-pid) WAIT_PID="$2"; shift 2 ;;
    --wait-timeout-seconds) WAIT_TIMEOUT_SECONDS="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TOPIC" ]]; then
  echo "missing required --topic <mapping-name>" >&2
  exit 2
fi

cd "$ROOT"
mkdir -p .telepi/cache/restart-workers
LOG=".telepi/cache/restart-workers/$(date -u +%Y%m%dT%H%M%SZ)-${TOPIC//[^A-Za-z0-9_.-]/_}.log"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

resolve_topic_field() {
  local field="$1"
  node --input-type=module -e '
    import { readConfig, findTopicByName, getAgent, resolveEntityDir, resolveTopicModel } from "./src/config.js";
    const [topicName, field] = process.argv.slice(1);
    const config = readConfig("config/telepi.yaml");
    const topic = findTopicByName(config, topicName);
    if (!topic) process.exit(3);
    const agent = getAgent(config, topic.agent);
    const values = {
      sessionId: topic.session_id || agent.session_id || `${topic.agent}-${topic.topic_id}`,
      model: resolveTopicModel(config, topic, agent) || "",
      entityDir: resolveEntityDir(config, agent),
    };
    process.stdout.write(values[field] || "");
  ' "$TOPIC" "$field"
}

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="$(resolve_topic_field sessionId)"
fi
if [[ -z "$MODEL" ]]; then
  MODEL="$(resolve_topic_field model)"
fi
ENTITY_DIR="$(resolve_topic_field entityDir)"

report_failure() {
  local text="$1"
  node bin/telepi.js topic:send --topic "$TOPIC" --quote --text "$text" >/dev/null 2>&1 || true
}

if [[ -n "$WAIT_PID" && "$WAIT_PID" =~ ^[0-9]+$ ]]; then
  deadline=$(( $(date +%s) + WAIT_TIMEOUT_SECONDS ))
  while kill -0 "$WAIT_PID" 2>/dev/null; do
    if (( $(date +%s) >= deadline )); then
      report_failure "⚠️ Safe gateway restart worker timed out waiting for pi process $WAIT_PID to exit. No restart attempted. Log: $ROOT/$LOG"
      exit 1
    fi
    sleep 1
  done
fi

PROMPT=$(cat <<EOF
/skill:telepi-gateway-restart
You are the mapped topic agent running in a detached safe gateway restart worker, outside the telepi gateway cgroup.

Reason: $REASON

Do the full safe restart cycle now:
1. Re-read the gateway restart skill and telepi-dev manual if needed.
2. Verify the repository is in a sane state for restart (syntax/config checks if relevant and quick enough).
3. Restart telepi-gateway.service.
4. Verify systemd reports it active and .telepi/gateway.log contains a fresh "telepi gateway connected" line after the restart.
5. Send the final result back with: node bin/telepi.js topic:send --topic "$TOPIC" --quote --text "..."

Rules:
- Do not use topic:prompt.
- Do not schedule another restart worker.
- Do not rely on Telegram tools; use bash and topic:send.
- If verification fails, still report with topic:send including the failure and the last useful gateway log lines.
- Keep the final Telegram report concise.
EOF
)

PI_ARGS=(
  --print
  --session-id "$SESSION_ID"
  --session-dir "$ROOT/.telepi/pi-sessions"
)
for skill in \
  "$ROOT/skills/telepi-dev/SKILL.md" \
  "$ROOT/skills/telepi-gateway-restart/SKILL.md"; do
  if [[ -f "$skill" ]]; then
    PI_ARGS+=(--skill "$skill")
  fi
done
if [[ -n "$MODEL" ]]; then
  PI_ARGS+=(--model "$MODEL")
fi

set +e
(
  cd "$ENTITY_DIR"
  pi "${PI_ARGS[@]}" "$PROMPT"
) >"$ROOT/$LOG" 2>&1
code=$?
set -e

if [[ $code -ne 0 ]]; then
  tail_text="$(tail -40 "$ROOT/$LOG" 2>/dev/null | sed -e 's/[`$]/_/g' | head -c 2500)"
  report_failure "⚠️ Detached safe gateway restart worker failed before reporting (exit $code). Log: $ROOT/$LOG

$tail_text"
  exit "$code"
fi
