import { EventEmitter } from "node:events";
import * as undici from "undici";

const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch;

export function parseHttpIdleTimeoutMs(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (!trimmed) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function applyHttpProxySettings(httpProxy) {
  const proxy = httpProxy?.trim();
  if (!proxy) return;
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = () => {};

function withUndiciErrorListener(dispatcher) {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin, options) {
  return withUndiciErrorListener(new undici.Client(origin, options));
}

function createUndiciOriginDispatcher(origin, options) {
  if (options.connections === 1) return createUndiciClient(origin, options);
  return withUndiciErrorListener(new undici.Pool(origin, {
    ...options,
    factory: createUndiciClient,
  }));
}

// Pi's CLI entrypoint configures Undici from httpIdleTimeoutMs, but its public
// SDK factory only forwards that value to provider clients. Telepi starts the
// public SDK directly, so install the matching transport timeout in each worker.
export function configurePiHttpDispatcher(timeoutMs) {
  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent({
    allowH2: false,
    proxyTunnel: true,
    bodyTimeout: normalizedTimeoutMs,
    connect: {
      autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
    },
    headersTimeout: normalizedTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
  undici.setGlobalDispatcher(dispatcher);

  // Keep fetch and its dispatcher on the same Undici implementation. Preserve
  // deliberate fetch overrides installed by callers after this module loaded.
  const shouldInstallGlobals = installedGlobalFetch === undefined
    ? globalThis.fetch === originalGlobalFetch
    : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }

  return dispatcher;
}
