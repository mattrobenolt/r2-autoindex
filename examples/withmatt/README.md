# r2-serve withmatt example

This is the live kitchen-sink deployment for `r2-serve`: [r2-serve.withmatt.com](https://r2-serve.withmatt.com/).

It intentionally uses the published npm package instead of the local source tree, so it exercises the same installation path a user would use.

## What it demonstrates

- Generated autoindex listings.
- `index.html` directory index behavior under `/docs/`.
- Hidden paths with `/hidden/`.
- Basic Auth under `/private/`.
- Fallback rewrites:
  - `/latest` -> `/releases/2026-05-04/notes.txt`
  - `/downloads/example.txt` -> `/files/example.txt`
- External redirects:
  - `/github` -> the GitHub repository.
- Custom `404` and `500` error pages.
- Media serving and byte ranges with `/media/big-buck-bunny.mp4`.
- Route headers, including media cache headers.

The Basic Auth demo credentials are:

```text
username: demo
password: r2-serve
```

## Cloudflare resources

This example uses these resources:

```text
Worker: r2-serve
Bucket: r2-serve-withmatt-com
Queue:  r2-serve-events
Domain: r2-serve.withmatt.com
```

The Worker deployment is handled by Wrangler from this directory. The bucket, queue, R2 event notifications, and Worker custom domain are managed in Matt's Cloudflare OpenTofu repo.

## Deploy

```sh
npm install
npm run deploy
```

The Worker expects the `PRIVATE_PASSWORD` secret to exist:

```sh
npx wrangler secret put PRIVATE_PASSWORD
```

## Seed data

The public bucket contains small text/html/svg examples plus Big Buck Bunny from Blender's open movie project.

If reseeding manually, upload objects to:

```text
r2-serve-withmatt-com
```

R2 event notifications invalidate generated listings automatically after object changes.
