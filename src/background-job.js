const DEFAULT_WAIT_SECONDS = 180;
const MAX_WAIT_SECONDS = 180;
const OUTPUT_TAIL_BYTES = 32 * 1024;
const OUTPUT_TAIL_LINES = 500;

const CREATE_JOB_DIR_SCRIPT = [
  "set -e",
  "umask 077",
  'base="${XDG_STATE_HOME:-"$HOME/.local/state"}/telepi/jobs"',
  'mkdir -p -- "$base"',
  'chmod 700 -- "$base"',
  'mktemp -d "$base/job-XXXXXXXX"',
].join("\n");

const LAUNCH_JOB_SCRIPT = String.raw`
set -e
mode=$1
unit=$2
runner=$3
output=$4
status=$5
command=$6
pid_file=$7
environment=$8
chmod 600 -- "$runner" "$output" "$command"
export -p > "$environment"
chmod 600 -- "$environment"
launch_process() {
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid "$BASH" "$runner" "$output" "$status" "$command" "$pid_file" "$environment" </dev/null >/dev/null 2>&1 &
  else
    nohup "$BASH" "$runner" "$output" "$status" "$command" "$pid_file" "$environment" </dev/null >/dev/null 2>&1 &
  fi
}
launched=process
if [[ "$mode" == systemd ]]; then
  if ! command -v systemd-run >/dev/null 2>&1; then
    echo "systemd-run is required for local Telepi background jobs" >&2
    exit 72
  fi
  systemd-run --user --quiet --collect --unit="$unit" --service-type=exec \
    --property="WorkingDirectory=$PWD" -- \
    "$BASH" "$runner" "$output" "$status" "$command" "$pid_file" "$environment"
  launched=systemd
elif [[ "$mode" == auto ]] && command -v systemd-run >/dev/null 2>&1 && \
  systemd-run --user --quiet --collect --unit="$unit" --service-type=exec \
    --property="WorkingDirectory=$PWD" -- \
    "$BASH" "$runner" "$output" "$status" "$command" "$pid_file" "$environment"; then
  launched=systemd
else
  launch_process
fi
for ((attempt = 0; attempt < 50; attempt++)); do
  [[ -s "$pid_file" ]] && break
  [[ -f "$status" ]] && break
  sleep 0.02
done
if [[ ! -s "$pid_file" ]]; then
  echo "background runner did not publish its PID" >&2
  exit 73
fi
printf '%s %s\n' "$launched" "$(cat "$pid_file")"
`;

const WAIT_FOR_STATUS_SCRIPT = String.raw`
status=$1
while [[ ! -f "$status" ]]; do
  sleep 0.2
done
`;

export const BACKGROUND_JOB_DEFAULT_WAIT_SECONDS = DEFAULT_WAIT_SECONDS;
export const BACKGROUND_JOB_MAX_WAIT_SECONDS = MAX_WAIT_SECONDS;

/**
 * Start a command outside the calling Pi/Durable worker's lifetime. The command
 * owns no Telepi pipe or SSH handle: all output goes to a persistent state file
 * before the short launcher exits.
 */
