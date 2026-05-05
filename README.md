# r2-serve

A static file server for Cloudflare R2.

R2 can expose public objects, but that is still mostly object hosting. `r2-serve` puts a small Cloudflare Worker in front of a bucket and adds the file-server behavior you usually want: directory listings, `index.html`, redirects, rewrites, headers, Basic Auth, custom error pages, byte ranges, and event-driven cache invalidation.

Upload files to R2. Serve them over HTTP.

Live demos: [r2-serve.withmatt.com](https://r2-serve.withmatt.com/) and [r2-serve-terraform.withmatt.com](https://r2-serve-terraform.withmatt.com/).

## Status

Early, but functional. The package has not reached a stable `0.1.0` API yet.

## Why not just use R2 public buckets?

R2 public buckets are great when every URL maps directly to an object key. `r2-serve` is for when the bucket should behave more like a static file server.

| Need                                                                       | R2 public bucket | `r2-serve` |
| -------------------------------------------------------------------------- | ---------------- | ---------- |
| Serve objects over HTTP                                                    | yes              | yes        |
| Directory `index.html` handling                                            | limited          | yes        |
| Browse directories                                                         | no               | yes        |
| Hide internal paths                                                        | no               | yes        |
| Redirects and rewrites                                                     | no               | yes        |
| Per-path headers                                                           | no               | yes        |
| Basic Auth                                                                 | no               | yes        |
| Custom error pages                                                         | limited          | yes        |
| Byte-range media serving                                                   | yes              | yes        |
| One Terraform/OpenTofu block for bucket, Worker, Queue, events, and domain | no               | yes        |

Think of native R2 public access as object hosting. Think of `r2-serve` as a small file server in front of the bucket.

## Quick start: Terraform / OpenTofu

The Terraform module is the easiest way to deploy a complete `r2-serve` site. One module block creates the R2 bucket, Queue, R2 event notifications, Worker script, R2 binding, Queue consumer, and custom Worker domain.

```hcl
module "files" {
  source = "github.com/mattrobenolt/r2-serve//terraform?ref=v0.1.0-alpha.1"

  account_id = var.account_id
  zone_id    = cloudflare_zone.example_com.id
  hostname   = "files.example.com"

  bucket_name = "files-example-com"
  worker_name = "files-example-com-r2-serve"
  queue_name  = "files-example-com-r2-serve-events"

  config = {
    indexes = ["index.html", "index.htm"]

    hidden = ["/hidden{/*path}"]

    headers = [
      {
        source = "/{/*path}"
        headers = [
          { key = "x-content-type-options", value = "nosniff" }
        ]
      },
      {
        source = "/media{/*path}"
        headers = [
          { key = "cache-control", value = "public, max-age=3600" }
        ]
      }
    ]

    rewrites = {
      fallback = [
        {
          source      = "/latest"
          destination = "/releases/current/notes.txt"
        }
      ]
    }
  }
}
```

In Terraform mode, Terraform owns the Worker script and Queue consumer. Do not also configure the same Worker/Queue consumer with Wrangler.

The Worker code is the committed generated bundle in `terraform/worker.js`, so Terraform can deploy the module without running npm or Wrangler.

## Features

- R2 object serving with MIME type inference.
- Directory index files via `index.html` / `index.htm` or custom names.
- Generated directory listings for browsable buckets.
- Lazy generated listings cached in R2.
- R2 event notification invalidation via Cloudflare Queues.
- HTTP byte-range support for media files.
- `headers`, `redirects`, and `rewrites` using `path-to-regexp` v8 patterns.
- Native `RegExp` route sources in library mode.
- Basic Auth route rules with user-provided verification in library mode.
- Declarative Basic Auth users in standalone JSON config.
- Auth-protected responses default to `Cache-Control: private, no-store`.
- Custom `404` and `500` error pages.
- `.__autoindex__/` is always internal: not served, not listed, and ignored by invalidation.

## Library usage

Use the library when you want to own the Worker code yourself.

```ts
import { createR2ServeWorker } from "r2-serve";

export interface Env {
  BUCKET: R2Bucket;
  PRIVATE_PASSWORD: string;
}

export default createR2ServeWorker<Env>({
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

## Cloudflare setup with Wrangler

Use Wrangler when you want a custom Worker project instead of the standalone Terraform module.

You need:

- an R2 bucket,
- a Queue,
- R2 event notification rules for object creates and deletes,
- a Worker with the R2 bucket binding and Queue consumer.

Example `wrangler.jsonc`:

```jsonc
{
  "name": "my-r2-site",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-03",
  "compatibility_flags": ["nodejs_compat"],
  "r2_buckets": [
    {
      "binding": "BUCKET",
      "bucket_name": "my-r2-site-bucket",
    },
  ],
  "queues": {
    "consumers": [
      {
        "queue": "my-r2-site-events",
        "max_batch_size": 100,
        "max_batch_timeout": 5,
      },
    ],
  },
}
```

Create the Queue and notification rules:

```sh
npx wrangler queues create my-r2-site-events

npx wrangler r2 bucket notification create my-r2-site-bucket \
  --event-type object-create \
  --queue my-r2-site-events

npx wrangler r2 bucket notification create my-r2-site-bucket \
  --event-type object-delete \
  --queue my-r2-site-events
```

Deploy your Worker with Wrangler.

## How directory listing caching works

A request for an object serves the R2 object directly:

```text
GET /video.mp4 -> bucket key video.mp4
```

A request for a directory first checks for configured index files. If no index object exists, a cached generated listing is served if present:

```text
GET /docs/ -> .__autoindex__/indexes/docs%2F.html
```

On cache miss, the Worker lists the immediate children of the R2 prefix, renders directory listing HTML, stores it under `.__autoindex__/`, and returns it.

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

## Examples

The live kitchen-sink example is [r2-serve.withmatt.com](https://r2-serve.withmatt.com/). It demonstrates directory listings, custom index files, rewrites, redirects, hidden paths, Basic Auth, custom error pages, headers, and byte-range media serving.

The Terraform-managed example is [r2-serve-terraform.withmatt.com](https://r2-serve-terraform.withmatt.com/). It uses the published module from GitHub, not the local checkout.

Example projects:

- `examples/withmatt` installs the published `r2-serve` package.
- `examples/library-basic` imports the local source tree for package development.

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
