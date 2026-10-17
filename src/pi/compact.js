import { randomBytes } from "node:crypto";
import { existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertSupportedPiSdk, resolvePiPackageIndex } from "./path.js";
import { piCompactionPolicyFactories } from "../compaction-policy.js";
import {
  buildTopicRuntimeSpec,
  createInfrastructureModelRuntime,
  findSessionHeaders,
  resolveProjectTrust,
} from "./runtime.js";

let piModulePromise;

// Repeated Pi summaries can grow until the previous summary alone is near the
// next summary's output cap. Ask the model to rebuild and consolidate instead
// of mechanically extending it. Skills, AGENTS.md, and other files read during
// a session also leave stale copies in the transcript, so keep file-sourced
// facts out of the summary; the post-compaction notice makes the agent re-read
// files instead of trusting pre-compaction memory. Together a compacted session
// behaves like a fresh one with bounded conversational context. (Verified
// against the local model: instructions alone are not enough for freshness —
// the notice is the load-bearing part.)
const FRESHNESS_INSTRUCTIONS =
  "Produce a replacement checkpoint of at most 4,000 output tokens. Aggressively " +
  "consolidate the previous summary rather than preserving its wording or every " +
  "bullet. Preserve only current goals, user requirements, material decisions, " +
  "current state, unresolved issues, and facts needed for the next work. Omit " +
  "obsolete or superseded details, completed low-level implementation history, " +
  "commands, tool output, repeated facts, and file-by-file recaps. Do not enumerate " +
  "general read or modified files; Pi appends those lists separately. " +
  "Do NOT copy facts, rules, or instructions that came from skill files, AGENTS.md, " +
  "or other documentation files into the summary. Those files may change on disk " +
  "and will be re-read; only name the skill/document paths that must be re-read and " +
  "their purpose, without copying their contents. Preserve conversational facts " +
  "such as user decisions, material work performed, and results.";

const COMPACTION_NOTICE =
  "This session was just compacted. Any skill files, AGENTS.md, or other files read " +
  "earlier may have changed on disk since — the summary above intentionally omits " +
  "their contents. Do not answer from remembered file contents or from answers you " +
  "gave before compaction: re-read the relevant skill/file before relying on facts " +
  "that came from one.";

export async function compactPiSession(config, topic, instructions, options = {}) {
  const pi = await loadPiModule();
  const spec = buildTopicRuntimeSpec(config, topic, { infrastructureAgentDir: pi.getAgentDir() });
  const sessionFile = findSessionFile(config.project.sessions_dir, spec.sessionId, spec.cwd);
  if (!sessionFile) {
    throw new Error(`No session file found for ${topic.name} (${spec.sessionId})`);
  }

  const sessionManager = pi.SessionManager.open(sessionFile, config.project.sessions_dir, spec.cwd);
  if (!hasMeaningfulEntriesAfterLatestCompaction(sessionManager.getBranch())) {
    throw new Error("Already compacted");
  }
  const modelSpec = options.model || spec.modelSpec;
  const trustDiagnostics = [];
  const projectTrusted = resolveProjectTrust(
    pi,
    spec.cwd,
    spec.infrastructureAgentDir,
    trustDiagnostics,
  );
  const trustError = trustDiagnostics.find((diagnostic) => diagnostic.type === "error");
  if (trustError) throw new Error(trustError.message);
  const settingsManager = buildSettingsManager(pi.SettingsManager, spec, projectTrusted, options.keepRecentTokens);

  let session;
  if (typeof pi.createAgentSessionServices === "function" && typeof pi.createAgentSessionFromServices === "function") {
    // Load the same agent/location resources and configured extensions as a
    // normal run before resolving the model. Provider extensions register their
    // models while services are created, so both share one ModelRuntime.
    const modelRuntime = await createInfrastructureModelRuntime(pi, spec.infrastructureAgentDir);
    const services = await pi.createAgentSessionServices({
      cwd: spec.cwd,
      agentDir: spec.agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        additionalExtensionPaths: spec.extensionPaths,
        additionalSkillPaths: spec.skillPaths,
        extensionFactories: piCompactionPolicyFactories(pi.compact),
        appendSystemPrompt: spec.appendSystemPrompt,
        noContextFiles: spec.noContextFiles,
      },
    });
    const resolvedModel = modelSpec
      ? await resolveCompactionModel(modelSpec, { modelRuntime: services.modelRuntime })
      : {};
    ({ session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
    }));
  } else {
    const resolvedModel = modelSpec ? await resolveCompactionModel(modelSpec) : {};
    ({ session } = await pi.createAgentSession({
      cwd: spec.cwd,
      sessionManager,
      model: resolvedModel.model,
      modelRuntime: resolvedModel.modelRuntime,
      thinkingLevel: resolvedModel.thinkingLevel,
      settingsManager,
    }));
  }
  const combinedInstructions = buildCompactionInstructions(instructions);
  try {
    const result = await session.compact(combinedInstructions);
    sessionManager.appendCustomMessageEntry("telepi-compaction-notice", [
      { type: "text", text: COMPACTION_NOTICE },
    ], false);
    sessionManager.flush?.();

    const maxBytes = config.sessions?.max_bytes;
    if (maxBytes != null && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw new Error(`Invalid sessions.max_bytes: ${String(maxBytes)}`);
    }
    const checkpoint = maxBytes != null && statSync(sessionFile).size >= maxBytes
      ? createCompactionCheckpoint(pi.SessionManager, {
          sessionManager,
          sourceFile: sessionFile,
          sessionsDir: config.project.sessions_dir,
          entityDir: spec.cwd,
          sessionId: freshCheckpointSessionId(topic),
        })
      : null;
    return { ...result, checkpoint };
  } finally {
    session.dispose?.();
  }
}

