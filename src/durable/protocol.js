export const DURABLE_PROTOCOL_VERSION = 1;
export const DURABLE_PROTOCOL = `telepi.durable/${DURABLE_PROTOCOL_VERSION}`;
export const MAX_DURABLE_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_DURABLE_PENDING_REQUESTS = 256;
export const DURABLE_READY_TIMEOUT_MS = 30_000;

export function durableFrame(type, fields = {}) {
  return { protocol: DURABLE_PROTOCOL, type, ...fields };
}

export function isDurableFrame(frame) {
  return frame?.protocol === DURABLE_PROTOCOL && typeof frame.type === "string";
}

export function isDurableConnectFrame(frame) {
  return isDurableFrame(frame)
    && frame.type === "host.connect"
    && typeof frame.nonce === "string"
    && frame.nonce.length > 0;
}

export function assertDurableFrame(frame) {
  if (!isDurableFrame(frame)) {
    throw new Error(`Unsupported Durable protocol frame: ${frame?.protocol || frame?.type || "unknown"}`);
  }
  return frame;
}