export async function runBackgroundJob(env, options, context = noAbortContext()) {
  if (!env) throw new Error("No execution environment is available");
  const command = requireCommand(options?.command);
  const waitSeconds = normalizeWaitSeconds(options?.waitSeconds);
  const launchMode = normalizeLaunchMode(options?.launchMode, env.id);
  const cwd = String(options?.cwd || env.cwd || "").trim();
  if (!cwd) throw new Error("Background job working directory is unavailable");

  const createdAt = new Date().toISOString();
  const directory = await createJobDirectory(env, cwd, context);
  const commandPath = await joinPath(env, directory, "command.sh", context);
  const runnerPath = await joinPath(env, directory, "runner.sh", context);
  const outputPath = await joinPath(env, directory, "output.log", context);
  const statusPath = await joinPath(env, directory, "status.json", context);
  const pidPath = await joinPath(env, directory, "pid", context);
  const environmentPath = await joinPath(env, directory, "environment.sh", context);
  const unit = backgroundJobUnit(directory);

  await unwrap(await env.writeFile(outputPath, "", context), "create background job output");
  await unwrap(await env.writeFile(commandPath, `#!/usr/bin/env bash\n${command}\n`, context), "write background job command");
  await unwrap(await env.writeFile(runnerPath, runnerScript(createdAt), context), "write background job runner");

  const launch = await execText(
    env,
    [
      "bash", "-lc", LAUNCH_JOB_SCRIPT, "telepi-job-launch",
      launchMode, unit, runnerPath, outputPath, statusPath, commandPath, pidPath, environmentPath,
    ],
    { cwd },
    context,
  );
  if (!launch.result.ok) throw executionFailure("launch background job", launch.result.error, launch.stderr);
  if (launch.result.value.exitCode !== 0) {
    throw new Error(`Failed to launch background job (exit ${launch.result.value.exitCode}): ${launch.stderr.trim() || launch.stdout.trim()}`);
  }
  const { pid, launcher } = parseLaunchReceipt(launch.stdout);

  let waitError = null;
  if (waitSeconds > 0) {
    const waited = await env.exec(
      ["bash", "-lc", WAIT_FOR_STATUS_SCRIPT, "telepi-job-wait", statusPath],
      { cwd, timeout: waitSeconds },
      context,
    );
    if (!waited.ok) waitError = executionErrorMessage(waited.error);
  }

  // Once launch succeeds, observation must not let a cancelled turn erase the
  // only useful receipt for a command that intentionally keeps running.
  const observationContext = noAbortContext(context);
  const status = await readStatus(env, statusPath, observationContext);
  const output = await readOutputTail(env, outputPath, observationContext);
  return {
    state: status ? "finished" : "running",
    pid,
    launcher,
    unit: launcher === "systemd" ? unit : null,
    directory,
    outputPath,
    statusPath,
    createdAt,
    waitSeconds,
    ...(status ? { exitCode: status.exitCode, finishedAt: status.finishedAt || null } : {}),
    outputTail: output.text,
    omittedOutputBytes: output.omittedBytes,
    ...(waitError && !status ? { waitError } : {}),
  };
}

export function backgroundJobToolResult(job) {
  const pathLines = [
    `Output path: ${job.outputPath}`,
    `Status path: ${job.statusPath}`,
  ];
  const omitted = job.omittedOutputBytes > 0
    ? `[${job.omittedOutputBytes} earlier output bytes omitted from this result; read the output path for the complete log]\n`
    : "";
  const output = job.outputTail
    ? `\nOutput tail:\n${omitted}${job.outputTail}`
    : "\nNo command output has been recorded yet.";

  let summary;
  if (job.state === "finished") {
    summary = `Job finished with exit code ${job.exitCode}.`;
  } else if (job.waitSeconds === 0) {
    summary = `Job started in the background (PID ${job.pid}). It continues independently of this turn.`;
  } else {
    summary = `Job is still running after waiting ${job.waitSeconds} seconds (PID ${job.pid}). It continues independently of this turn.`;
  }
  if (job.waitError && !/^timeout:/i.test(job.waitError)) {
    summary += ` Observation ended early: ${job.waitError}`;
  }

  return {
    content: [{ type: "text", text: `${summary}\n${pathLines.join("\n")}${output}` }],
    details: {
      state: job.state,
      pid: job.pid,
      launcher: job.launcher,
      unit: job.unit,
      directory: job.directory,
      output_path: job.outputPath,
      status_path: job.statusPath,
      created_at: job.createdAt,
      wait_seconds: job.waitSeconds,
      exit_code: job.exitCode ?? null,
      finished_at: job.finishedAt ?? null,
      omitted_output_bytes: job.omittedOutputBytes,
      wait_error: job.waitError ?? null,
    },
    ...(job.state === "finished" && job.exitCode !== 0 ? { isError: true } : {}),
  };
}

async function createJobDirectory(env, cwd, context) {
  const created = await execText(env, ["bash", "-lc", CREATE_JOB_DIR_SCRIPT], { cwd }, context);
  if (!created.result.ok) throw executionFailure("create background job directory", created.result.error, created.stderr);
  if (created.result.value.exitCode !== 0) {
    throw new Error(`Failed to create background job directory (exit ${created.result.value.exitCode}): ${created.stderr.trim() || created.stdout.trim()}`);
  }
  const directory = created.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!directory) throw new Error("Failed to create background job directory: no path returned");
  return directory;
}

async function execText(env, command, options, context) {
  let stdout = "";
  let stderr = "";
  const result = await env.exec(command, {
    ...options,
    onOutput(text, _outputContext, info) {
      if (info.stream === "stderr") stderr += text;
      else stdout += text;
    },
  }, context);
  return { result, stdout, stderr };
}

async function joinPath(env, directory, name, context) {
  return unwrap(await env.joinPath([directory, name], context), `build background job path for ${name}`);
}

