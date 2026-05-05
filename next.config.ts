import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // Don't try to bundle Playwright into the Next.js server build — it has
  // native browser binaries and Node-only dependencies. Tell Next to
  // require() it from node_modules at runtime instead.
  serverExternalPackages: ["playwright", "playwright-core", "@playwright/test"],
};

export default nextConfig;