export function buildCompactionInstructions(instructions) {
  return instructions
    ? `${instructions}\n\n${FRESHNESS_INSTRUCTIONS}`
    : FRESHNESS_INSTRUCTIONS;
}

export function hasMeaningfulEntriesAfterLatestCompaction(branch) {
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) return true;
  return branch.slice(compactionIndex + 1).some((entry) => {
    if (entry.type === "custom_message" && entry.customType === "telepi-compaction-notice") return false;
    return !["model_change", "thinking_level_change", "session_info", "label"].includes(entry.type);
  });
}

// Materialize pi's effective post-compaction context in a fresh session file.
// The source transcript stays append-only history; the checkpoint contains only
// the retained tail beginning at firstKeptEntryId, the successful compaction,
// and entries appended after it (currently the freshness notice above).
export function createCompactionCheckpoint(SessionManager, options) {
  const {
    sessionManager,
    sourceFile,
    sessionsDir,
    entityDir,
    sessionId,
    now = new Date(),
  } = options;
  const branch = sessionManager.getBranch();
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) throw new Error("Cannot checkpoint a session without a successful compaction");

  const compaction = branch[compactionIndex];
  const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
    throw new Error(`Compaction firstKeptEntryId is not on the retained branch: ${compaction.firstKeptEntryId}`);
  }

  const copiedEntries = branch.slice(firstKeptIndex).map((entry, index) => (
    index === 0 ? { ...entry, parentId: null } : { ...entry }
  ));
  const sourceContext = sessionManager.buildSessionContext();
  const sourceHeader = sessionManager.getHeader();
  const timestamp = now.toISOString();
  const usedIds = new Set(copiedEntries.map((entry) => entry.id));
  const contextSettingEntries = [];
  let settingParentId = copiedEntries.at(-1)?.id || null;
  if (sourceContext.model) {
    const id = freshEntryId(usedIds);
    contextSettingEntries.push({
      type: "model_change",
      id,
      parentId: settingParentId,
      timestamp,
      provider: sourceContext.model.provider,
      modelId: sourceContext.model.modelId,
    });
    settingParentId = id;
  }
  if (sourceContext.thinkingLevel) {
    const id = freshEntryId(usedIds);
    contextSettingEntries.push({
      type: "thinking_level_change",
      id,
      parentId: settingParentId,
      timestamp,
      thinkingLevel: sourceContext.thinkingLevel,
    });
  }
  const persistedEntries = [...copiedEntries, ...contextSettingEntries];
  const header = {
    type: "session",
    version: sourceHeader.version || 3,
    id: sessionId,
    timestamp,
    cwd: sourceHeader.cwd || entityDir,
    parentSession: sourceFile,
  };
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const targetFile = join(sessionsDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const tempFile = `${targetFile}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const body = `${[header, ...persistedEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;

  try {
    writeFileSync(tempFile, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const checkpointManager = SessionManager.open(tempFile, sessionsDir, entityDir);
    const checkpointContext = checkpointManager.buildSessionContext();
    if (!isDeepStrictEqual(checkpointContext, sourceContext)) {
      throw new Error("Checkpoint model context differs from the compacted source session");
    }
    if (checkpointManager.getSessionId() !== sessionId) {
      throw new Error(`Checkpoint session id mismatch: ${checkpointManager.getSessionId()} != ${sessionId}`);
    }
    renameSync(tempFile, targetFile);
  } finally {
    if (existsSync(tempFile)) unlinkSync(tempFile);
  }

  return {
    sessionId,
    file: targetFile,
    sourceSessionId: sessionManager.getSessionId(),
    sourceBytes: statSync(sourceFile).size,
    checkpointBytes: statSync(targetFile).size,
    firstKeptEntryId: compaction.firstKeptEntryId,
    compactionEntryId: compaction.id,
    copiedEntries: copiedEntries.length,
  };
}

function freshCheckpointSessionId(topic, date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${topic.agent}-${topic.topic_id}-${timestamp}-${randomBytes(3).toString("hex")}`;
}

function freshEntryId(usedIds) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomBytes(4).toString("hex");
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  throw new Error("Could not generate a unique checkpoint entry id");
}

// Record a message the machinery posted to Telegram in the topic's session
// transcript, so the agent remembers "saying" what appeared in its voice.
// Custom message entries participate in LLM context on the next run. If the
// topic has no session file yet there is nothing to record into.
export async function appendTopicSessionNote(config, topic, noteText) {
  const pi = await loadPiModule();
  const spec = buildTopicRuntimeSpec(config, topic, { infrastructureAgentDir: pi.getAgentDir() });
  const sessionFile = findSessionFile(config.project.sessions_dir, spec.sessionId, spec.cwd);
  if (!sessionFile) return false;
  const sessionManager = pi.SessionManager.open(sessionFile, config.project.sessions_dir, spec.cwd);
  sessionManager.appendCustomMessageEntry("telepi-sent-as-you", [{ type: "text", text: noteText }], false);
  sessionManager.flush?.();
  return true;
}

export function parseCompactCommand(text) {
  const match = String(text || "").match(/^\/compact(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return (match[1] || "").trim();
}

// Agent-home and location settings match a normal run; keepRecentTokens (how
// many recent tokens survive compaction uncompacted) is layered on top.
function buildSettingsManager(SettingsManager, spec, projectTrusted, keepRecentTokens) {
  const settingsManager = SettingsManager.create(spec.cwd, spec.agentDir, { projectTrusted });
  if (keepRecentTokens) {
    settingsManager.applyOverrides({
      compaction: { keepRecentTokens: Number(keepRecentTokens) },
    });
  }
  return settingsManager;
}

// Match pi's own --model parser, including optional :thinking suffixes such
// as openai-codex/gpt-5.6-sol:high. Keeping this at the fresh compaction
// worker boundary also means model aliases/catalog updates match normal runs.
export async function resolveCompactionModel(spec, options = {}) {
  const pi = await loadPiModule();
  let resolved;
  let modelRuntime = options.modelRuntime;

  if (modelRuntime || typeof pi.ModelRuntime?.create === "function") {
    modelRuntime ||= await pi.ModelRuntime.create();
    resolved = pi.resolveCliModel({ cliModel: String(spec), modelRuntime });
  } else if (typeof pi.ModelRegistry?.create === "function" && typeof pi.AuthStorage?.create === "function") {
    // Compatibility with pi versions before ModelRuntime became the public SDK API.
    const modelRegistry = pi.ModelRegistry.create(pi.AuthStorage.create());
    resolved = pi.resolveCliModel({ cliModel: String(spec), modelRegistry });
  } else {
    throw new Error("Installed pi SDK does not expose a supported model resolver");
  }

  if (resolved.error) throw new Error(resolved.error);
  if (!resolved.model) throw new Error(`Unknown model: ${spec}`);
  return {
    model: resolved.model,
    modelRuntime,
    thinkingLevel: resolved.thinkingLevel,
    warning: resolved.warning,
  };
}

function findSessionFile(sessionDir, sessionId, cwd) {
  if (!sessionId || !existsSync(sessionDir)) return null;
  const expectedCwd = resolve(cwd);
  const sessions = findSessionHeaders(sessionDir, sessionId);
  const conflicting = sessions.find(({ header }) => resolve(header.cwd || "") !== expectedCwd);
  if (conflicting) {
    const actualCwd = conflicting.header.cwd ? resolve(conflicting.header.cwd) : "an unknown cwd";
    throw new Error(
      `Session ${sessionId} belongs to ${actualCwd}, not ${expectedCwd}; `
      + "rotate the topic session before changing its location",
    );
  }
  return sessions.filter(({ header }) => resolve(header.cwd || "") === expectedCwd).at(-1)?.path || null;
}

async function loadPiModule() {
  piModulePromise ||= import(pathToFileURL(resolvePiPackageIndex()).href).then((pi) => {
    assertSupportedPiSdk(pi);
    return pi;
  });
  return piModulePromise;
}
