import { createAutoIndexWorker } from "r2-autoindex";

export interface Env {
  BUCKET: R2Bucket;
  PRIVATE_PASSWORD: string;
}

export default createAutoIndexWorker<Env>({
  bucket: (env) => env.BUCKET,
  indexes: ["index.html", "index.htm"],
  hidden: [/^\/hidden(?:\/.*)?$/],

  auth: [
    {
      source: "/private{/*path}",
      realm: "r2-autoindex example",
      verify: ({ username, password, env }) =>
        username === "demo" && password === env.PRIVATE_PASSWORD,
    },
  ],

  redirects: async () => [
    {
      source: "/github",
      destination: "https://github.com/mattrobenolt/r2-autoindex",
      permanent: false,
    },
  ],

  rewrites: async () => ({
    fallback: [
      {
        source: "/latest",
        destination: "/releases/2026-05-04/notes.txt",
      },
      {
        source: /^\/downloads\/(?<file>[^/]+)$/,
        destination: "/files/:file",
      },
    ],
  }),

  headers: async () => [
    {
      source: "/{/*path}",
      headers: [{ key: "x-content-type-options", value: "nosniff" }],
    },
    {
      source: "/media{/*path}",
      headers: [{ key: "cache-control", value: "public, max-age=3600" }],
    },
  ],
});
