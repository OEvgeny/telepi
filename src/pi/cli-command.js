import { resolvePath, resolveTopicModel } from "../config.js";
import { buildTopicRunSpec } from "./topic-spec.js";

// Stock Pi command construction is retained only for `topic:pi-command`, which
// prints an operator-facing approximation. Gateway runs use sdk-driver.js.
export function buildPiCliSpec(config, topic, envelope, options = {}) {
  const base = buildTopicRunSpec(config, topic, envelope, options);
  const args = ["--session-dir", config.project.sessions_dir];
  if (options.session) {
    args.push("--session", resolvePath(config.project.root, options.session));
  } else if (options.fork) {
    args.push("--fork", resolvePath(config.project.root, options.fork));
  } else {
    args.push("--session-id", base.sessionId);
  }

  if (options.name) args.push("--name", String(options.name));
  for (const extension of config.project.extensions || []) {
    args.push("--extension", resolvePath(config.project.root, extension));
  }
  for (const skill of base.agent.skills || []) {
    args.push("--skill", resolvePath(config.project.root, skill));
  }
  for (const extension of base.agent.extensions || []) {
    args.push("--extension", resolvePath(config.project.root, extension));
  }
  if (base.agent.system_prompt) {
    args.push("--append-system-prompt", base.agent.system_prompt);
  }

  const model = resolveTopicModel(config, topic, base.agent);
  if (model) args.push("--model", model);
  return {
    ...base,
    args,
    env: base.location
      ? { ...base.env, PI_CODING_AGENT_DIR: base.entityDir }
      : base.env,
  };
}
