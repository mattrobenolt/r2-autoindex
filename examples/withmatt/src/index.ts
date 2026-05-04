import { createAutoIndexWorker } from "r2-autoindex";

export interface Env {
  BUCKET: R2Bucket;
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
});
