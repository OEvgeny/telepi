import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// The gateway downloads Telegram attachments to its own disk. A Durable
// conversation at an SSH location runs its tools on another machine, where
// that path does not exist (or names an unrelated file). Copy each file into
// the conversation's execution environment and hand back the path there.
//
// Files go to a per-topic directory under the remote user's state home, the
// same area background jobs use, outside the project tree. Names are the
// gateway's own deterministic names, so a retried submission writes the same
// path and its prompt text stays identical. Files older than the retention
// are removed when a topic stages new ones.

export const ATTACHMENT_RETENTION_DAYS = 14;

const PREPARE_DIR_SCRIPT = [
  "set -e",
  "umask 077",
  'base="${XDG_STATE_HOME:-"$HOME/.local/state"}/telepi/attachments"',
  'dir="$base/$1"',
  'mkdir -p -- "$dir"',
  'chmod 700 -- "$base"',
  'find "$base" -type f -mtime +"$2" -delete 2>/dev/null || true',
  'cd -- "$dir"',
  "pwd -P",
].join("\n");

export async function stageAttachments(env, request, context, options = {}) {
  const readLocal = options.readLocal || readFile;
  const attachments = Array.isArray(request?.attachments) ? request.attachments : [];
  const files = attachments.filter((attachment) => attachment?.path);
  if (!files.length) return { attachments };

  const directory = await prepareDirectory(env, request, context, options.retentionDays ?? ATTACHMENT_RETENTION_DAYS);
  const staged = [];
  for (const attachment of attachments) {
    if (!attachment?.path) {
      staged.push(attachment);
      continue;
    }
    const bytes = await readLocal(attachment.path);
    const target = unwrap(await env.joinPath([directory, safeFileName(attachment.path)], context), "build attachment path");
    unwrap(await env.writeFile(target, bytes, context), `copy ${attachment.path} to the execution environment`);
    staged.push({ ...attachment, path: target, gatewayPath: attachment.path });
  }
  return { attachments: staged };
}

async function prepareDirectory(env, request, context, retentionDays) {
  const subdirectory = `${safeSegment(request.chatId)}/${safeSegment(request.topicId ?? "root")}`;
  let stdout = "";
  let stderr = "";
  const result = await env.exec(["bash", "-c", PREPARE_DIR_SCRIPT, "telepi-attachments", subdirectory, String(retentionDays)], {
    onOutput(text, _outputContext, info) {
      if (info?.stream === "stderr") stderr += text;
      else stdout += text;
    },
  }, context);
  if (!result.ok) throw new Error(`Failed to prepare the attachment directory: ${result.error?.message || result.error}`);
  if (result.value.exitCode !== 0) {
    throw new Error(`Failed to prepare the attachment directory (exit ${result.value.exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  const directory = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!directory) throw new Error("Failed to prepare the attachment directory: no path returned");
  return directory;
}

function safeSegment(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

function safeFileName(path) {
  const name = basename(String(path)).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return name || "attachment";
}

function unwrap(result, action) {
  if (result?.ok) return result.value;
  const error = result?.error;
  throw new Error(`Failed to ${action}: ${error?.message || error || "unknown error"}`);
}
