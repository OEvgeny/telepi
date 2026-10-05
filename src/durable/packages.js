import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

export const DURABLE_PACKAGE_VERSION = "1.0.3";
export const DURABLE_PACKAGE_FAMILY = [
  "@earendil-works/chord",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-durable",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
];

export function inspectDurablePackageVersions() {
  return Object.fromEntries(DURABLE_PACKAGE_FAMILY.map((name) => {
    const entry = fileURLToPath(import.meta.resolve(name));
    const manifest = findManifest(entry, name);
    return [name, JSON.parse(readFileSync(manifest, "utf8")).version];
  }));
}

export function assertDurablePackageVersions() {
  const versions = inspectDurablePackageVersions();
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== DURABLE_PACKAGE_VERSION)
    .map(([name, version]) => `${name}@${version}`);
  if (mismatches.length) {
    throw new Error(
      `Durable package family must be exactly ${DURABLE_PACKAGE_VERSION}; found ${mismatches.join(", ")}`,
    );
  }
  return versions;
}

function findManifest(entry, expectedName) {
  const root = parse(entry).root;
  let directory = dirname(entry);
  while (directory !== root) {
    const candidate = join(directory, "package.json");
    try {
      if (JSON.parse(readFileSync(candidate, "utf8")).name === expectedName) return candidate;
    } catch {}
    directory = dirname(directory);
  }
  throw new Error(`Could not find package manifest for ${expectedName}`);
}
