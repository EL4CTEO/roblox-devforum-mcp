// Build the per-platform npm packages from release binaries.
//
//   node scripts/npm-platforms.mjs <artifacts-dir> <out-dir>
//
// <artifacts-dir>/<os>-<arch>/roblox-devforum-mcp[.exe] for each platform below becomes
// <out-dir>/<os>-<arch>/, a publishable package named roblox-devforum-mcp-<os>-<arch>.
// Fails if Cargo.toml, package.json and the optionalDependencies disagree on the version.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLATFORMS = [
  { id: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", os: "darwin", cpu: "x64" },
  { id: "linux-arm64", os: "linux", cpu: "arm64" },
  { id: "linux-x64", os: "linux", cpu: "x64" },
  { id: "win32-x64", os: "win32", cpu: "x64" },
];

const [artifacts, out] = process.argv.slice(2);
if (!artifacts || !out) {
  console.error("usage: node scripts/npm-platforms.mjs <artifacts-dir> <out-dir>");
  process.exit(2);
}

const root = JSON.parse(readFileSync("package.json", "utf8"));
const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("Cargo.toml", "utf8"))?.[1];
const problems = [];
if (cargo !== root.version) problems.push(`Cargo.toml says ${cargo}, package.json says ${root.version}`);
for (const p of PLATFORMS) {
  const name = `roblox-devforum-mcp-${p.id}`;
  const pinned = root.optionalDependencies?.[name];
  if (pinned !== root.version) problems.push(`optionalDependencies["${name}"] is ${pinned}, expected ${root.version}`);
}
if (problems.length) {
  console.error(`version mismatch:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

for (const p of PLATFORMS) {
  const exe = p.os === "win32" ? "roblox-devforum-mcp.exe" : "roblox-devforum-mcp";
  const from = join(artifacts, p.id, exe);
  if (!existsSync(from)) {
    console.error(`missing binary: ${from}`);
    process.exit(1);
  }
  const dir = join(out, p.id);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(from, join(dir, "bin", exe));
  if (p.os !== "win32") chmodSync(join(dir, "bin", exe), 0o755);
  copyFileSync("LICENSE", join(dir, "LICENSE"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `roblox-devforum-mcp-${p.id}`,
        version: root.version,
        description: `The ${p.os}-${p.cpu} binary for roblox-devforum-mcp.`,
        license: root.license,
        author: root.author,
        repository: root.repository,
        homepage: root.homepage,
        os: [p.os],
        cpu: [p.cpu],
        files: ["bin", "LICENSE"],
        preferUnplugged: true,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "README.md"), `# roblox-devforum-mcp-${p.id}\n\nThe ${p.os}-${p.cpu} binary for [roblox-devforum-mcp](https://www.npmjs.com/package/roblox-devforum-mcp). Install that package instead.\n`);
  console.log(`${dir} <- ${from}`);
}
