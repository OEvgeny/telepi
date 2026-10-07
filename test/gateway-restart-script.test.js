import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = readFileSync(new URL("../scripts/restart-gateway-when-idle.sh", import.meta.url), "utf8");

test("normal gateway restart keeps Durable available until other gateway work drains", () => {
  assert.match(script, /\/src\/durable\/host\.js/);
  assert.match(script, /non_durable_workers/);
  assert.match(script, /-n "\$durable_workers" && -z "\$non_durable_workers"/);
  assert.match(script, /node bin\/telepi\.js gateway:drain/);
  assert.match(script, /Durable host drain failed; no restart attempted/);
  assert.match(script, /durable_roots/);
  assert.match(script, /is_descendant_of_any "\$pid" "\$durable_roots"/);
  assert.match(script, /\/\^PPid:\//);
  assert.match(script, /cmdline=.*\$PROC_ROOT\/\$pid\/cmdline.*\|\| true/);
  assert.match(script, /if \[\[ "\$FORCE" == true \]\]/);
});

test("Durable transport descendants do not block a drain-first restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "telepi-restart-tree-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cgroupRoot = join(directory, "cgroup");
  const procRoot = join(directory, "proc");
  const binDir = join(directory, "bin");
  const cgroupProcs = join(cgroupRoot, "fake", "cgroup.procs");
  const restartMarker = join(directory, "restarted");
  mkdirSync(join(cgroupRoot, "fake"), { recursive: true });
  mkdirSync(binDir);
  for (const pid of [200, 201]) mkdirSync(join(procRoot, String(pid)), { recursive: true });
  writeFileSync(cgroupProcs, "100\n200\n201\n");
  writeFileSync(join(procRoot, "200", "cmdline"), "node\0/src/durable/host.js\0");
  writeFileSync(join(procRoot, "200", "status"), "Name:\tdurable\nPPid:\t100\n");
  writeFileSync(join(procRoot, "201", "cmdline"), "ssh\0serve\0");
  writeFileSync(join(procRoot, "201", "status"), "Name:\tssh\nPPid:\t200\n");

  const systemctl = join(binDir, "systemctl");
  writeFileSync(systemctl, `#!/usr/bin/env bash
if [[ "$*" == *"-p MainPID"* ]]; then printf '100\\n'
elif [[ "$*" == *"-p ControlGroup"* ]]; then printf '/fake\\n'
elif [[ "$*" == *" restart "* ]]; then printf 'yes\\n' > "$RESTART_MARKER"
else exit 2
fi
`);
  const node = join(binDir, "node");
  writeFileSync(node, `#!/usr/bin/env bash
printf '100\\n' > "$FAKE_CGROUP_PROCS"
`);
  chmodSync(systemctl, 0o755);
  chmodSync(node, 0o755);

  const result = spawnSync(new URL("../scripts/restart-gateway-when-idle.sh", import.meta.url).pathname, [
    "--service", "fake.service",
    "--stable-seconds", "0",
    "--timeout-seconds", "2",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SYSTEMCTL_BIN: systemctl,
      CGROUP_ROOT: cgroupRoot,
      PROC_ROOT: procRoot,
      FAKE_CGROUP_PROCS: cgroupProcs,
      RESTART_MARKER: restartMarker,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /asking Durable host to drain and close: 200 201/);
  assert.equal(readFileSync(restartMarker, "utf8"), "yes\n");
});
