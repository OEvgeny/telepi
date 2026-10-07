#!/usr/bin/env bash
set -euo pipefail

SERVICE="telepi-gateway.service"
TIMEOUT_SECONDS=0
STABLE_SECONDS=2
FORCE=false
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"
PROC_ROOT="${PROC_ROOT:-/proc}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="$2"; shift 2 ;;
    --stable-seconds) STABLE_SECONDS="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$STABLE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "timeout and stable seconds must be non-negative integers" >&2
  exit 2
fi

if [[ "$FORCE" == true ]]; then
  echo "WARNING: forcing $SERVICE restart; active gateway child processes will be terminated" >&2
  "$SYSTEMCTL_BIN" --user restart "$SERVICE"
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
started_at=$(date +%s)
idle_since=""
last_workers=""
durable_drain_requested=false

is_descendant_of_any() {
  local current="$1"
  local roots=" $2 "
  local parent=""
  while [[ "$current" =~ ^[0-9]+$ && "$current" != "0" ]]; do
    if [[ "$roots" == *" $current "* ]]; then
      return 0
    fi
    parent="$(awk '/^PPid:/ { print $2; exit }' "$PROC_ROOT/$current/status" 2>/dev/null || true)"
    if [[ -z "$parent" || "$parent" == "$current" ]]; then
      break
    fi
    current="$parent"
  done
  return 1
}

while true; do
  main_pid="$("$SYSTEMCTL_BIN" --user show "$SERVICE" -p MainPID --value)"
  control_group="$("$SYSTEMCTL_BIN" --user show "$SERVICE" -p ControlGroup --value)"
  cgroup_procs="${CGROUP_ROOT}${control_group}/cgroup.procs"
  if [[ -z "$main_pid" || "$main_pid" == "0" || -z "$control_group" || ! -r "$cgroup_procs" ]]; then
    echo "cannot inspect active gateway cgroup for $SERVICE" >&2
    exit 1
  fi

  workers="$(awk -v main="$main_pid" '$1 != main { print $1 }' "$cgroup_procs" | sort -n | tr '\n' ' ' | sed 's/ $//')"
  if [[ "$durable_drain_requested" == false && -n "$workers" ]]; then
    durable_roots=""
    durable_workers=""
    non_durable_workers=""
    for pid in $workers; do
      cmdline=""
      if [[ -r "$PROC_ROOT/$pid/cmdline" ]]; then
        cmdline="$(tr '\0' ' ' 2>/dev/null < "$PROC_ROOT/$pid/cmdline" || true)"
      fi
      if [[ "$cmdline" == *'/src/durable/host.js'* ]]; then
        durable_roots+="${durable_roots:+ }$pid"
      fi
    done
    for pid in $workers; do
      if [[ -n "$durable_roots" ]] && is_descendant_of_any "$pid" "$durable_roots"; then
        durable_workers+="${durable_workers:+ }$pid"
      else
        non_durable_workers+="${non_durable_workers:+ }$pid"
      fi
    done
    # Keep Durable available while unrelated Pi turns finish. Closing it early
    # creates a potentially long outage where the gateway still accepts
    # Telegram messages but every Durable request fails as "driver is closing".
    if [[ -n "$durable_workers" && -z "$non_durable_workers" ]]; then
      echo "asking Durable host to drain and close: $durable_workers" >&2
      if ! (cd "$ROOT" && node bin/telepi.js gateway:drain); then
        echo "Durable host drain failed; no restart attempted" >&2
        exit 1
      fi
      durable_drain_requested=true
      continue
    fi
  fi
  now=$(date +%s)
  if [[ -z "$workers" ]]; then
    if [[ -z "$idle_since" ]]; then
      idle_since="$now"
      echo "gateway has no child processes; confirming idle state" >&2
    fi
    if (( now - idle_since >= STABLE_SECONDS )); then
      break
    fi
  else
    idle_since=""
    if [[ "$workers" != "$last_workers" ]]; then
      echo "waiting for gateway child process(es) to finish: $workers" >&2
      last_workers="$workers"
    fi
  fi

  if (( TIMEOUT_SECONDS > 0 && now - started_at >= TIMEOUT_SECONDS )); then
    echo "timed out waiting for gateway child processes; no restart attempted" >&2
    exit 1
  fi
  sleep 1
done

echo "gateway idle; restarting $SERVICE" >&2
"$SYSTEMCTL_BIN" --user restart "$SERVICE"
