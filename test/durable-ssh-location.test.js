import assert from "node:assert/strict";
import test from "node:test";
import {
  durableSshKnownHostsPath,
  sshConnectionKey,
  sshEnvironmentId,
  sshHostKeyAlias,
  sshTargetFromLocation,
} from "../src/durable/ssh-location.js";

test("Durable SSH targets use application host keys and stable connection identities", () => {
  const projectRoot = "/srv/telepi";
  const location = {
    type: "ssh",
    host: "tablet-alias",
    user: "agent",
    port: 8022,
    identity_file: "private/id_ed25519",
    config_file: "private/ssh_config",
    cwd: "/remote/project",
  };
  const target = sshTargetFromLocation(location, { projectRoot });
  assert.equal(target.knownHostsFile, "/srv/telepi/.telepi/durable-host/ssh-known-hosts");
  assert.equal(target.identityFile, "/srv/telepi/private/id_ed25519");
  assert.equal(target.configFile, "/srv/telepi/private/ssh_config");
  assert.match(target.hostKeyAlias, /^telepi-pi-env-[a-f0-9]{24}$/);
  assert.equal(target.hostKeyAlias, sshHostKeyAlias(location));
  assert.match(sshEnvironmentId(location), /^pi-env:[a-f0-9]{24}$/);
  assert.equal(durableSshKnownHostsPath(projectRoot), target.knownHostsFile);

  const changedIdentity = { ...location, identity_file: "private/other_key" };
  assert.notEqual(
    sshConnectionKey(location, { projectRoot }),
    sshConnectionKey(changedIdentity, { projectRoot }),
  );
  assert.equal(sshHostKeyAlias(location), sshHostKeyAlias(changedIdentity));
  assert.notEqual(sshEnvironmentId(location), sshEnvironmentId(changedIdentity));
});
