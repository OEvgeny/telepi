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

test("Durable host can call gateway tools over the promoted peer protocol", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-bidirectional-"));
  const socketPath = join(directory, "broker.sock");
  const storageDir = join(directory, "store");
  const agentDir = join(directory, "agent");
  const hostPath = join(directory, "fake-host.mjs");
  const resultPath = join(directory, "gateway-response.json");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  await writeFile(hostPath, `
    import { writeFile } from "node:fs/promises";
    import { connectBrokerPeer } from ${JSON.stringify(new URL("../src/broker-ipc.js", import.meta.url).href)};
    import { durableFrame } from ${JSON.stringify(new URL("../src/durable/protocol.js", import.meta.url).href)};
    const argv = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
      if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
      return pairs;
    }, []));
    const peer = await connectBrokerPeer(argv.socket);
    await peer.send(durableFrame("host.connect", { nonce: argv.nonce, pid: process.pid }));
    await peer.read();
    await peer.send(durableFrame("host.ready", { nonce: argv.nonce, pid: process.pid }));
    await peer.send(durableFrame("gateway.request", {
      nonce: argv.nonce,
      id: "gateway-one",
      method: "test.echo",
      params: { value: 42 },
    }));
    const gatewayResponse = await peer.read();
    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(gatewayResponse));
    for (;;) {
      const request = await peer.read();
      await peer.send(durableFrame("response", {
        nonce: argv.nonce,
        id: request.id,
        success: true,
        data: request.method === "host.shutdown" ? { closed: true } : {},
      }));
      if (request.method === "host.shutdown") break;
    }
    peer.end();
  `);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const calls = [];
  const driver = new DurableDriver({
    socketPath,
    storageDir,
    projectRoot: directory,
    infrastructureAgentDir: agentDir,
    hostPath,
    readyTimeoutMs: 15_000,
    log: () => undefined,
    gatewayRequestHandler: async (method, params) => {
      calls.push({ method, params });
      return { echoed: params.value };
    },
  });
  const server = await startBrokerIpcServer({
    socketPath,
    onConnection: (frame, peer) => driver.acceptConnection(frame, peer),
    onRequest: () => ({}),
  });
  t.after(() => server.close());
  t.after(() => driver.drainAndClose());
  await driver.init();
  for (let attempt = 0; attempt < 100 && await missing(resultPath); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const response = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(resultPath, "utf8")));
  assert.deepEqual(calls, [{ method: "test.echo", params: { value: 42 } }]);
  assert.equal(response.type, "gateway.response");
  assert.equal(response.success, true);
  assert.deepEqual(response.data, { echoed: 42 });
  await driver.drainAndClose();
});

test("a long Durable shutdown preserves the gateway broker response", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-durable-long-drain-"));
  const socketPath = join(directory, "broker.sock");
  const storageDir = join(directory, "store");
  const agentDir = join(directory, "agent");
  const hostPath = join(directory, "slow-host.mjs");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  await writeFile(hostPath, `
    import { connectBrokerPeer } from ${JSON.stringify(new URL("../src/broker-ipc.js", import.meta.url).href)};
    import { durableFrame } from ${JSON.stringify(new URL("../src/durable/protocol.js", import.meta.url).href)};
    const argv = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
      if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
      return pairs;
    }, []));
    const peer = await connectBrokerPeer(argv.socket);
    await peer.send(durableFrame("host.connect", { nonce: argv.nonce, pid: process.pid }));
    await peer.read();
    await peer.send(durableFrame("host.ready", { nonce: argv.nonce, pid: process.pid }));
    const request = await peer.read();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    await peer.send(durableFrame("response", {
      nonce: argv.nonce,
      id: request.id,
      success: true,
      data: { closed: true },
    }));
    peer.end();
  `);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const driver = new DurableDriver({
    socketPath,
    storageDir,
    projectRoot: directory,
    infrastructureAgentDir: agentDir,
    hostPath,
    readyTimeoutMs: 15_000,
    log: () => undefined,
  });
  const server = await startBrokerIpcServer({
    socketPath,
    initialFrameTimeoutMs: 10,
    onConnection: (frame, peer) => driver.acceptConnection(frame, peer),
    onRequest: async (request) => {
      assert.equal(request.type, "durable_host_drain");
      await driver.drainAndClose();
      return { closed: true };
    },
  });
  t.after(() => server.close());
  t.after(() => driver.drainAndClose());
  await driver.init();

  const response = await requestBroker(socketPath, {
    id: "slow-drain",
    type: "durable_host_drain",
  }, { timeoutMs: 1_000 });
  assert.deepEqual(response, { closed: true });
  assert.equal(driver.isClosing, true);
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
