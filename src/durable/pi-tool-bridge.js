import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

// Durable topics cannot load Pi extensions, so they lose the tools Pi topics
// get from them: web search, voice transcription, and each agent's own tools.
// This bridge loads the same extensions in a headless Pi session on the
// gateway host, one per endpoint, and offers their tools to the Durable
// conversation. A call runs the tool through Pi's own wrapper, so it gets the
// context Pi gives it (cwd, model registry, session events).
//
// Scope: tools, and the cards an extension posts with `pi.sendMessage`. Hooks
// on Pi's agent loop (`before_agent_start`, `input`, message events) have no
// Durable run to observe and are not bridged.

// Pi's built-in tools: Durable has its own.
const PI_BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
// Telepi's own Pi extension: Durable has native versions of these tools.
const NATIVE_TOOL_PREFIX = "telepi_";
// A bridged tool's file argument in an SSH conversation is copied from the
// remote machine first; refuse files that would not fit in memory sensibly.
const MAX_LOCALIZED_FILE_BYTES = 512 * 1024 * 1024;
const PATH_PARAMETER = /(?:^|_)(?:path|file|filename|filepath)$/i;

export class PiToolBridge {
  constructor({ loadPi, modelRuntime, onCustomMessage, log = (message) => console.error(message) }) {
    this.loadPi = loadPi;
    this.modelRuntime = modelRuntime;
    this.onCustomMessage = onCustomMessage;
    this.log = log;
    this.endpoints = new Map();
  }

  // The Durable extension that offers this endpoint's Pi extension tools, or
  // null when there are none. `reserved` names tools the conversation already
  // has natively, which a bridged tool must not shadow.
  async extensionFor(endpointKey, spec, { location = "local", reserved = [] } = {}) {
    if (!spec?.cwd || !spec?.agentDir) return null;
    const signature = JSON.stringify({ spec, location, reserved: [...reserved].sort() });
    const existing = this.endpoints.get(endpointKey);
    if (existing?.signature === signature) return existing.extension;
    if (existing) await this.closeEndpoint(endpointKey);

    const pi = await this.loadPi();
    const session = await openHeadlessSession(pi, spec, this.modelRuntime, this.log);
    const entry = { signature, session, extension: null, unsubscribe: undefined };
    entry.unsubscribe = session.subscribe((event) => {
      // A headless session must never run a model turn of its own; an
      // extension that asks for one (`triggerTurn`) is stopped here.
      if (event?.type === "agent_start") {
        this.log(`pi tool bridge stopped a turn an extension started endpoint=${endpointKey}`);
        void session.abort().catch(() => undefined);
        return;
      }
      if (event?.type === "message_end" && event.message?.role === "custom") {
        try {
          this.onCustomMessage?.(endpointKey, jsonSafe(event.message));
        } catch (error) {
          this.log(`pi tool bridge custom message failed endpoint=${endpointKey}: ${messageOf(error)}`);
        }
      }
    });

    const reservedNames = new Set(reserved);
    const tools = session.getAllTools()
      .filter((tool) => tool.sourceInfo?.path)
      .filter((tool) => !PI_BUILTIN_TOOLS.has(tool.name) && !tool.name.startsWith(NATIVE_TOOL_PREFIX))
      .filter((tool) => !reservedNames.has(tool.name))
      .map((tool) => bridgeTool(session, session.getToolDefinition(tool.name), location, this.log));
    entry.extension = tools.length
      ? defineExtension({ name: bridgeExtensionName(endpointKey), tools })
      : null;
    this.endpoints.set(endpointKey, entry);
    return entry.extension;
  }

  async closeEndpoint(endpointKey) {
    const entry = this.endpoints.get(endpointKey);
    if (!entry) return;
    this.endpoints.delete(endpointKey);
    entry.unsubscribe?.();
    await disposeSession(entry.session, this.log);
  }

  async close() {
    for (const endpointKey of [...this.endpoints.keys()]) await this.closeEndpoint(endpointKey);
  }
}

export function bridgeExtensionName(endpointKey) {
  return `telepi-pi-tools-${String(endpointKey).replace(/[^A-Za-z0-9-]/g, "-")}`;
}

async function openHeadlessSession(pi, spec, modelRuntime, log) {
  const diagnostics = [];
  const projectTrusted = resolveProjectTrust(pi, spec.cwd, spec.infrastructureAgentDir || spec.agentDir, diagnostics);
  const settingsManager = pi.SettingsManager.create(spec.cwd, spec.agentDir, { projectTrusted });
  const services = await pi.createAgentSessionServices({
    cwd: spec.cwd,
    agentDir: spec.agentDir,
    settingsManager,
    ...(modelRuntime ? { modelRuntime } : {}),
    resourceLoaderOptions: {
      additionalExtensionPaths: spec.extensionPaths || [],
      noContextFiles: true,
    },
  });
  for (const diagnostic of [...diagnostics, ...services.diagnostics]) {
    if (diagnostic.type === "error") log(`pi tool bridge: ${diagnostic.message}`);
  }
  for (const { path, error } of services.resourceLoader.getExtensions().errors || []) {
    log(`pi tool bridge failed to load extension "${path}": ${error}`);
  }
  const { session } = await pi.createAgentSessionFromServices({
    services,
    sessionManager: pi.SessionManager.inMemory(spec.cwd),
  });
  await session.bindExtensions({
    mode: "rpc",
    onError: (error) => log(`pi tool bridge extension error: ${messageOf(error?.error ?? error)}`),
  });
  return session;
}

