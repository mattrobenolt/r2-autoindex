# r2-serve Terraform module

Standalone Terraform/OpenTofu deployment for `r2-serve`.

This module creates:

- an R2 bucket,
- a Queue,
- a standalone Worker script,
- the Worker Queue consumer,
- R2 event notification rules,
- optionally a Worker custom domain.

The Worker code is the committed `worker.js` bundle in this directory. It reads JSON-compatible configuration from the `AUTO_INDEX_CONFIG` Worker binding.

## Example

```hcl
module "files" {
  source = "github.com/mattrobenolt/r2-serve//terraform?ref=v0.1.0-alpha.0"

  account_id  = var.account_id
  zone_id     = cloudflare_zone.example_com.id
  hostname    = "files.example.com"

  bucket_name = "files-example-com"
  worker_name = "files-example-com-autoindex"
  queue_name  = "files-example-com-autoindex-events"

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

    errors = {
      404 = {
        body        = "<!doctype html><h1>Not Found</h1>"
        contentType = "text/html; charset=utf-8"
      }
    }
  }
}
```

The standalone JSON config supports string route sources using `path-to-regexp` v8 syntax. Native `RegExp` sources and verifier functions are only available in library mode.
