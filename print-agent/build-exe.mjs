/*
  Builds the single .exe the clinic gets.

  The client never sees this repository. They get one file, put it on the
  reception PC, and double-click it — no Node, no npm, no config, no terminal.
  Everything the agent needs is inside: the runtime, the database URL, the
  slip layout, and the serial driver.

  Run:  npm run build:exe
  Out:  dist/TokenPrinter.exe

  The database URL is read from .env.production.local at BUILD time and baked
  in. That is a deliberate trade: the clinic configures nothing, at the cost of
  the credential being extractable from the binary by anyone who has it. It is
  fine on the reception PC — the staff there already have access to the data —
  but the .exe must not be emailed around or put anywhere public. If one
  leaks, rotate the database password and rebuild.
*/

import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const run = promisify(execFile);
const root = process.cwd();
const out = path.join(root, "dist");
const work = path.join(out, ".build");

/** Reads one key out of a .env file without pulling in a dependency. */
async function envValue(file, key) {
  if (!existsSync(file)) return null;
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (match && match[1] === key) {
      return match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const dbUrl =
  process.env.PRINT_AGENT_DB_URL ??
  (await envValue(path.join(root, ".env.production.local"), "DATABASE_URL"));

if (!dbUrl) {
  console.error(
    "No database URL found.\n" +
      "Set DATABASE_URL in .env.production.local, or pass PRINT_AGENT_DB_URL.",
  );
  process.exit(1);
}

// Say which database is about to be baked in, without printing the password.
// Building a clinic's .exe against the local dev database would produce
// something that runs, connects, and never prints a single real token.
const shown = (() => {
  try {
    const u = new URL(dbUrl);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
})();
/*
  The paper size of the printer this .exe is being built for.

  Not read from clinic_setting, because that is one value shared by every
  device while the roll belongs to the machine the agent runs on. Getting it
  wrong does not fail — it prints an 80-column layout onto 58mm paper and
  every line wraps — so it is stated at build time and shown below.
*/
const paper = Number(process.env.PRINT_AGENT_PAPER ?? 58);
if (paper !== 58 && paper !== 80) {
  console.error(`Paper width must be 58 or 80, not ${paper}.`);
  process.exit(1);
}

console.log(`[build-exe] baking in database: ${shown}`);
console.log(`[build-exe] paper width: ${paper}mm`);
if (/localhost|127\.0\.0\.1/.test(shown)) {
  console.warn(
    "[build-exe] WARNING: this is a LOCAL database. The clinic's PC cannot\n" +
      "           reach it. Use the production URL unless you are testing.",
  );
}

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

/*
  One bundle, entered through a prelude.

  Node's SEA runs a single script with no module resolution of its own, so
  serialport and everything else must be bundled in — nothing can be required
  from disk at runtime. The prelude unpacks the native binding and points
  serialport at it BEFORE the agent's imports run, since the binding is loaded
  during that import.
*/
console.log("[build-exe] bundling…");

/*
  The native binding, and the prelude that unpacks it at runtime.

  A .node file cannot be dlopen'd out of the executable's embedded assets, so
  it is written to disk on first run and loaded from there. AppData rather than
  %TEMP%: an antivirus quarantining a .node it just watched appear in a temp
  directory is a real and thoroughly confusing failure.
*/
const bindingSrc = path.join(
  root,
  "node_modules",
  "@serialport",
  "bindings-cpp",
  "prebuilds",
  "win32-x64",
  "@serialport+bindings-cpp.node",
);
if (!existsSync(bindingSrc)) {
  console.error(`Native binding not found at ${bindingSrc}`);
  process.exit(1);
}
await copyFile(bindingSrc, path.join(work, "serialport-binding.node"));

await writeFile(
  path.join(work, "prelude.cjs"),
  `/* Unpacks the serial binding, before anything tries to load it. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sea = require("node:sea");

/*
  The binding is written to AppData rather than next to the .exe.

  The .exe is often first run from Downloads, which may be read-only or
  synced; AppData is always writable by the user and is where the .exe
  installs itself anyway, so the two end up together.
*/
const home = path.join(os.homedir(), "AppData", "Local", "TokenPrinter");
const target = path.join(home, "serialport-binding.node");

/*
  Written only when it differs from what is already there.

  Rewriting unconditionally raced with any copy already running: Windows locks
  a loaded .node, so the second instance died with EBUSY. Comparing first means
  the common case touches nothing, while a truncated or outdated file is still
  replaced. Written via a temp file and renamed, so an interrupted write cannot
  leave a half-file that fails to load forever after.
*/
try {
  const wanted = Buffer.from(sea.getAsset("serialport-binding.node"));
  fs.mkdirSync(home, { recursive: true });

  let current = null;
  try {
    current = fs.readFileSync(target);
  } catch {
    // Not there yet, or unreadable. Either way, write it.
  }

  if (!current || !current.equals(wanted)) {
    const tmp = target + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, wanted);
    fs.renameSync(tmp, target);
  }
} catch (e) {
  // EBUSY here means another copy already has a good binding loaded, which is
  // fine — that file is the one we would have written.
  if (e.code !== "EBUSY" && e.code !== "EPERM") {
    console.error("");
    console.error("   Could not set up the printer driver: " + e.message);
    console.error("");
    setTimeout(() => process.exit(1), 20000);
  }
}

process.env.SERIALPORT_BINDING_PATH = target;
`,
);



const agentPath = path
  .join(root, "print-agent", "agent.mjs")
  .replace(/\\/g, "/");

await writeFile(
  path.join(work, "entry.mjs"),
  `import "./prelude.cjs";\nimport ${JSON.stringify(agentPath)};\n`,
);

/*
  Replace node-gyp-build with a direct load of the unpacked binding.

  serialport reaches its native code through node-gyp-build, which searches
  for a prebuilds/ directory relative to the package on disk. Inside a single
  executable there is no such directory, and its guess goes badly wrong — it
  reported "runtime=electron" and gave up. The prelude has already written the
  binding to a known path, so this hands that straight back.
*/
const bindingShim = {
  name: "serialport-binding-shim",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^node-gyp-build$/ }, () => ({
      path: "node-gyp-build",
      namespace: "binding-shim",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "binding-shim" }, () => ({
      /*
        createRequire, not the ambient require: inside a single executable the
        latter resolves built-in modules only, and asking it for a path on disk
        fails with ERR_UNKNOWN_BUILTIN_MODULE. A require anchored to a real
        file loads the .node the prelude just wrote.
      */
      contents: `
        const { createRequire } = require("node:module");
        const nodeRequire = createRequire(process.execPath);
        module.exports = () => nodeRequire(process.env.SERIALPORT_BINDING_PATH);
      `,
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [path.join(work, "entry.mjs")],
  outfile: path.join(work, "bundle.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  // node:sea is only present inside the packaged executable.
  external: ["node:sea"],
  plugins: [bindingShim],
  define: {
    // Baked here rather than read from the environment: the clinic PC has no
    // .env file and nobody there should have to make one.
    "process.env.PRINT_AGENT_BAKED_DB": JSON.stringify(dbUrl),
    "process.env.PRINT_AGENT_BAKED_PAPER": JSON.stringify(paper),
  },
  logLevel: "warning",
});

/*
  Packaged with Node's own single-executable support rather than pkg.

  pkg has no prebuilt binary for recent Node on Windows and falls back to
  compiling Node from source, which needs Visual Studio — not something to
  require of whoever builds the clinic's .exe. Node's built-in SEA copies the
  running node.exe and injects the bundle into it, so the only prerequisite is
  the Node already in use here.
*/
console.log("[build-exe] packaging…");

await writeFile(
  path.join(work, "sea-config.json"),
  JSON.stringify(
    {
      main: "bundle.cjs",
      output: "sea-prep.blob",
      disableExperimentalSEAWarning: true,
      assets: {
        "serialport-binding.node": "serialport-binding.node",
      },
    },
    null,
    2,
  ),
);

await run(
  process.execPath,
  ["--experimental-sea-config", "sea-config.json"],
  { cwd: work, maxBuffer: 64 * 1024 * 1024 },
);

const exePath = path.join(work, "TokenPrinter.exe");
await copyFile(process.execPath, exePath);

// Strip the signature before injecting: Windows refuses to run a signed
// binary whose contents no longer match, and the stock node.exe is signed.
await run("npx", ["--yes", "postject@1.0.0-alpha.6", exePath,
  "NODE_SEA_BLOB", "sea-prep.blob",
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"],
  { cwd: work, maxBuffer: 64 * 1024 * 1024, shell: true },
);

await copyFile(exePath, path.join(out, "TokenPrinter.exe"));

console.log(`[build-exe] wrote dist/TokenPrinter.exe`);
console.log(
  "[build-exe] give the clinic that one file. Double-clicking it installs\n" +
    "            and starts the printer service.",
);
