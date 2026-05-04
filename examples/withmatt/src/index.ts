import { createAutoIndexWorker } from "r2-autoindex";

export interface Env {
  BUCKET: R2Bucket;
  PRIVATE_PASSWORD: string;
}

const notFoundPage = `<!doctype html>
<title>Not Found</title>
<h1>Not Found</h1>
<p>That object does not exist in the example bucket.</p>
<p><a href="/">Back to the listing</a></p>
`;

const errorPage = `<!doctype html>
<title>Internal Server Error</title>
<h1>Internal Server Error</h1>
<p>The example Worker hit an unexpected error.</p>
<p><a href="/">Back to the listing</a></p>
`;

export default createAutoIndexWorker<Env>({
  bucket: (env) => env.BUCKET,
  indexes: ["index.html", "index.htm"],

  errors: {
    404: {
      body: notFoundPage,
      contentType: "text/html; charset=utf-8",
    },
    500: {
      body: errorPage,
      contentType: "text/html; charset=utf-8",
    },
  },
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
