#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findTopic, getAgent, readConfig, resolveTopicSession } from "../config.js";
import { assertSupportedPiSdk, resolvePiPackageIndex } from "./path.js";
import { createTopicRuntime } from "./runtime.js";

export function parseWorkerArgs(argv) {
  const values = {};
  const known = new Set([
    "--mode",
    "--config",
    "--chat-id",
    "--topic-id",
    "--expected-topic-name",
    "--expected-agent",
    "--expected-session-id",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!known.has(name)) throw new Error(`Unknown worker option: ${name}`);
    if (index + 1 >= argv.length) throw new Error(`Missing value for worker option: ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate worker option: ${name}`);
    values[name] = argv[index + 1];
    index += 1;
  }

  const required = ["--config", "--chat-id", "--topic-id", "--expected-agent", "--expected-session-id"];
  for (const name of required) {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing worker option: ${name}`);
  }
  if (values["--mode"] && values["--mode"] !== "rpc") {
    throw new Error(`Unsupported worker mode: ${values["--mode"]}`);
  }

  return {
    mode: values["--mode"] || "rpc",
    configPath: resolve(values["--config"]),
    chatId: values["--chat-id"],
    topicId: values["--topic-id"] === "" ? null : values["--topic-id"],
    expectedTopicName: values["--expected-topic-name"],
    expectedAgent: values["--expected-agent"],
    expectedSessionId: values["--expected-session-id"],
  };
}

export function resolveWorkerTopic(config, args) {
  const topic = findTopic(config, args.chatId, args.topicId);
  if (!topic) {
    throw new Error(`Worker route no longer exists for chat=${args.chatId} topic=${args.topicId ?? ""}`);
  }
  if (topic.enabled === false) throw new Error(`Worker route is disabled: ${topic.name}`);
  if (args.expectedTopicName && topic.name !== args.expectedTopicName) {
    throw new Error(`Worker topic changed before startup: ${topic.name} != ${args.expectedTopicName}`);
  }
  if (String(topic.agent) !== String(args.expectedAgent)) {
    throw new Error(`Worker agent changed before startup: ${topic.agent} != ${args.expectedAgent}`);
  }

  const agent = getAgent(config, topic.agent);
  const sessionId = resolveTopicSession(config, topic, { agent }).id;
  if (sessionId !== String(args.expectedSessionId)) {
    throw new Error(`Worker session changed before startup: ${sessionId} != ${args.expectedSessionId}`);
  }
  return topic;
}

export async function runWorker(argv = process.argv.slice(2)) {
  const args = parseWorkerArgs(argv);
  const config = readConfig(args.configPath);
  const topic = resolveWorkerTopic(config, args);
  const pi = await import(pathToFileURL(resolvePiPackageIndex()).href);
  assertSupportedPiSdk(pi);
  const { runtime } = await createTopicRuntime(pi, config, topic);

  for (const diagnostic of runtime.diagnostics) {
    console.error(`${diagnostic.type}: ${diagnostic.message}`);
  }
  if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    await runtime.dispose();
    throw new Error("Pi runtime initialization failed");
  }
  if (!runtime.session.model) {
    await runtime.dispose();
    throw new Error("No Pi model is available for the configured topic");
  }

  if (!isTruthyEnvFlag(process.env.PI_OFFLINE)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void runtime.services.modelRuntime
      .refresh({ signal: controller.signal })
      .catch(() => undefined)
      .finally(() => clearTimeout(timeout));
  }

  await pi.runRpcMode(runtime);
}

function isTruthyEnvFlag(value) {
  return value === "1" || value === "true" || value === "yes";
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runWorker().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
