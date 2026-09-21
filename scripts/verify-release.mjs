import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

// This script deliberately uses only Node built-ins: the publish job does not
// install project dependencies or receive any model API keys.
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  assert(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a value`);
  return args[index + 1];
};
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const version = json("package.json").version;
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), "Invalid application version");
const lock = json("package-lock.json");
const cargoPackageVersion = readFileSync("src-tauri/Cargo.toml", "utf8")
  .match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockVersion = readFileSync("src-tauri/Cargo.lock", "utf8")
  .match(/\[\[package\]\]\s+name = "llm-wiki"\s+version = "([^"]+)"/)?.[1];
for (const [label, actual] of Object.entries({
  "package-lock.json": lock.version,
  "package-lock.json root package": lock.packages?.[""]?.version,
  "tauri.conf.json": json("src-tauri/tauri.conf.json").version,
  "Cargo.toml": cargoPackageVersion,
  "Cargo.lock": cargoLockVersion,
})) {
  assert.equal(actual, version, `${label} does not match package.json`);
}
if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, "Release tag must match the application version");
}
const distribution = readFileSync("DISTRIBUTION.txt", "utf8").replace(/\r\n/g, "\n");
assert.equal(distribution.split(/\r?\n/)[0], `LLM Wiki Jev ${version}`, "DISTRIBUTION.txt application version is stale");
assert(distribution.includes(`https://github.com/Castor6/llm_wiki/tree/v${version}\n`), "DISTRIBUTION.txt source tag is stale");
assert(distribution.includes(`https://github.com/Castor6/llm_wiki/archive/refs/tags/v${version}.tar.gz`), "DISTRIBUTION.txt source archive is stale");
console.log(`Release versions agree: ${version}`);

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

const acceptedAsset = /\.(?:dmg|msi|exe|deb|rpm|AppImage|zip)$/;
const requirements = {
  "macos-latest": [/\.dmg$/],
  "ubuntu-22.04": [/\.deb$/, /\.AppImage$/],
  "ubuntu-22.04-arm": [/\.deb$/, /\.AppImage$/],
  "windows-latest": [/\.msi$/, /\.exe$/, /-windows-x64-portable\.zip$/],
  "browser-extension": [/^llm-wiki-extension-.*\.zip$/],
};

function checkAssets(platform, files) {
  const expected = requirements[platform];
  assert(expected, `Unknown artifact platform: ${platform}`);
  const assets = files.filter((file) => acceptedAsset.test(basename(file)));
  for (const pattern of expected) {
    assert(assets.some((file) => pattern.test(basename(file))), `${platform}: missing required bundle ${pattern}`);
  }
  for (const file of assets) {
    assert(statSync(file).size > 0, `Empty release asset: ${file}`);
    // Installer formats may normalize prerelease suffixes; the configuration
    // and Git tag above are checked against the full version string.
    assert(basename(file).includes(version.split("-")[0]), `Asset does not contain release version ${version}: ${file}`);
  }
  return assets;
}

const platform = option("--platform");
if (platform) {
  const target = platform === "macos-latest" ? "aarch64-apple-darwin/" : "";
  const bundleRoot = `src-tauri/target/${target}release/bundle`;
  const files = [
    ...["dmg", "msi", "nsis", "deb", "rpm", "appimage"].flatMap((format) => filesUnder(join(bundleRoot, format))),
    ...(existsSync("dist-portable") ? readdirSync("dist-portable", { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join("dist-portable", entry.name)) : []),
  ];
  const assets = checkAssets(platform, files);
  console.log(`${platform}: verified ${assets.length} platform bundles`);
}

const collection = option("--collect");
if (collection) {
  const output = option("--output");
  assert(output, "--collect requires --output");
  mkdirSync(output, { recursive: true });
  assert.equal(readdirSync(output).length, 0, "Release output directory must be empty");
  const names = new Set();
  const checksums = [];
  for (const key of Object.keys(requirements)) {
    const artifactName = key === "browser-extension" ? key : `bundle-${key}`;
    const files = checkAssets(key, filesUnder(join(collection, artifactName)));
    for (const file of files) {
      // GitHub normalizes asset filenames on upload. Normalize first so the
      // published filename and its checksum entry are guaranteed to agree.
      const name = basename(file).replace(/[^A-Za-z0-9._-]/g, "-");
      assert(!names.has(name), `Release assets must have unique names: ${name}`);
      names.add(name);
      const target = join(output, name);
      copyFileSync(file, target);
      checksums.push(`${createHash("sha256").update(readFileSync(target)).digest("hex")}  ${name}`);
    }
  }
  writeFileSync(join(output, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`);
  console.log(`Collected ${names.size} release assets from all four platforms and the browser extension`);
}

const downloads = option("--verify-download");
if (downloads) {
  const manifest = option("--manifest");
  assert(manifest, "--verify-download requires --manifest");
  const expectedManifest = readFileSync(manifest, "utf8");
  assert.equal(readFileSync(join(downloads, "SHA256SUMS"), "utf8"), expectedManifest, "Uploaded checksum manifest differs");
  const expectedNames = new Set(["SHA256SUMS"]);
  for (const line of expectedManifest.trim().split("\n")) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    assert(match, "Invalid checksum manifest entry");
    const [, checksum, name] = match;
    assert.equal(basename(name), name, "Manifest must contain plain asset names");
    expectedNames.add(name);
    const path = resolve(downloads, name);
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), checksum, `Uploaded asset checksum mismatch: ${name}`);
  }
  assert.deepEqual(new Set(readdirSync(downloads)), expectedNames, "Release contains missing or unexpected assets");
  console.log(`Verified ${expectedNames.size - 1} uploaded release assets against SHA256SUMS`);
}
