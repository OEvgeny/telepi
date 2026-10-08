import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, RemoteExecutionEnv, packagedDaemon } from "@earendil-works/pi-env";

import { backgroundJobToolResult, runBackgroundJob } from "../src/background-job.js";
import { createDurableBackgroundJobExtension } from "../src/durable/background-job-tool.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "telepi-background-job-"));
  const workspace = join(directory, "work");
  const state = join(directory, "state");
  await mkdir(workspace);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, workspace, state };
}

async function eventually(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error("condition did not become true");
}

test("background jobs return completed output and a persistent receipt", async (t) => {
  const paths = await fixture(t);
  const env = new NodeExecutionEnv({
    cwd: paths.workspace,
    shellEnv: { XDG_STATE_HOME: paths.state },
  });

  const job = await runBackgroundJob(env, {
    command: 'printf "job-output\\n"',
    launchMode: "process",
  }, BACKGROUND_CONTEXT);

  assert.equal(job.state, "finished");
  assert.equal(job.waitSeconds, 180);
  assert.equal(job.exitCode, 0);
  assert.match(job.outputTail, /job-output/);
  assert.match(job.directory, new RegExp(`^${escapeRegex(join(paths.state, "telepi", "jobs"))}`));
  assert.match(await readFile(job.outputPath, "utf8"), /exit_code=0/);
  assert.deepEqual(JSON.parse(await readFile(job.statusPath, "utf8")).exitCode, 0);

  const toolResult = backgroundJobToolResult(job);
  assert.equal(toolResult.isError, undefined);
  assert.match(toolResult.content[0].text, new RegExp(escapeRegex(job.outputPath)));

  const invalid = await runBackgroundJob(env, {
    command: "if",
    waitSeconds: 2,
    launchMode: "process",
  }, BACKGROUND_CONTEXT);
  assert.equal(invalid.state, "finished");
  assert.notEqual(invalid.exitCode, 0);
  assert.equal(backgroundJobToolResult(invalid).isError, true);
  assert.match(invalid.outputTail, /syntax error/i);
});

test("the wait limit yields without terminating the detached job", async (t) => {
  const paths = await fixture(t);
  const env = new NodeExecutionEnv({
    cwd: paths.workspace,
    shellEnv: { XDG_STATE_HOME: paths.state },
  });

  const job = await runBackgroundJob(env, {
    command: 'sleep 1.2; printf "after-yield\\n"',
    waitSeconds: 1,
    launchMode: "process",
  }, BACKGROUND_CONTEXT);
  assert.equal(job.state, "running");
  assert.match(job.waitError, /^timeout:/);

  await eventually(async () => {
    const output = await readFile(job.outputPath, "utf8");
    assert.match(output, /after-yield/);
    assert.match(output, /exit_code=0/);
  });
});

test("local jobs escape the caller cgroup in a transient systemd unit", async (t) => {
  if (process.platform !== "linux" || !userSystemdAvailable()) return t.skip("no user systemd manager");
  const paths = await fixture(t);
  const env = new NodeExecutionEnv({
    cwd: paths.workspace,
    shellEnv: { XDG_STATE_HOME: paths.state, TELEPI_JOB_TEST_ENV: "preserved" },
  });

  const job = await runBackgroundJob(env, {
    command: 'sleep 0.3; printf "systemd-job:%s\\n" "$TELEPI_JOB_TEST_ENV"',
    waitSeconds: 0,
  }, BACKGROUND_CONTEXT);
  t.after(() => {
    if (job.unit) runSystemctl(["stop", job.unit]);
  });

  assert.equal(job.launcher, "systemd");
  assert.ok(job.unit);
  const jobCgroup = runSystemctl(["show", job.unit, "-p", "ControlGroup", "--value"]);
  assert.match(jobCgroup, new RegExp(`${escapeRegex(job.unit)}\\.service$`));
  const gatewayCgroup = runSystemctl(["show", "telepi-gateway.service", "-p", "ControlGroup", "--value"]);
  if (gatewayCgroup) {
    assert.notEqual(jobCgroup, gatewayCgroup);
    assert.equal(jobCgroup.startsWith(`${gatewayCgroup}/`), false);
  }

  await eventually(async () => {
    assert.match(await readFile(job.outputPath, "utf8"), /systemd-job:preserved/);
  });
});

test("detached jobs outlive a remote execution environment and remain inspectable", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX detached-job canary");
  const paths = await fixture(t);
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const connection = new Connection({ command: [packagedDaemon({ platform, arch })] });
  const env = new RemoteExecutionEnv({
    connection,
    id: "test:remote",
    cwd: paths.workspace,
    shellEnv: { XDG_STATE_HOME: paths.state },
  });

  const job = await runBackgroundJob(env, {
    command: 'sleep 0.3; printf "after-cleanup\\n"',
    waitSeconds: 0,
    launchMode: "process",
  }, BACKGROUND_CONTEXT);
  assert.equal(job.state, "running");
  assert.equal(job.launcher, "process");
  await env.cleanup(BACKGROUND_CONTEXT);
  connection.close();

  await eventually(async () => {
    const output = await readFile(job.outputPath, "utf8");
    assert.match(output, /after-cleanup/);
    assert.match(output, /exit_code=0/);
  });
});

test("Durable background tool uses its selected execution environment", async (t) => {
  const paths = await fixture(t);
  const env = new NodeExecutionEnv({
    cwd: paths.workspace,
    shellEnv: { XDG_STATE_HOME: paths.state },
  });
  const extension = createDurableBackgroundJobExtension({ launchMode: "process" });
  const tool = extension.tools.find(({ name }) => name === "telepi_run_command");
  assert.ok(tool);

  const result = await tool.execute({ command: "pwd", wait_seconds: 2 }, {
    env,
    conversationId: "conversation",
    callId: "call",
  }, BACKGROUND_CONTEXT);

  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.details.state, "finished");
  assert.match(result.content[0].text, new RegExp(escapeRegex(paths.workspace)));
});

function userSystemdAvailable() {
  try {
    execFileSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runSystemctl(args) {
  try {
    return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
