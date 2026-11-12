import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

// Durable's own `read` tool refuses images ("reading images is not supported"),
// so a Durable topic cannot look at a screenshot or a photo without this. The
// bytes are read through the conversation's ExecutionEnv, so the same tool works
// on a local workspace and on an SSH location the gateway never touches.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectImageMimeType(bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[3] !== 0xf7) {
    return "image/jpeg";
  }
  if (buffer.length >= 16 && startsWith(buffer, PNG_SIGNATURE) && startsWithAscii(buffer, 12, "IHDR")) {
    return "image/png";
  }
  if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) return "image/gif";
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
  if (startsWithAscii(buffer, 0, "BM") && buffer.length >= 26) return "image/bmp";
  return undefined;
}

export function describeImage({ path, mimeType, bytes }) {
  return `Image ${path} (${mimeType}, ${bytes} bytes)`;
}

export function createDurableImageExtension() {
  return defineExtension({
    name: "telepi-image",
    tools: [
      defineTool({
        name: "read_image",
        label: "Telepi Read Image",
        description: "Read an image file (PNG, JPEG, GIF, WebP or BMP) and return the picture itself, so you can see it. The image is attached to the tool result; the text part only names the file. For text files use read.",
        promptSnippet: "Look at an image file in the workspace: screenshots, photos, diagrams",
        promptGuidelines: [
          "Use read_image instead of read when the path ends in .png, .jpg, .jpeg, .gif, .webp or .bmp: read refuses images.",
          "Read one image per step, describe what you actually see, and only then read another.",
          "The file must be at most 5 MB; resize or convert a larger image first.",
        ],
        parameters: Type.Object({
          path: Type.String({ description: "Path to the image file (relative or absolute)" }),
        }),
        replay: "safe",
        executionMode: "sequential",
        execute: async (params, api, context) => {
          const env = api.env;
          if (!env) return failed("No execution environment is configured");
          try {
            const absolute = await resolvePath(env, params.path, context);
            const opened = await env.openBinaryReader(absolute, undefined, context);
            if (!opened.ok) throw opened.error;
            const reader = opened.value;
            try {
              const info = await reader.info(context);
              if (!info.ok) throw info.error;
              if (info.value.size > MAX_IMAGE_BYTES) {
                return failed(`${absolute} is ${info.value.size} bytes; the limit is ${MAX_IMAGE_BYTES}. Resize or convert it first.`);
              }
              const read = await reader.read(0, MAX_IMAGE_BYTES + 1, context);
              if (!read.ok) throw read.error;
              const bytes = read.value;
              if (bytes.length > MAX_IMAGE_BYTES) {
                return failed(`${absolute} is larger than the ${MAX_IMAGE_BYTES}-byte limit. Resize or convert it first.`);
              }
              const mimeType = detectImageMimeType(bytes);
              if (!mimeType) {
                return failed(`${absolute} is not a PNG, JPEG, GIF, WebP or BMP image. Use read for text files.`);
              }
              return {
                content: [
                  { type: "text", text: describeImage({ path: absolute, mimeType, bytes: bytes.length }) },
                  { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
                ],
                details: { path: absolute, mimeType, bytes: bytes.length },
              };
            } finally {
              await reader.close(context);
            }
          } catch (error) {
            return failed(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    ],
  });
}

async function resolvePath(env, path, context) {
  const normalized = String(path ?? "").trim().replace(/^@/, "");
  if (!normalized) throw new Error("path is empty");
  const resolved = await env.absolutePath(normalized, context);
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}

function failed(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { error: message },
  };
}

function startsWith(bytes, signature) {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function startsWithAscii(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}
