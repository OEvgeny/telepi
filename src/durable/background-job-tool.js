import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  BACKGROUND_JOB_MAX_WAIT_SECONDS,
  backgroundJobToolResult,
  runBackgroundJob,
} from "../background-job.js";

export function createDurableBackgroundJobExtension(options = {}) {
  return defineExtension({
    name: "telepi-background-jobs",
    tools: [
      defineTool({
        name: "telepi_run_command",
        label: "Telepi Run Command",
        description: `Run a non-interactive shell command in a detached job in the selected execution environment. The tool waits up to ${BACKGROUND_JOB_MAX_WAIT_SECONDS} seconds, then returns while the command continues. Complete output is written to a persistent path that can be inspected with read in a later turn.`,
        promptSnippet: "Run a potentially long command as a detached job with persistent output",
        promptGuidelines: [
          "Use telepi_run_command instead of bash for non-interactive commands likely to run longer than a few minutes or that must survive the current turn.",
          `It waits at most ${BACKGROUND_JOB_MAX_WAIT_SECONDS} seconds, then returns an output path while the command continues; inspect that path with read later.`,
          "Do not use telepi_run_command for interactive commands or commands that should be cancelled when the current turn stops.",
        ],
        parameters: Type.Object({
          command: Type.String({ description: "Shell command to run in the current workspace." }),
          wait_seconds: Type.Optional(Type.Integer({
            minimum: 0,
            maximum: BACKGROUND_JOB_MAX_WAIT_SECONDS,
            description: `Seconds to wait before returning. Defaults to ${BACKGROUND_JOB_MAX_WAIT_SECONDS}; use 0 to return immediately.`,
          })),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        outputLimits: { maxBytes: 40 * 1024, maxLines: 550, retain: "tail" },
        execute: async (params, api, context) => {
          try {
            const job = await runBackgroundJob(api.env, {
              command: params.command,
              waitSeconds: params.wait_seconds,
              cwd: api.env?.cwd,
              launchMode: options.launchMode,
            }, context);
            // The shared result is shaped for Pi (`content`); Durable reads `output`.
            const { content, ...rest } = backgroundJobToolResult(job);
            return { ...rest, output: content };
          } catch (error) {
            return failed(error);
          }
        },
      }),
    ],
  });
}

function failed(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { output: [{ type: "text", text: `Failed: ${message}` }], isError: true, details: { error: message } };
}
