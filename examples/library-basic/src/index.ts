import { createAutoIndexWorker } from "../../src";

export interface Env {
  BUCKET: R2Bucket;
  PRIVATE_PASSWORD?: string;
}

export default createAutoIndexWorker<Env>({
  bucket: (env) => env.BUCKET,

  indexes: ["index.html", "index.htm"],

  errors: {
    404: {
      body: "<!doctype html><title>Not Found</title><h1>Not Found</h1>",
      contentType: "text/html; charset=utf-8",
    },
    500: {
      body: "<!doctype html><title>Error</title><h1>Internal Server Error</h1>",
      contentType: "text/html; charset=utf-8",
    },
  },

  headers: async () => [
    {
      source: "/{/*path}",
      headers: [{ key: "x-content-type-options", value: "nosniff" }],
    },
  ],

  rewrites: async () => ({
    fallback: [
      // Example: serve /_fallback.mp3 for missing top-level non-underscore .mp3 files.
      { source: /^\/(?!_)[^/]+\.mp3$/, destination: "/_fallback.mp3" },
    ],
  }),

  auth: [
    {
      source: "/private{/*path}",
      realm: "restricted",
      verify: ({ username, password, env }) =>
        username === "admin" && password === env.PRIVATE_PASSWORD,
    },
  ],
});
