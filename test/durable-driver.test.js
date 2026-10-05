import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  connectBrokerPeer,
  requestBroker,
  startBrokerIpcServer,
} from "../src/broker-ipc.js";
import { DurableDriver } from "../src/durable/driver.js";
import { durableFrame } from "../src/durable/protocol.js";
import { acquireDurableStorageLock } from "../src/durable/storage-lock.js";

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("DurableDriver has side-effect-free construction and coalesces concurrent init", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-driver-"));
  const socketPath = join(directory, "broker.sock");
  const storageDir = join(directory, "store");
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  t.after(() => rm(directory, { recursive: true, force: true }));

  let spawnCount = 0;
  let spawnedChild;
  const driver = new DurableDriver({
    socketPath,
    storageDir,
    projectRoot: directory,
    infrastructureAgentDir: agentDir,
    readyTimeoutMs: 15_000,
    log: () => undefined,
    spawnProcess: (...args) => {
      spawnCount += 1;
      spawnedChild = spawn(...args);
      return spawnedChild;
    },
  });
  assert.equal(await missing(storageDir), true);

  const server = await startBrokerIpcServer({
    socketPath,
    onConnection: (frame, peer) => driver.acceptConnection(frame, peer),
    onRequest: (request) => ({ ordinary: request.id }),
  });
  t.after(() => server.close());
  t.after(() => driver.drainAndClose());

  await Promise.all([driver.init(), driver.init(), driver.init()]);
  assert.equal(spawnCount, 1);
  assert.equal(driver.isReady, true);
  assert.deepEqual(await driver.inspect(), {
    scheduling: "running",
    taskCount: 0,
    submissionCount: 0,
    idle: true,
    reports: [],
  });

  assert.deepEqual(await requestBroker(socketPath, { id: "ordinary" }), { ordinary: "ordinary" });
  const stale = await connectBrokerPeer(socketPath);
  await stale.send(durableFrame("host.connect", { nonce: "stale" }));
  const rejected = await stale.read();
  assert.equal(rejected.type, "host.rejected");
  assert.match(rejected.error, /Stale or unknown/);
  stale.destroy();

  spawnedChild.kill("SIGTERM");
  await new Promise((resolvePromise) => spawnedChild.once("exit", resolvePromise));
  assert.equal((await driver.inspect()).idle, true);
  assert.equal(spawnCount, 2);

  await driver.drainAndClose();
  assert.equal(driver.isClosing, true);
  const released = await acquireDurableStorageLock(storageDir, { nonce: "after-drain", retries: 0 });
  await released.release();
});

test("Durable storage lock refuses a second live owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await acquireDurableStorageLock(directory, { nonce: "one", retries: 0, staleMs: 10_000 });
  t.after(() => first.release());
  await assert.rejects(
    acquireDurableStorageLock(directory, { nonce: "two", retries: 0, staleMs: 10_000 }),
    /already owned/,
  );
});
