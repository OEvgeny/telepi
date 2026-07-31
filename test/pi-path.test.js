import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { prependExecutableDirToPath, resolvePiCliPath, resolvePiPackageIndex } from "../src/pi-path.js";

function makePiInstall(root) {
  const binDir = join(root, ".npm", "bin");
  mkdirSync(binDir, { recursive: true });
  const cliPath = join(binDir, "pi");
  const indexPath = join(binDir, "index.js");
  writeFileSync(cliPath, "#!/bin/sh\n", "utf8");
  writeFileSync(indexPath, "export {};\n", "utf8");
  chmodSync(cliPath, 0o755);
  return { cliPath, indexPath };
}

test("resolves pi from HOME when a boot-like environment has no PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "telepi-pi-home-"));
  try {
    const { cliPath, indexPath } = makePiInstall(home);
    const env = { HOME: home, PATH: "" };

    assert.equal(resolvePiCliPath(env), resolve(cliPath));
    assert.equal(resolvePiPackageIndex(env), resolve(indexPath));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uses an explicit absolute TELEPI_PI_BIN without PATH discovery", () => {
  const home = mkdtempSync(join(tmpdir(), "telepi-pi-explicit-"));
  try {
    const { cliPath } = makePiInstall(home);
    assert.equal(resolvePiCliPath({ TELEPI_PI_BIN: cliPath, HOME: "/missing", PATH: "" }), resolve(cliPath));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("prepends the running executable directory to a stripped child PATH", () => {
  const path = prependExecutableDirToPath(process.execPath, "");
  assert.equal(path, dirname(process.execPath));

  const existing = ["/example/bin", dirname(process.execPath)].join(delimiter);
  assert.equal(prependExecutableDirToPath(process.execPath, existing), [dirname(process.execPath), "/example/bin"].join(delimiter));
});

test("rejects invalid TELEPI_PI_BIN instead of silently selecting another pi", () => {
  assert.throws(
    () => resolvePiCliPath({ TELEPI_PI_BIN: "relative/pi", HOME: process.env.HOME, PATH: process.env.PATH }),
    /must be an absolute path/,
  );
  assert.throws(
    () => resolvePiCliPath({ TELEPI_PI_BIN: "/definitely/missing/pi", HOME: process.env.HOME, PATH: process.env.PATH }),
    /not an executable file/,
  );
});
