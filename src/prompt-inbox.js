import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export function normalizePromptInboxInterval(value, defaultMs = 60_000) {
  const parsed = Number(value || defaultMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return Math.max(1000, Math.round(parsed));
}

export function startPromptInboxPolling(options) {
  let inFlight = false;
  const poll = () => {
    if (inFlight) return;
    inFlight = true;
    pollPromptInboxOnce(options)
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(poll, options.intervalMs);
  timer.unref?.();
  setTimeout(poll, 0).unref?.();
  return () => clearInterval(timer);
}

export async function pollPromptInboxOnce(options) {
  const claimed = await claimNextPromptInboxFile(options.inboxDir, options.defaultTopicName);
  if (!claimed) return "empty";

  if (claimed.invalidReason) {
    await claimed.fail();
    options.onInvalid?.(claimed);
    return "invalid";
  }

  const accepted = await options.handlePrompt(claimed);
  if (!accepted) return "busy";

  await claimed.ack();
  return "queued";
}

export async function claimNextPromptInboxFile(inboxDir, defaultTopicName) {
  const candidates = await listPromptInboxCandidates(inboxDir);
  for (const candidate of candidates) {
    const contents = await readFile(candidate.path, "utf8");
    const parsed = parsePromptInboxText(contents, defaultTopicName);
    if (!parsed.prompt) {
      await rm(candidate.path, { force: true });
      continue;
    }
    if (!parsed.topicName) {
      return {
        path: candidate.path,
        fileName: candidate.name,
        invalidReason: "missing Topic header and TELEPI_PROMPT_INBOX_TOPIC is not set",
        fail: () => failPromptInboxFile(candidate.path),
      };
    }
    return {
      path: candidate.path,
      fileName: candidate.name,
      topicName: parsed.topicName,
      prompt: parsed.prompt,
      ack: () => rm(candidate.path, { force: true }),
      fail: () => failPromptInboxFile(candidate.path),
    };
  }
  return undefined;
}

export function parsePromptInboxText(text, defaultTopicName) {
  const normalized = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return { topicName: defaultTopicName || "", prompt: "" };

  const lines = normalized.split("\n");
  const header = lines[0].match(/^\s*Topic\s*:\s*(.+?)\s*$/i);
  if (!header) return { topicName: defaultTopicName || "", prompt: normalized };

  const prompt = lines.slice(1).join("\n").replace(/^\s*\n/, "").trim();
  return { topicName: header[1].trim(), prompt };
}

async function listPromptInboxCandidates(inboxDir) {
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".txt") continue;
    const path = join(inboxDir, entry.name);
    const fileStat = await stat(path);
    candidates.push({ path, name: entry.name, modifiedMs: fileStat.mtimeMs });
  }
  return candidates.sort((left, right) => left.modifiedMs - right.modifiedMs || left.name.localeCompare(right.name));
}

async function failPromptInboxFile(path) {
  const failedPath = `${path}.failed`;
  try {
    await rename(path, failedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return `${basename(path)}.failed`;
}
