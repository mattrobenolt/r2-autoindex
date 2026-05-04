# r2-autoindex

Nginx-style directory listings for Cloudflare Workers and R2.

`r2-autoindex` is a small Worker library that serves objects from an R2 bucket and generates nginx-ish autoindex HTML for directory requests. Generated listings are cached back into R2 under `.__autoindex__/` and invalidated by R2 event notifications when objects change.

The bucket remains the source of truth. The generated HTML is disposable cache.

## Status

Early, but functional. The npm package is not published yet.

## Features

- Nginx-ish autoindex HTML.
- Lazy generated directory listings cached in R2.
- R2 event notification invalidation via Cloudflare Queues.
- Object serving with MIME type inference.
- HTTP byte-range support for media files.
- `headers`, `redirects`, and `rewrites` using `path-to-regexp` v8 patterns or native `RegExp` sources.
- Directory index files via `index.html` / `index.htm` or custom names.
- Basic Auth route rules with user-provided verification.
- Auth-protected responses default to `Cache-Control: private, no-store`.
- `.__autoindex__/` is always internal: not served, not listed, and ignored by invalidation.

## Usage

```ts
import { createAutoIndexWorker } from "r2-autoindex";

export interface Env {
  BUCKET: R2Bucket;
  PRIVATE_PASSWORD: string;
}

export default createAutoIndexWorker<Env>({
  bucket: (env) => env.BUCKET,

  indexes: ["index.html", "index.htm"],

  headers: async () => [
    {
      source: "/{/*path}",
      headers: [{ key: "x-content-type-options", value: "nosniff" }],
    },
  ],

  rewrites: async () => ({
    fallback: [{ source: /^\/(?!_)[^/]+\.mp3$/, destination: "/_fallback.mp3" }],
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
```

The auth verifier owns credential storage. Use Worker secrets, KV, D1, hardcoded test values, or anything else. The library only asks whether the request is allowed.

## Cloudflare setup

You need:

- an R2 bucket,
- a Queue,
- an R2 event notification rule for object creates,
- an R2 event notification rule for object deletes,
- a Worker with the R2 bucket binding and Queue consumer.

Example `wrangler.jsonc`:

```jsonc
{
  "name": "my-autoindex",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-03",
  "compatibility_flags": ["nodejs_compat"],
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "my-bucket",
    },
  ],
  "queues": {
    "consumers": [
      {
        "queue": "r2-autoindex-events",
        "max_batch_size": 100,
        "max_batch_timeout": 5,
      },
    ],
  },
}
```

Create the Queue and notification rules:

```sh
npx wrangler queues create r2-autoindex-events

npx wrangler r2 bucket notification create my-bucket \
  --event-type object-create \
  --queue r2-autoindex-events

npx wrangler r2 bucket notification create my-bucket \
  --event-type object-delete \
  --queue r2-autoindex-events
```

Deploy your Worker with Wrangler.

## How caching works

A request for an object serves the R2 object directly:

```text
GET /video.mp4 -> bucket key video.mp4
```

A request for a directory serves a cached generated listing if one exists:

```text
GET /docs/ -> .__autoindex__/indexes/docs%2F.html
```

On cache miss, the Worker lists the immediate children of the R2 prefix, renders autoindex HTML, stores it under `.__autoindex__/`, and returns it.

When R2 sends object create/delete notifications to the Queue, the Worker deletes cached listings for affected ancestor directories. The next request regenerates them.

For a change to:

```text
a/b/c.txt
```

these cached listings are invalidated:

```text
/
/a/
/a/b/
```

If generated listings ever need a manual reset, delete the `.__autoindex__/` prefix from the bucket.

## Example

See `examples/basic` for a minimal Worker project using the local library source.

## Development

```sh
npm install
npm run check
npm run build
```

This repo has a Nix dev shell:

```sh
nix develop
```
