# Basic r2-serve example

Minimal Worker using the local library source from this repository.

This example is useful while developing the package itself. For a real deployment that installs the published npm package, see `examples/withmatt`.

```sh
npm install
npx wrangler deploy
```

Before deploying, edit `wrangler.jsonc` and replace the bucket, queue, account, and Worker names with your own values.
