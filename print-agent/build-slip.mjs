/*
  Compiles the slip builder for the agent.

  src/lib/receipts.ts and src/lib/escpos.ts are TypeScript and import from the
  app; the agent is plain Node and must not drag Next in. Rather than keeping a
  second copy of the layout — which would drift, and the drift would only show
  up as paper that no longer matches what the app prints — the real modules are
  bundled to one .mjs the agent imports.

  Run after changing either file:  npm run build:slip
*/

import { build } from "esbuild";
import path from "node:path";

const root = process.cwd();

await build({
  entryPoints: [path.join(root, "print-agent", "slip-entry.ts")],
  outfile: path.join(root, "print-agent", "slip.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Nothing outside these two modules should be reachable; if the bundle ever
  // pulls in a Next import, that is a mistake worth failing on rather than
  // silently shipping to the clinic PC.
  logLevel: "info",
});

console.log("[build-slip] print-agent/slip.mjs written");
