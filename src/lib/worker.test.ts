import { describe, expect, it } from "vitest";
import { createR2ServeWorker } from "./worker";

type StoredObject = {
  body: Uint8Array;
  contentType?: string;
  uploaded: Date;
};

class MockR2ObjectBody {
  readonly uploaded: Date;
  readonly httpEtag = '"mock-etag"';

  constructor(
    readonly key: string,
    readonly body: Uint8Array,
    readonly size: number,
    private readonly contentType?: string,
  ) {
    this.uploaded = new Date("2026-05-04T00:00:00Z");
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.contentType) headers.set("content-type", this.contentType);
  }
}

class MockBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly deleted: string[] = [];

  put(
    key: string,
    value: string | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
    this.objects.set(key, {
      body,
      contentType: options?.httpMetadata?.contentType,
      uploaded: new Date("2026-05-04T00:00:00Z"),
    });
    return Promise.resolve(null as unknown as R2Object);
  }

  get(key: string, options?: { range?: R2Range }) {
    const object = this.objects.get(key);
    if (!object) return Promise.resolve(null);

    const size = object.body.byteLength;
    let body = object.body;
    const range = options?.range;
    if (range) {
      if ("suffix" in range && range.suffix !== undefined) {
        body = body.slice(Math.max(0, body.byteLength - range.suffix));
      } else {
        const offset = "offset" in range ? (range.offset ?? 0) : 0;
        const length =
          "length" in range && range.length !== undefined ? range.length : body.byteLength - offset;
        body = body.slice(offset, offset + length);
      }
    }

    return Promise.resolve(
      new MockR2ObjectBody(key, body, size, object.contentType) as unknown as R2ObjectBody,
    );
  }

  list(options: R2ListOptions = {}) {
    const prefix = options.prefix ?? "";
    const delimiter = options.delimiter;
    const delimitedPrefixes = new Set<string>();
    const objects: R2Object[] = [];

    for (const [key, object] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) {
        delimitedPrefixes.add(`${prefix}${rest.slice(0, rest.indexOf(delimiter) + 1)}`);
        continue;
      }
      objects.push({ key, size: object.body.byteLength, uploaded: object.uploaded } as R2Object);
    }

    return Promise.resolve({
      objects,
      delimitedPrefixes: [...delimitedPrefixes].sort(),
      truncated: false,
    } as R2Objects);
  }

  delete(keys: string | string[]) {
    const deleted = Array.isArray(keys) ? keys : [keys];
    for (const key of deleted) {
      this.objects.delete(key);
      this.deleted.push(key);
    }
    return Promise.resolve();
  }
}

type Env = { BUCKET: R2Bucket; PASSWORD: string };

function createWorker(bucket: MockBucket, config = {}) {
  return createR2ServeWorker<Env>({ bucket: () => bucket as unknown as R2Bucket, ...config });
}

async function text(response: Response): Promise<string> {
  return response.text();
}

describe("createR2ServeWorker", () => {
  it("serves objects with inferred content type and byte ranges", async () => {
    const bucket = new MockBucket();
    await bucket.put("media/video.mp4", new TextEncoder().encode("0123456789"));
    const worker = createWorker(bucket);

    const response = await worker.fetch!(
      new Request("https://example.com/media/video.mp4", { headers: { range: "bytes=2-5" } }),
      { BUCKET: bucket as unknown as R2Bucket, PASSWORD: "secret" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await text(response)).toBe("2345");
  });

  it("serves directory index files before generated listings", async () => {
    const bucket = new MockBucket();
    await bucket.put("docs/index.html", "<h1>docs</h1>", {
      httpMetadata: { contentType: "text/html" },
    });
    await bucket.put("docs/readme.md", "# readme");
    const worker = createWorker(bucket);

    const response = await worker.fetch!(
      new Request("https://example.com/docs/"),
      { BUCKET: bucket as unknown as R2Bucket, PASSWORD: "secret" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await text(response)).toBe("<h1>docs</h1>");
    expect(bucket.objects.has(".__autoindex__/indexes/docs%2F.html")).toBe(false);
  });

  it("generates cached listings while hiding internal and hidden paths", async () => {
    const bucket = new MockBucket();
    await bucket.put("README.txt", "hello");
    await bucket.put("hidden/secret.txt", "nope");
    await bucket.put(".__autoindex__/internal.html", "nope");
    const worker = createWorker(bucket, { hidden: ["/hidden{/*path}"] });

    const response = await worker.fetch!(
      new Request("https://example.com/"),
      { BUCKET: bucket as unknown as R2Bucket, PASSWORD: "secret" },
      {} as ExecutionContext,
    );
    const body = await text(response);

    expect(response.status).toBe(200);
    expect(body).toContain("README.txt");
    expect(body).not.toContain("hidden");
    expect(body).not.toContain(".__autoindex__");
    expect(bucket.objects.has(".__autoindex__/indexes/root.html")).toBe(true);
  });

  it("applies fallback rewrites with path-to-regexp wildcard params", async () => {
    const bucket = new MockBucket();
    await bucket.put("files/example.txt", "rewritten");
    const worker = createWorker(bucket, {
      rewrites: async () => ({
        fallback: [{ source: "/downloads{/*path}", destination: "/files/:path" }],
      }),
    });

    const response = await worker.fetch!(
      new Request("https://example.com/downloads/example.txt"),
      { BUCKET: bucket as unknown as R2Bucket, PASSWORD: "secret" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await text(response)).toBe("rewritten");
  });

  it("protects auth routes and marks auth responses private", async () => {
    const bucket = new MockBucket();
    await bucket.put("private/README.txt", "secret");
    const worker = createWorker(bucket, {
      auth: [
        {
          source: "/private{/*path}",
          realm: "test",
          verify: ({ username, password }: { username: string; password: string }) =>
            username === "demo" && password === "secret",
        },
      ],
    });

    const denied = await worker.fetch!(
      new Request("https://example.com/private/"),
      { BUCKET: bucket as unknown as R2Bucket, PASSWORD: "secret" },
      {} as ExecutionContext,
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe('Basic realm="test"');

    const allowed = await worker.fetch!(
      new Request("https://example.com/private/", {
        headers: { authorization: `Basic ${btoa("demo:secret")}` },
      }),
      { BUCKET: bucket as unknown as R2Bucket, PASSWORD: "secret" },
      {} as ExecutionContext,
    );

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("private, no-store");
  });

  it("invalidates ancestor directory listing caches from queue events", async () => {
    const bucket = new MockBucket();
    await bucket.put(".__autoindex__/indexes/root.html", "root");
    await bucket.put(".__autoindex__/indexes/a%2F.html", "a");
    await bucket.put(".__autoindex__/indexes/a%2Fb%2F.html", "b");
    const worker = createWorker(bucket);

    await worker.queue!(
      {
        messages: [
          {
            body: { object: { key: "a/b/c.txt" } },
          },
        ],
      } as unknown as MessageBatch<{
        bucket: string;
        action: string;
        object: { key: string };
        eventTime: string;
      }>,
      { BUCKET: bucket as unknown as R2Bucket, PASSWORD: "secret" },
      {} as ExecutionContext,
    );

    expect(bucket.deleted).toEqual([
      ".__autoindex__/indexes/root.html",
      ".__autoindex__/indexes/a%2F.html",
      ".__autoindex__/indexes/a%2Fb%2F.html",
    ]);
  });
});
