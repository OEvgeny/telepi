import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  assertSupportedPiSdk,
  prependExecutableDirToPath,
  resolvePiCliPath,
  resolvePiPackageIndex,
} from "../src/pi/path.js";

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

test("resolves the public pi SDK export from a nix store layout", () => {
  const root = mkdtempSync(join(tmpdir(), "telepi-pi-nixstore-"));
  try {
    const binDir = join(root, "bin");
    const packageRoot = join(root, "lib", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
    const packageDir = join(packageRoot, "dist");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });
    const cliPath = join(binDir, "pi");
    const indexPath = join(packageDir, "index.js");
    writeFileSync(cliPath, "#!/bin/sh\n", "utf8");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      exports: { ".": { import: "./dist/index.js" } },
    }), "utf8");
    writeFileSync(indexPath, "export {};\n", "utf8");
    chmodSync(cliPath, 0o755);

    assert.equal(resolvePiPackageIndex({ TELEPI_PI_BIN: cliPath, HOME: "/missing", PATH: "" }), resolve(indexPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers a relocated pi package from an executable wrapper", () => {
  const root = mkdtempSync(join(tmpdir(), "telepi-pi-wrapper-"));
  try {
    const binDir = join(root, "bin");
    const packageRoot = join(root, "custom", "node_modules", "@earendil-works", "pi-coding-agent");
    const bundleDir = join(packageRoot, "dist", "bundle");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    const cliPath = join(binDir, "pi");
    const bundledCliPath = join(bundleDir, "cli.js");
    const indexPath = join(packageRoot, "dist", "index.js");
    writeFileSync(cliPath, `#!/bin/sh\nexec node ${bundledCliPath} "$@"\n`, "utf8");
    writeFileSync(bundledCliPath, "", "utf8");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      exports: { ".": "./dist/index.js" },
    }), "utf8");
    writeFileSync(indexPath, "export {};\n", "utf8");
    chmodSync(cliPath, 0o755);

    assert.equal(resolvePiPackageIndex({ TELEPI_PI_BIN: cliPath, HOME: "/missing", PATH: "" }), resolve(indexPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an SDK that no longer exposes Telepi's required integration surface", () => {
  assert.throws(() => assertSupportedPiSdk({ runRpcMode() {} }), /missing required exports/);
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