function resolveProjectTrust(pi, cwd, agentDir, diagnostics) {
  if (typeof pi.hasTrustRequiringProjectResources !== "function" || !pi.hasTrustRequiringProjectResources(cwd)) return true;
  const decision = new pi.ProjectTrustStore(agentDir).get(cwd);
  if (decision == null) {
    diagnostics.push({ type: "error", message: `Project trust has not been decided for ${cwd}; its project extensions are not loaded` });
    return false;
  }
  return decision;
}

// As Pi does at exit: stop work, let extensions shut down (pi-voice stops its
// model worker there), then dispose.
async function disposeSession(session, log) {
  try {
    await session.abort?.();
    const runner = session.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose?.();
  } catch (error) {
    log(`pi tool bridge session close failed: ${messageOf(error)}`);
  }
}

function bridgeTool(session, definition, location, log) {
  return defineTool({
    name: definition.name,
    label: definition.label || definition.name,
    description: definition.description || definition.name,
    ...(definition.promptSnippet ? { promptSnippet: definition.promptSnippet } : {}),
    ...(definition.promptGuidelines?.length ? { promptGuidelines: [...definition.promptGuidelines] } : {}),
    parameters: definition.parameters,
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    // A Pi tool may have side effects (a sent photo, a generated file):
    // an interrupted call is not run again after a restart.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const temporary = [];
      try {
        const callArgs = location === "ssh"
          ? await localizePathArguments(definition.parameters, args, api.env, context, temporary)
          : args;
        // Pi's own wrapper of the tool, bound to the session's extension context.
        const agentTool = session._toolRegistry?.get(definition.name);
        if (!agentTool) throw new Error(`Pi tool ${definition.name} is not loaded`);
        const result = await agentTool.execute(api.callId, callArgs, context?.abortSignal, undefined);
        const details = jsonSafe(result?.details);
        return {
          output: normalizeContent(result?.content),
          ...(details === undefined ? {} : { details }),
          ...(result?.isError ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          output: [{ type: "text", text: messageOf(error) }],
          isError: true,
          details: { error: messageOf(error) },
        };
      } finally {
        for (const directory of temporary) {
          await rm(directory, { recursive: true, force: true }).catch((error) => {
            log(`pi tool bridge could not remove ${directory}: ${messageOf(error)}`);
          });
        }
      }
    },
  });
}

// In an SSH conversation the files the model names are on the remote machine,
// while the bridged tool runs on the gateway host. Copy each file argument
// (a string parameter named like `path` or `file_path`) to a local temporary
// file and pass that path instead. A path that does not exist there is passed
// unchanged, so the tool reports it as it would.
export async function localizePathArguments(parameters, args, env, context, temporary) {
  if (!env || !args || typeof args !== "object") return args;
  const properties = parameters?.properties || {};
  const localized = { ...args };
  for (const [name, schema] of Object.entries(properties)) {
    if (!PATH_PARAMETER.test(name) || schema?.type !== "string") continue;
    const value = args[name];
    if (typeof value !== "string" || !value.trim()) continue;
    const absolute = await env.absolutePath(value.trim().replace(/^@/, ""), context);
    if (!absolute.ok) continue;
    const info = await env.fileInfo(absolute.value, context);
    if (!info.ok || info.value?.kind === "directory" || info.value?.type === "directory") continue;
    if (Number(info.value?.size) > MAX_LOCALIZED_FILE_BYTES) {
      throw new Error(`${absolute.value} is too large to copy from the remote machine (${info.value.size} bytes)`);
    }
    const bytes = await env.readBinaryFile(absolute.value, context);
    if (!bytes.ok) continue;
    const directory = await mkdtemp(join(tmpdir(), "telepi-pi-tool-"));
    temporary.push(directory);
    const local = join(directory, basename(absolute.value) || "file");
    await writeFile(local, bytes.value);
    localized[name] = local;
  }
  return localized;
}

function normalizeContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const normalized = blocks.flatMap((block) => {
    if (block?.type === "text") return [{ type: "text", text: String(block.text ?? "") }];
    if (block?.type === "image" && block.data && block.mimeType) {
      return [{ type: "image", data: String(block.data), mimeType: String(block.mimeType) }];
    }
    return [];
  });
  return normalized.length ? normalized : [{ type: "text", text: "(no output)" }];
}

// Durable stores details as JSON; drop what JSON cannot hold.
function jsonSafe(value) {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
