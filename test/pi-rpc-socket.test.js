import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { requestBroker, startBrokerIpcServer } from "../src/broker-ipc.js";
import { createPiRpcBroker } from "../src/pi/rpc-transport.js";

test("one broker socket carries submissions and Pi RPC end to end", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-pi-rpc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, "broker.sock");
  const workerPath = join(directory, "fake-worker.mjs");
  await writeFile(workerPath, `
let buffer = "";
process.stderr.write("worker diagnostic\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const command = JSON.parse(buffer.slice(0, newline).replace(/\\r$/, ""));
    buffer = buffer.slice(newline + 1);
    // Pi acknowledges prompt only after preflight work such as auto-compaction.
    // Delay it beyond this test client's generic response timeout to prove the
    // prompt remains pending instead of being mistaken for a dead session.
    const respond = () => {
      const rejected = command.message === "reject this prompt";
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: !rejected,
        ...(rejected ? { error: "prompt rejected in preflight" } : {}),
        ...(!rejected && command.type === "prompt" ? { data: { disposition: "started" } } : {}),
        ...(!rejected && command.type === "steer" ? { data: { disposition: "queued" } } : {}),
      }) + "\\n");
    };
    // Pi acknowledges abort only after the whole session is idle. Leave
    // that response pending to prove Telepi treats a written abort as accepted.
    if (command.type === "prompt") setTimeout(respond, 50);
    else if (command.type !== "abort") respond();
    process.stdout.write(JSON.stringify({
      type: "transport_probe",
      command: command.type,
      message: command.message,
    }) + "\\n");
  }
});
`);

  const rpcBroker = createPiRpcBroker();
  const server = await startBrokerIpcServer({
    socketPath,
    onConnection: (frame, peer) => rpcBroker.acceptConnection(frame, peer),
    onRequest: (request) => ({ echoed: request.message }),
  });
  t.after(() => server.close());

  assert.deepEqual(
    await requestBroker(socketPath, { id: "submit-probe", type: "submit", message: "hello" }),
    { echoed: "hello" },
  );

  const client = rpcBroker.createClient({
    workerPath,
    cwd: directory,
    env: { TELEPI_BROKER_SOCKET: socketPath },
    args: [],
    responseTimeoutMs: 10,
  });
  t.after(() => client.stop());
  const events = [];
  client.onEvent((event) => events.push(event));

  await client.start();
  assert.equal(await client.prompt("line one\nline two \u2028 привет"), "started");
  await assert.rejects(client.prompt("reject this prompt"), /prompt rejected in preflight/);
  assert.equal(await client.steer("change course"), "queued");
  await client.abort();
  await waitFor(() => events.length === 5);

  assert.deepEqual(events, [
    { type: "transport_probe", command: "prompt", message: "line one\nline two \u2028 привет" },
    { type: "transport_probe", command: "prompt", message: "reject this prompt" },
    { type: "transport_probe", command: "steer", message: "change course" },
    { type: "transport_probe", command: "clear_queue" },
    { type: "transport_probe", command: "abort" },
  ]);
  assert.match(client.getStderr(), /worker diagnostic/);
  await client.stop();
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for RPC transport events");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
