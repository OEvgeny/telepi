// End-to-end proof that a Durable conversation can look at an image.
//
//   node test/durable-read-image-e2e.mjs
//
// It is deliberately not part of `npm test`: it opens a real Durable Harness in
// a temporary directory and spends one real model call. Everything else (the
// tool, its limits, its content blocks) is covered by
// test/durable-image-tool.test.js without a network.
//
// The generated picture is two horizontal bands, red on top and blue below. A
// model that only ever saw text cannot name them, so a correct answer means the
// image bytes reached the provider as an image content block.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { openDurableHost } from "../src/durable/runtime.js";

const MODEL = process.env.E2E_MODEL || "radiance/qwen4exp";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG of two horizontal bands: `top` above, `bottom` below. */
function bandedPng({ width = 48, height = 48, top = [220, 30, 30], bottom = [30, 60, 220] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    const [r, g, b] = y < height / 2 ? top : bottom;
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const workspace = await mkdtemp(join(tmpdir(), "telepi-durable-image-"));
const imagePath = join(workspace, "bands.png");
await writeFile(imagePath, bandedPng());

const runtime = await openDurableHost({
  storageDir: join(workspace, "durable"),
  infrastructureAgentDir: process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent"),
  projectRoot: workspace,
  gatewayRequest: () => Promise.reject(new Error("gateway tools are not part of this test")),
  onReport: (error) => console.error(`report: ${error instanceof Error ? error.message : error}`),
});

let ok = false;
try {
  const endpointKey = "e2e:read-image";
  const { conversationId } = await runtime.ensureEndpoint({
    endpointKey,
    agentId: "aesop",
    agentDir: workspace,
    cwd: workspace,
    modelSpec: MODEL,
    location: { type: "local" },
    chatId: "0",
    topicId: null,
    topicName: "Read image e2e",
  });

  const { submissionId } = await runtime.submit(endpointKey, {
    requestId: "e2e:read-image:1",
    content: "Call the read_image tool on bands.png, then answer in one sentence: which two colors do you see, and which one is on top?",
  });
  const result = await runtime.waitSubmission(endpointKey, submissionId);
  const answer = result.answers.map((entry) => entry.text ?? "").join("\n");
  console.log(`model: ${MODEL}`);
  console.log(`status: ${result.status}`);
  console.log(`answer: ${answer.trim()}`);

  const conversation = await runtime.harness.conversation(conversationId, {});
  const view = await conversation.context({});
  const transcript = JSON.stringify(view.entries);

  assert.match(transcript, /"name":"read_image"/, "the model never called read_image");
  assert.match(transcript, /"mimeType":"image\/png"/, "no image block reached the transcript");
  assert.match(transcript, /"type":"image","data":"[A-Za-z0-9+/=]{100,}","mimeType":"image\/png"/, "the image block carries no bytes");

  const text = answer.toLowerCase();
  assert.ok(text.includes("red") || text.includes("красн"), `answer does not name red: ${text}`);
  assert.ok(text.includes("blue") || text.includes("син"), `answer does not name blue: ${text}`);

  const toolEntries = view.entries.filter((entry) => JSON.stringify(entry).includes("read_image"));
  console.log(`tool entries: ${toolEntries.length}, entries: ${view.entries.length}`);
  ok = true;
  console.log("e2e: read_image works — the model saw the picture");
} finally {
  await runtime.close({ waitForIdle: true });
  if (ok && process.env.E2E_KEEP !== "1") await rm(workspace, { recursive: true, force: true });
  else console.log(`workspace kept: ${workspace}`);
}
