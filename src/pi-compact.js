import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgent, resolveEntityDir, resolveTopicModel } from "./config.js";

let piModulePromise;

// Skills, AGENTS.md, and other files read during a session leave stale copies
// in the transcript, and a default compaction bakes their contents into the
// summary as facts. The instructions keep file-sourced facts out of the
// summary; the post-compaction notice makes the agent re-read files instead
// of trusting pre-compaction memory. Together a compacted session behaves
// like a fresh one with preserved conversational context. (Verified against
// the local model: instructions alone are not enough — the notice is the
// load-bearing part.)
const FRESHNESS_INSTRUCTIONS =
  "Do NOT copy facts, rules, or instructions that came from skill files, AGENTS.md, " +
  "or other documentation files into the summary. Those files may change on disk " +
  "and will be re-read; instead, list which skills/files were consulted and for " +
  "what purpose. Only preserve facts produced by the conversation itself " +
  "(user decisions, work performed, results).";

const COMPACTION_NOTICE =
  "This session was just compacted. Any skill files, AGENTS.md, or other files read " +
  "earlier may have changed on disk since — the summary above intentionally omits " +
  "their contents. Do not answer from remembered file contents or from answers you " +
  "gave before compaction: re-read the relevant skill/file before relying on facts " +
  "that came from one.";

export async function compactPiSession(config, topic, instructions, options = {}) {
  const agent = getAgent(config, topic.agent);
  const entityDir = resolveEntityDir(config, agent);
  const sessionId = topic.session_id || agent.session_id || `${topic.agent}-${topic.topic_id}`;
  const sessionFile = findSessionFile(config.project.sessions_dir, sessionId);
  if (!sessionFile) {
    throw new Error(`No session file found for ${topic.name} (${sessionId})`);
  }

  const { createAgentSession, SessionManager, SettingsManager } = await loadPiModule();
  const sessionManager = SessionManager.open(sessionFile, config.project.sessions_dir, entityDir);
  const modelSpec = options.model || resolveTopicModel(config, topic, agent);
  const { session } = await createAgentSession({
    cwd: entityDir,
    sessionManager,
    model: modelSpec ? await resolveModel(modelSpec) : undefined,
    settingsManager: buildSettingsManager(SettingsManager, entityDir, options.keepRecentTokens),
  });
  const combinedInstructions = instructions
    ? `${instructions}\n\n${FRESHNESS_INSTRUCTIONS}`
    : FRESHNESS_INSTRUCTIONS;
  try {
    const result = await session.compact(combinedInstructions);
    sessionManager.appendCustomMessageEntry("telepi-compaction-notice", [
      { type: "text", text: COMPACTION_NOTICE },
    ], false);
    sessionManager.flush?.();
    return result;
  } finally {
    session.dispose?.();
  }
}

export function parseCompactCommand(text) {
  const match = String(text || "").match(/^\/compact(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return (match[1] || "").trim();
}

// The entity's own .pi/settings.json still applies; keepRecentTokens (how many
// recent tokens survive compaction uncompacted) is layered on top when given.
function buildSettingsManager(SettingsManager, entityDir, keepRecentTokens) {
  if (!keepRecentTokens) return undefined;
  let entitySettings = {};
  const settingsPath = join(entityDir, ".pi", "settings.json");
  if (existsSync(settingsPath)) {
    entitySettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }
  return SettingsManager.inMemory({
    ...entitySettings,
    compaction: { ...entitySettings.compaction, keepRecentTokens: Number(keepRecentTokens) },
  });
}

async function resolveModel(spec) {
  const [provider, ...rest] = String(spec).split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) throw new Error(`Invalid model spec: ${spec} (expected provider/model)`);
  const { AuthStorage, ModelRegistry } = await loadPiModule();
  const model = ModelRegistry.create(AuthStorage.create()).find(provider, modelId);
  if (!model) throw new Error(`Unknown model: ${spec}`);
  return model;
}

function findSessionFile(sessionDir, sessionId) {
  if (!sessionId || !existsSync(sessionDir)) return null;
  const suffix = `_${sessionId}.jsonl`;
  const matches = readdirSync(sessionDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(sessionDir, name));
  return matches.at(-1) || null;
}

async function loadPiModule() {
  piModulePromise ||= import(pathToFileURL(resolvePiPackageIndex()).href);
  return piModulePromise;
}

function resolvePiPackageIndex() {
  const piBin = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
  const cliPath = realpathSync(piBin);
  return resolve(dirname(cliPath), "index.js");
}
