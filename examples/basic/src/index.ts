import { createAutoIndexWorker } from "../../src";

export interface Env {
  BUCKET: R2Bucket;
  PRIVATE_PASSWORD?: string;
}

export default createAutoIndexWorker<Env>({
  bucket: (env) => env.BUCKET,

  indexes: ["index.html", "index.htm"],

  headers: async () => [
    {
      source: "/:path*",
      headers: [{ key: "x-content-type-options", value: "nosniff" }],
    },
  ],

  rewrites: async () => ({
    fallback: [
      // Example: serve /_fallback.mp3 for missing top-level non-underscore .mp3 files.
      { source: "/:file((?!_)[^/]+)\\.mp3", destination: "/_fallback.mp3" },
    ],
  }),

  auth: [
    {
      source: "/private/:path*",
      realm: "restricted",
      verify: ({ username, password, env }) =>
        username === "admin" && password === env.PRIVATE_PASSWORD,
    },
  ],
});
