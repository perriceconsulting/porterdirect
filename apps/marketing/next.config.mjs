// MONOREPO ENV NOTE: this repo keeps ONE .env.local at the workspace root (DOSI-S),
// but Next only auto-loads .env* from the APP directory. Rather than copy the file
// (a second source of truth that silently drifts), the package scripts boot Next via
// `node --env-file-if-exists=../../.env.local`, so the whole process tree inherits it.
// Loading it here in next.config instead does NOT work: route handlers run in a
// separate worker that never sees the mutation, and every event answers
// "Webhook not configured" — which reads like a broken endpoint, not a missing file.

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TS (exports -> ./src/index.ts); Next must transpile them.
  transpilePackages: ["@porterdirect/billing", "@porterdirect/db"],

  webpack: (config) => {
    // The packages compile under TS `moduleResolution: NodeNext`, which REQUIRES
    // explicit `.js` specifiers in relative imports even though the files on disk are
    // `.ts`. Webpack resolves those literally and 404s. extensionAlias teaches it the
    // same mapping tsc uses, so the app can consume package source directly without a
    // build step. Remove this only if the packages start shipping built `dist/` output.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
export default nextConfig;
