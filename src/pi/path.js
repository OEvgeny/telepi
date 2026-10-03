import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

const SYSTEM_PI_DIRS = [
  "/run/current-system/sw/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

const HOME_PI_DIRS = [
  ".nix-profile/bin",
  ".local/bin",
  ".npm/bin",
  ".npm-global/bin",
  ".local/share/pnpm",
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

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_PARTS = ["@earendil-works", "pi-coding-agent"];
const REQUIRED_PI_SDK_EXPORTS = [
  "ModelRuntime",
  "ProjectTrustStore",
  "SessionManager",
  "SettingsManager",
  "createAgentSessionFromServices",
  "createAgentSessionRuntime",
  "createAgentSessionServices",
  "getAgentDir",
  "hasTrustRequiringProjectResources",
  "resolveCliModel",
  "resolveModelScopeWithDiagnostics",
  "runRpcMode",
];

export function assertSupportedPiSdk(pi) {
  const missing = REQUIRED_PI_SDK_EXPORTS.filter((name) => pi?.[name] == null);
  if (missing.length) {
    throw new Error(`Installed pi SDK is missing required exports: ${missing.join(", ")}`);
  }
}

export function resolvePiPackageIndex(env = process.env) {
  const cliPath = resolvePiCliPath(env);
  const candidates = [resolve(dirname(cliPath), "index.js")];
  const manifests = piPackageManifestCandidates(cliPath);
  for (const manifestPath of manifests) {
    const entry = readPiPackageEntry(manifestPath);
    if (entry) candidates.push(entry);
  }
  for (const candidate of candidates) {
    if (isReadableFile(candidate)) return realpathSync(candidate);
  }
  throw new Error(
    `Could not find pi SDK entry point for CLI ${cliPath}. Searched: ${[...new Set(candidates)].join(", ")}`,
  );
}

function piPackageManifestCandidates(cliPath) {
  const manifests = [];
  const seen = new Set();
  const add = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    manifests.push(path);
  };
  const anchors = [cliPath, ...embeddedPiCliTargets(cliPath)];
  for (const anchor of anchors) {
    let directory = dirname(anchor);
    for (let depth = 0; depth < 10; depth += 1) {
      add(resolve(directory, "package.json"));
      add(resolve(directory, "node_modules", ...PI_PACKAGE_PARTS, "package.json"));
      // The official Nix package keeps the Node application below lib/pi, but
      // the SDK entry itself still comes from the package's public exports.
      add(resolve(directory, "lib", "pi", "node_modules", ...PI_PACKAGE_PARTS, "package.json"));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return manifests;
}

function embeddedPiCliTargets(cliPath) {
  try {
    const source = readFileSync(cliPath, "utf8");
    const pattern = /(\/[^\s"']*\/@earendil-works\/pi-coding-agent\/dist\/[^\s"']*cli\.js)/g;
    return [...source.matchAll(pattern)].map((match) => match[1]);
  } catch {
    return [];
  }
}

function readPiPackageEntry(manifestPath) {
  if (!isReadableFile(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== PI_PACKAGE_NAME) return null;
    const packageRoot = dirname(manifestPath);
    const exported = selectImportTarget(manifest.exports?.["."] ?? manifest.exports);
    if (exported) return resolve(packageRoot, exported);
    if (typeof manifest.main === "string") return resolve(packageRoot, manifest.main);
    return resolve(packageRoot, "dist", "index.js");
  } catch {
    return null;
  }
}

function selectImportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = selectImportTarget(candidate);
      if (selected) return selected;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const condition of ["import", "node", "default", "require"]) {
    const selected = selectImportTarget(value[condition]);
    if (selected) return selected;
  }
  return null;
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