async function readStatus(env, path, context) {
  const exists = await env.exists(path, context);
  if (!exists.ok || !exists.value) return null;
  const read = await env.readTextFile(path, context);
  if (!read.ok) return null;
  try {
    const parsed = JSON.parse(read.value);
    const exitCode = Number(parsed.exitCode);
    if (!Number.isInteger(exitCode)) return null;
    return { exitCode, finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null };
  } catch {
    return null;
  }
}

async function readOutputTail(env, path, context) {
  const opened = await env.openBinaryReader(path, undefined, context);
  if (!opened.ok) return { text: "", omittedBytes: 0 };
  const reader = opened.value;
  try {
    const info = await reader.info(context);
    if (!info.ok) return { text: "", omittedBytes: 0 };
    const offset = Math.max(0, info.value.size - OUTPUT_TAIL_BYTES);
    const read = await reader.read(offset, info.value.size - offset, context);
    if (!read.ok) return { text: "", omittedBytes: offset };
    let text = Buffer.from(read.value).toString("utf8");
    let omittedBytes = offset;
    const lines = text.split("\n");
    if (lines.length > OUTPUT_TAIL_LINES) {
      const removed = lines.splice(0, lines.length - OUTPUT_TAIL_LINES).join("\n") + "\n";
      omittedBytes += Buffer.byteLength(removed);
      text = lines.join("\n");
    }
    return { text: text.replace(/\s+$/, ""), omittedBytes };
  } finally {
    await reader.close(context);
  }
}

function runnerScript(createdAt) {
  return `#!/usr/bin/env bash
set +e
source "$5"
rm -f -- "$5"
output=$1
status=$2
command=$3
pid_file=$4
umask 077
pid_temporary="\${pid_file}.tmp.$$"
printf '%s\\n' "$$" > "$pid_temporary"
mv -f -- "$pid_temporary" "$pid_file"
exec >>"$output" 2>&1
printf '[telepi job] started_at=%s pid=%s cwd=%s\\n' ${shellLiteral(createdAt)} "$$" "$PWD"
"$BASH" "$command"
code=$?
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '\\n[telepi job] finished_at=%s exit_code=%s\\n' "$finished_at" "$code"
temporary="\${status}.tmp.$$"
printf '{"state":"finished","exitCode":%s,"finishedAt":"%s"}\\n' "$code" "$finished_at" > "$temporary"
mv -f -- "$temporary" "$status"
rm -f -- "$command" "$0"
exit "$code"
`;
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function requireCommand(value) {
  const command = String(value ?? "");
  if (!command.trim()) throw new Error("command must not be empty");
  if (command.includes("\0")) throw new Error("command must not contain NUL bytes");
  return command;
}

function normalizeWaitSeconds(value) {
  if (value == null) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS) {
    throw new Error(`wait_seconds must be an integer from 0 to ${MAX_WAIT_SECONDS}`);
  }
  return seconds;
}

function backgroundJobUnit(directory) {
  const suffix = String(directory).split(/[\\/]/).filter(Boolean).at(-1);
  if (!suffix || !/^[A-Za-z0-9_.-]+$/.test(suffix)) {
    throw new Error(`Background job directory has an unsafe unit suffix: ${JSON.stringify(directory)}`);
  }
  return `telepi-${suffix}`;
}

function normalizeLaunchMode(value, environmentId) {
  if (value == null) return environmentId === "node:local" ? "systemd" : "auto";
  if (value === "systemd" || value === "auto" || value === "process") return value;
  throw new Error(`Invalid background job launch mode: ${value}`);
}

function parseLaunchReceipt(stdout) {
  const values = stdout.trim().split(/\s+/);
  const launcher = values.at(-2);
  const pid = Number(values.at(-1));
  if ((launcher !== "systemd" && launcher !== "process") || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Background launcher returned an invalid receipt: ${JSON.stringify(stdout.trim())}`);
  }
  return { launcher, pid };
}

function executionFailure(operation, error, stderr) {
  const detail = executionErrorMessage(error);
  return new Error(`Failed to ${operation}: ${detail}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
}

function executionErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function noAbortContext(source) {
  return {
    abortSignal: undefined,
    value(key) {
      return typeof source?.value === "function" ? source.value(key) : undefined;
    },
    toString() {
      return typeof source?.toString === "function" ? source.toString() : "telepi-background-job";
    },
  };
}

function unwrap(result, operation) {
  if (result.ok) return result.value;
  throw executionFailure(operation, result.error, "");
}
