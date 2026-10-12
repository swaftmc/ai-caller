// Builds AICaller as a Node single-executable application. Usage: node scripts/build-exe.mjs [--target=win-x64|win-arm64|linux-x64|linux-arm64|darwin-x64|darwin-arm64|host]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";
import { x as untar } from "tar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["win-x64", "win-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const arg = process.argv.find((a) => a.startsWith("--target="))?.slice(9) ?? "win-x64";
const hostTarget = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const target = arg === "host" ? hostTarget : arg;
if (!TARGETS.includes(target)) {
  console.error(`Unknown target "${arg}". Use one of: ${TARGETS.join(", ")}, host`);
  process.exit(1);
}
const isWin = target.startsWith("win");
const stage = path.join(root, "build", ".stage", target);
const outDir = path.join(root, "build", target);
const exe = path.join(outDir, isWin ? "AICaller.exe" : "AICaller");
const version = process.version.slice(1);

/** Runs a command; with shell (needed for npm.cmd on Windows) it is passed as one quoted string. */
function run(cmd, args, { shell = process.platform === "win32", ...opts } = {}) {
  const line = [cmd, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
  console.log(`> ${line}`);
  const r = shell ? spawnSync(line, { cwd: root, stdio: "inherit", shell: true, ...opts }) : spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${line} failed with exit code ${r.status}`);
}

/** True for a real PE, ELF or Mach-O file (not a shell-wrapper script). */
function isNativeBinary(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const hex = head.toString("hex");
  return head.subarray(0, 2).toString() === "MZ" || hex === "7f454c46" || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(hex);
}

/** The Node runtime for the target, at exactly the version that builds the blob. */
async function runtimeFor() {
  if (target === hostTarget && isNativeBinary(process.execPath)) return process.execPath;
  const cache = path.join(root, "build", ".cache", `node-${target}-${version}`);
  const bin = path.join(cache, "package", "bin", isWin ? "node.exe" : "node");
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(cache, { recursive: true });
  run("npm", ["pack", `node-${target}@${version}`, "--pack-destination", cache, "--silent"]);
  const tgz = fs.readdirSync(cache).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack node-${target}@${version} produced no tarball`);
  await untar({ file: path.join(cache, tgz), cwd: cache });
  fs.rmSync(path.join(cache, tgz));
  if (!fs.existsSync(bin)) throw new Error(`No Node binary at ${bin}`);
  return bin;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

console.log(`Building AICaller for ${target} with Node ${version}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. Shared package and static web export (same-origin API: NEXT_PUBLIC_API_URL must be unset).
const webEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
delete webEnv.NEXT_PUBLIC_API_URL;
run("npm", ["run", "build:web"], { env: webEnv });
const webOut = path.join(root, "apps", "web", "out");
if (!fs.existsSync(path.join(webOut, "index.html"))) throw new Error("apps/web/out/index.html is missing after the web build");

// 2. One CommonJS bundle of the server.
const bundle = path.join(stage, "server.cjs");
await build({
  entryPoints: [path.join(root, "apps", "server", "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundle,
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

// 3. SEA blob with every web file as an asset.
const files = listFiles(webOut);
const manifest = path.join(stage, "web-manifest.json");
fs.writeFileSync(manifest, JSON.stringify(files));
const assets = { "web-manifest.json": manifest };
for (const f of files) assets[`web/${f}`] = path.join(webOut, ...f.split("/"));
const blob = path.join(stage, "sea-prep.blob");
const seaConfig = path.join(stage, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2),
);
run(process.execPath, ["--experimental-sea-config", seaConfig], { shell: false });

// 4. Copy the runtime and inject the blob.
const runtime = await runtimeFor();
console.log(`Runtime: ${runtime}`);
fs.rmSync(exe, { force: true });
fs.copyFileSync(runtime, exe);
if (target.startsWith("darwin")) {
  if (process.platform === "darwin") run("codesign", ["--remove-signature", exe], { shell: false });
  else console.warn("Warning: macOS binaries must be re-signed on a Mac (codesign --sign - AICaller) before they will run.");
}
await inject(exe, "NODE_SEA_BLOB", fs.readFileSync(blob), {
  sentinelFuse: FUSE,
  machoSegmentName: target.startsWith("darwin") ? "NODE_SEA" : undefined,
  overwrite: true,
});
if (target.startsWith("darwin") && process.platform === "darwin") run("codesign", ["--sign", "-", exe], { shell: false });
if (!isWin) fs.chmodSync(exe, 0o755);

console.log(`\nBuilt ${exe} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB, ${files.length} web files embedded)`);
