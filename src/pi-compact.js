import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgent, resolveEntityDir } from "./config.js";

let piModulePromise;

export async function compactPiSession(config, topic, instructions, options = {}) {
  const agent = getAgent(config, topic.agent);
  const entityDir = resolveEntityDir(config, agent);
  const sessionId = topic.session_id || agent.session_id || `${topic.agent}-${topic.topic_id}`;
  const sessionFile = findSessionFile(config.project.sessions_dir, sessionId);
  if (!sessionFile) {
    throw new Error(`No session file found for ${topic.name} (${sessionId})`);
  }

  const { createAgentSession, SessionManager } = await loadPiModule();
  const sessionManager = SessionManager.open(sessionFile, config.project.sessions_dir, entityDir);
  const { session } = await createAgentSession({
    cwd: entityDir,
    sessionManager,
    model: options.model ? await resolveModel(options.model) : undefined,
  });
  try {
    return await session.compact(instructions || undefined);
  } finally {
    session.dispose?.();
  }
}

export function parseCompactCommand(text) {
  const match = String(text || "").match(/^\/compact(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return (match[1] || "").trim();
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
