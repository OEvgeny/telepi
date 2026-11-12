import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_IMAGE_BYTES,
  createDurableImageExtension,
  describeImage,
  detectImageMimeType,
} from "../src/durable/image-tool.js";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

function fakeEnv(bytes, { size = bytes.length } = {}) {
  const calls = { read: 0, close: 0, absolutePath: [] };
  const env = {
    async absolutePath(path) {
      calls.absolutePath.push(path);
      return { ok: true, value: path.startsWith("/") ? path : `/workspace/${path}` };
    },
    async openBinaryReader(path) {
      calls.opened = path;
      return {
        ok: true,
        value: {
          async info() {
            return { ok: true, value: { size, mtimeMs: 1 } };
          },
          async read() {
            calls.read += 1;
            return { ok: true, value: bytes };
          },
          async close() {
            calls.close += 1;
          },
        },
      };
    },
  };
  return { env, calls };
}

const tool = createDurableImageExtension().tools[0];

test("the image tool is registered under the expected name", () => {
  const extension = createDurableImageExtension();
  assert.equal(extension.name, "telepi-image");
  assert.deepEqual(extension.tools.map((entry) => entry.name), ["read_image"]);
  assert.equal(tool.replay, "safe");
});

test("image signatures are accepted and everything else is not", () => {
  assert.equal(detectImageMimeType(PNG), "image/png");
  assert.equal(detectImageMimeType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), "image/jpeg");
  assert.equal(detectImageMimeType(Uint8Array.from([0xff, 0xd8, 0xff, 0xf7, 0x00])), undefined, "lossless JPEG");
  assert.equal(detectImageMimeType(Buffer.from("GIF89a......")), "image/gif");
  assert.equal(detectImageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(detectImageMimeType(Buffer.from("BM" + "\0".repeat(40))), "image/bmp");
  assert.equal(detectImageMimeType(Buffer.from("not an image at all")), undefined);
  assert.equal(detectImageMimeType(Buffer.alloc(0)), undefined);
});

test("a PNG comes back as an image content block", async () => {
  const { env, calls } = fakeEnv(PNG);
  const result = await tool.execute({ path: "shot.png" }, { env }, {});

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content[0], {
    type: "text",
    text: describeImage({ path: "/workspace/shot.png", mimeType: "image/png", bytes: PNG.length }),
  });
  assert.deepEqual(result.content[1], {
    type: "image",
    data: Buffer.from(PNG).toString("base64"),
    mimeType: "image/png",
  });
  assert.deepEqual(calls.absolutePath, ["shot.png"]);
  assert.equal(calls.opened, "/workspace/shot.png");
  assert.equal(calls.close, 1, "the reader is closed even on success");
  assert.deepEqual(result.details, { path: "/workspace/shot.png", mimeType: "image/png", bytes: PNG.length });
});

test("a leading @ is stripped like the other coding tools do", async () => {
  const { env, calls } = fakeEnv(PNG);
  await tool.execute({ path: "@shot.png" }, { env }, {});
  assert.deepEqual(calls.absolutePath, ["shot.png"]);
});

test("text files are refused and pointed at read", async () => {
  const { env } = fakeEnv(Buffer.from("hello, world\n"));
  const result = await tool.execute({ path: "notes.txt" }, { env }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not a PNG, JPEG, GIF, WebP or BMP image/);
  assert.match(result.content[0].text, /Use read for text files/);
});

test("an oversized image is refused before any byte is read", async () => {
  const { env, calls } = fakeEnv(PNG, { size: MAX_IMAGE_BYTES + 1 });
  const result = await tool.execute({ path: "huge.png" }, { env }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /the limit is 5242880/);
  assert.equal(calls.read, 0);
  assert.equal(calls.close, 1);
});

test("bytes larger than the reported size are still bounded", async () => {
  const { env } = fakeEnv(new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0x89), { size: 10 });
  const result = await tool.execute({ path: "sneaky.png" }, { env }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /larger than the 5242880-byte limit/);
});

test("a missing environment or a failed open is an error result, not a throw", async () => {
  const noEnv = await tool.execute({ path: "shot.png" }, {}, {});
  assert.equal(noEnv.isError, true);
  assert.match(noEnv.content[0].text, /No execution environment/);

  const env = {
    async absolutePath() {
      return { ok: false, error: new Error("permission denied") };
    },
  };
  const result = await tool.execute({ path: "/root/shot.png" }, { env }, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /permission denied/);

  const openFails = {
    async absolutePath(path) {
      return { ok: true, value: path };
    },
    async openBinaryReader() {
      return { ok: false, error: new Error("ENOENT: no such file") };
    },
  };
  const missing = await tool.execute({ path: "/nope.png" }, { env: openFails }, {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /ENOENT/);
});
