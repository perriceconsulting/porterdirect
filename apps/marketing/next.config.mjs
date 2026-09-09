// MONOREPO ENV NOTE: this repo keeps ONE .env.local at the workspace root (DOSI-S),
// but Next only auto-loads .env* from the APP directory. Rather than copy the file
// (a second source of truth that silently drifts), the package scripts boot Next via
// `node --env-file-if-exists=../../.env.local`, so the whole process tree inherits it.
// Loading it here in next.config instead does NOT work: route handlers run in a
// separate worker that never sees the mutation, and every event answers
// "Webhook not configured" — which reads like a broken endpoint, not a missing file.

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Lint is a CI gate, not a deploy gate. Vercel's build installs a reduced dependency
    // set and then fails the lint step for a missing devDependency, which turns "eslint
    // isn't here" into a deployment error about code quality. `npm run lint` runs on every
    // push in CI with the full toolchain, so this is the same rule enforced once, in the
    // place that can actually run it — not a rule being skipped.
    ignoreDuringBuilds: true,
  },
  // NOTE: `typescript.ignoreBuildErrors` is deliberately NOT set. The Vercel build's type
  // check is what caught a real error that `npm run typecheck` was blind to, because that
  // script only covered packages/ and never this app. The script now covers both, but
  // this remains the backstop and must stay loud.

  /**
   * One canonical host. `www` and the apex were both answering 200 with identical
   * content, which is two URLs for every page — search engines pick a canonical
   * themselves, split link equity while deciding, and may not pick the one you meant.
   *
   * Kept HERE rather than as a dashboard redirect so the rule is version-controlled and
   * travels with the repo. Platform config that exists only in a web UI is invisible
   * state: nobody reviews it, and nothing tells you when it changes.
   *
   * The apex is written literally rather than derived from BETTER_AUTH_URL, because that
   * variable legitimately differs per environment — it is the vercel.app URL on a preview
   * deployment — and a redirect keyed to it would send preview traffic to production.
   */
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.porterdirect.com" }],
        destination: "https://porterdirect.com/:path*",
        permanent: true,
      },
    ];
  },

  // Workspace packages ship raw TS (exports -> ./src/index.ts); Next must transpile them.
  transpilePackages: ["@porterdirect/billing", "@porterdirect/db", "@porterdirect/contact", "@porterdirect/orders", "@porterdirect/auth"],

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
