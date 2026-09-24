import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

const SYSTEM_PI_DIRS = [
  "/run/current-system/sw/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

const HOME_PI_DIRS = [
  ".npm/bin",
  ".npm-global/bin",
  ".local/bin",
  ".local/share/pnpm",
  ".nix-profile/bin",
];

export function resolvePiCliPath(env = process.env) {
  const configured = env.TELEPI_PI_BIN;
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`TELEPI_PI_BIN must be an absolute path: ${configured}`);
    }
    if (!isExecutableFile(configured)) {
      throw new Error(`TELEPI_PI_BIN is not an executable file: ${configured}`);
    }
    return realpathSync(configured);
  }

  const candidates = piPathCandidates(env);
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return realpathSync(candidate);
  }

  throw new Error(
    [
      "Could not find executable pi CLI.",
      "Set TELEPI_PI_BIN to its absolute path or add its directory to PATH.",
      `Searched: ${candidates.join(", ") || "(no candidates)"}`,
      `PATH: ${env.PATH || "(empty)"}`,
    ].join(" "),
  );
}

export function resolvePiPackageIndex(env = process.env) {
  const cliPath = resolvePiCliPath(env);
  const packageIndex = resolve(dirname(cliPath), "index.js");
  if (!isReadableFile(packageIndex)) {
    throw new Error(`Could not find pi SDK entry point next to CLI: ${packageIndex}`);
  }
  return packageIndex;
}

export function prependExecutableDirToPath(executable, path = "") {
  const executableDir = dirname(realpathSync(executable));
  const entries = String(path).split(delimiter).filter(Boolean);
  return [executableDir, ...entries.filter((entry) => resolve(entry) !== executableDir)].join(delimiter);
}

function piPathCandidates(env) {
  const seen = new Set();
  const candidates = [];
  const add = (path) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    candidates.push(path);
  };

  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (dir) add(resolve(dir, "pi"));
  }
  if (env.HOME) {
    for (const dir of HOME_PI_DIRS) add(resolve(env.HOME, dir, "pi"));
  }
  for (const dir of SYSTEM_PI_DIRS) add(resolve(dir, "pi"));

  return candidates;
}

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isReadableFile(path) {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
