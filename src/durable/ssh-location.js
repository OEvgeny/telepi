import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolvePath } from "../config.js";

export function durableSshKnownHostsPath(projectRoot) {
  return join(projectRoot, ".telepi", "durable-host", "ssh-known-hosts");
}

export function sshTargetFromLocation(location, { projectRoot, knownHostsFile } = {}) {
  if (location?.type !== "ssh") throw new Error("Durable SSH target requires an ssh session location");
  const target = {
    host: String(location.host),
    knownHostsFile: knownHostsFile || durableSshKnownHostsPath(projectRoot),
    hostKeyAlias: sshHostKeyAlias(location),
  };
  if (location.user) target.user = String(location.user);
  if (location.port != null) target.port = Number(location.port);
  if (location.identity_file) target.identityFile = resolvePath(projectRoot, String(location.identity_file));
  if (location.config_file) target.configFile = resolvePath(projectRoot, String(location.config_file));
  return target;
}

export function sshHostKeyAlias(location) {
  const identity = JSON.stringify({
    host: String(location.host),
    user: location.user ? String(location.user) : null,
    port: location.port == null ? null : Number(location.port),
    configFile: location.config_file ? String(location.config_file) : null,
  });
  return `telepi-pi-env-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function sshEnvironmentId(location) {
  const identity = JSON.stringify({
    hostKeyAlias: sshHostKeyAlias(location),
    identityFile: location.identity_file ? String(location.identity_file) : null,
  });
  return `pi-env:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function sshConnectionKey(location, options = {}) {
  const target = sshTargetFromLocation(location, options);
  return JSON.stringify({
    host: target.host,
    user: target.user || null,
    port: target.port || null,
    identityFile: target.identityFile || null,
    configFile: target.configFile || null,
    knownHostsFile: target.knownHostsFile,
    hostKeyAlias: target.hostKeyAlias,
  });
}
