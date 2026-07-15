#!/usr/bin/env bash
set -euo pipefail

SERVICE="telepi-gateway.service"
TIMEOUT_SECONDS=0
STABLE_SECONDS=2
FORCE=false
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"

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

started_at=$(date +%s)
idle_since=""
last_workers=""

while true; do
  main_pid="$("$SYSTEMCTL_BIN" --user show "$SERVICE" -p MainPID --value)"
  control_group="$("$SYSTEMCTL_BIN" --user show "$SERVICE" -p ControlGroup --value)"
  cgroup_procs="${CGROUP_ROOT}${control_group}/cgroup.procs"
  if [[ -z "$main_pid" || "$main_pid" == "0" || -z "$control_group" || ! -r "$cgroup_procs" ]]; then
    echo "cannot inspect active gateway cgroup for $SERVICE" >&2
    exit 1
  fi

  workers="$(awk -v main="$main_pid" '$1 != main { print $1 }' "$cgroup_procs" | sort -n | tr '\n' ' ' | sed 's/ $//')"
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
