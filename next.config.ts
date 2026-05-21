import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // Don't try to bundle Playwright into the Next.js server build — it has
  // native browser binaries and Node-only dependencies. Tell Next to
  // require() it from node_modules at runtime instead.
  //
  // web-ifc bundles a Node-side WASM (`web-ifc-node.wasm`) which it loads
  // with `fs.readFileSync(__dirname + "/web-ifc-node.wasm")`. When Next
  // bundles the module, `__dirname` resolves into the compiled build dir
  // (`C:\ROOT\...`) where the WASM file isn't present. Marking the package
  // external keeps it at `node_modules/web-ifc/` where the WASM lives,
  // and the relative resolution works.
  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "@playwright/test",
    "web-ifc",
  ],
};

export default nextConfig;
