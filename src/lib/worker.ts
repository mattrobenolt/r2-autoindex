import { lookup } from "mime-types";
import { compile, match } from "path-to-regexp";
import type {
  AuthRule,
  AutoIndexConfig,
  ErrorPage,
  HeaderRule,
  RedirectRule,
  RewriteConfig,
  RewriteRule,
  RouteSource,
} from "./types";

type R2Event = {
  bucket: string;
  action: string;
  object: { key: string; size?: number; eTag?: string };
  eventTime: string;
};

type DirectoryEntry = {
  name: string;
  href: string;
  directory: boolean;
  uploaded?: Date;
  size?: number;
};

type NormalizedPath = { key: string; pathname: string; directory: boolean };
type MatchResult = { params: Record<string, string | string[]> };
type CompiledRule<T> = T & { matcher: (pathname: string) => false | MatchResult };
type RouteConfig<Env = unknown> = {
  indexes: string[];
  hidden: CompiledRule<{ source: RouteSource }>[];
  denied: CompiledRule<{ source: RouteSource }>[];
  auth: CompiledRule<AuthRule<Env>>[];
  headers: CompiledRule<HeaderRule>[];
  redirects: CompiledRule<RedirectRule>[];
  rewrites: {
    beforeFiles: CompiledRule<RewriteRule>[];
    afterFiles: CompiledRule<RewriteRule>[];
    fallback: CompiledRule<RewriteRule>[];
  };
  errors: Partial<Record<number, ErrorPage>>;
};

const DEFAULT_INTERNAL_PREFIX = ".__autoindex__/";
const HTML_TYPE = "text/html; charset=utf-8";

export function createAutoIndexWorker<Env = { BUCKET: R2Bucket }>(
  config: AutoIndexConfig<Env> = {},
): ExportedHandler<Env, R2Event> {
  let configPromise: Promise<RouteConfig<Env>> | undefined;

  function routeConfig(): Promise<RouteConfig<Env>> {
    configPromise ??= buildRouteConfig(config);
    return configPromise;
  }

  return {
    async fetch(request, env): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }

      const path = normalizePath(new URL(request.url).pathname);
      if (path === null) return new Response("Bad Request", { status: 400 });

      const internalPrefix = config.internalPrefix ?? DEFAULT_INTERNAL_PREFIX;
      const bucket = getBucket(env, config);
      const routes = await routeConfig();
      const auth = firstMatch(routes.auth, path.pathname);

      try {
        const response = await routeRequest(
          request,
          env,
          bucket,
          internalPrefix,
          routes,
          path,
          auth?.rule,
        );
        return finalizeResponse(response, request.method, routes, path.pathname, auth?.rule);
      } catch (error) {
        console.error(error);
        return finalizeResponse(
          new Response("Internal Server Error", { status: 500 }),
          request.method,
          routes,
          path.pathname,
          auth?.rule,
        );
      }
    },

    async queue(batch, env): Promise<void> {
      const internalPrefix = config.internalPrefix ?? DEFAULT_INTERNAL_PREFIX;
      const keys = new Set<string>();

      for (const message of batch.messages) {
        const event = message.body as R2Event;
        const key = event.object?.key;
        if (!key || isInternalKey(key, internalPrefix)) continue;

        for (const prefix of ancestorPrefixes(key)) keys.add(indexKey(prefix, internalPrefix));
      }

      if (keys.size > 0) await deleteInChunks(getBucket(env, config), [...keys]);
    },
  };
}

async function routeRequest<Env>(
  request: Request,
  env: Env,
  bucket: R2Bucket,
  internalPrefix: string,
  routes: RouteConfig<Env>,
  path: NormalizedPath,
  auth?: AuthRule<Env>,
): Promise<Response> {
  if (isInternalKey(path.key, internalPrefix) || matchesAny(routes.denied, path.pathname)) {
    return new Response("Not Found", { status: 404 });
  }

  if (auth && !(await authenticate(request, env, auth))) {
    return unauthorized(auth.realm);
  }

  const redirect = firstMatch(routes.redirects, path.pathname);
  if (redirect) {
    const location = applyDestination(redirect.rule.destination, redirect.params);
    const url = new URL(location, request.url);
    const status = redirect.rule.statusCode ?? (redirect.rule.permanent ? 308 : 307);
    return Response.redirect(url.toString(), status);
  }

  const beforeRewrite = firstMatch(routes.rewrites.beforeFiles, path.pathname);
  if (beforeRewrite) path = rewritePath(path, beforeRewrite.rule.destination, beforeRewrite.params);

  let response = await servePath(request, bucket, internalPrefix, routes, path);
  if (response.status !== 404) return response;

  const afterRewrite = firstMatch(routes.rewrites.afterFiles, path.pathname);
  if (afterRewrite) {
    response = await servePath(
      request,
      bucket,
      internalPrefix,
      routes,
      rewritePath(path, afterRewrite.rule.destination, afterRewrite.params),
    );
    if (response.status !== 404) return response;
  }

  const fallbackRewrite = firstMatch(routes.rewrites.fallback, path.pathname);
  if (fallbackRewrite) {
    response = await servePath(
      request,
      bucket,
      internalPrefix,
      routes,
      rewritePath(path, fallbackRewrite.rule.destination, fallbackRewrite.params),
    );
  }

  return response;
}

async function servePath<Env>(
  request: Request,
  bucket: R2Bucket,
  internalPrefix: string,
  routes: RouteConfig<Env>,
  path: NormalizedPath,
): Promise<Response> {
  if (isInternalKey(path.key, internalPrefix) || matchesAny(routes.denied, path.pathname)) {
    return new Response("Not Found", { status: 404 });
  }

  if (!path.directory) {
    const range = parseRange(request.headers.get("range"));
    const object = await bucket.get(path.key, range ? { range } : undefined);
    if (object) return objectResponse(object, request.method, range);

    const directoryPrefix = `${path.key}/`;
    if (await directoryHasEntries(bucket, directoryPrefix, internalPrefix, routes)) {
      const url = new URL(request.url);
      url.pathname = `${url.pathname}/`;
      return Response.redirect(url.toString(), 301);
    }

    return new Response("Not Found", { status: 404 });
  }

  for (const index of routes.indexes) {
    const key = `${path.key}${index}`;
    if (isInternalKey(key, internalPrefix) || matchesAny(routes.denied, `/${key}`)) continue;
    const object = await bucket.get(key);
    if (object) return objectResponse(object, request.method);
  }

  return serveDirectory(bucket, path.key, internalPrefix, path.pathname, request.method, routes);
}

function normalizePath(pathname: string): NormalizedPath | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (!decoded.startsWith("/")) return null;
  decoded = decoded.replace(/\/+/g, "/");
  if (decoded.split("/").some((part) => part === "..")) return null;

  return { key: decoded.slice(1), pathname: decoded, directory: decoded.endsWith("/") };
}

function isInternalKey(key: string, internalPrefix: string): boolean {
  return key === internalPrefix.slice(0, -1) || key.startsWith(internalPrefix);
}

async function serveDirectory(
  bucket: R2Bucket,
  prefix: string,
  internalPrefix: string,
  requestPath: string,
  method: string,
  routes: RouteConfig<any>,
): Promise<Response> {
  const cached = await bucket.get(indexKey(prefix, internalPrefix));
  if (cached) return objectResponse(cached, method);

  const entries = await listDirectory(bucket, prefix, internalPrefix, routes);
  if (prefix !== "" && entries.length === 0) return new Response("Not Found", { status: 404 });

  const html = renderAutoindex(requestPath, entries);
  await bucket.put(indexKey(prefix, internalPrefix), html, {
    httpMetadata: { contentType: HTML_TYPE },
  });

  return new Response(method === "HEAD" ? null : html, { headers: { "content-type": HTML_TYPE } });
}

async function listDirectory(
  bucket: R2Bucket,
  prefix: string,
  internalPrefix: string,
  routes: RouteConfig<any>,
): Promise<DirectoryEntry[]> {
  const entries: DirectoryEntry[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, delimiter: "/", cursor });

    for (const childPrefix of listed.delimitedPrefixes) {
      if (isInternalKey(childPrefix, internalPrefix)) continue;
      const path = `/${childPrefix}`;
      if (matchesAny(routes.denied, path) || matchesAny(routes.hidden, path)) continue;
      const name = childPrefix.slice(prefix.length);
      entries.push({ name, href: encodePathSegment(name), directory: true });
    }

    for (const object of listed.objects) {
      if (object.key === prefix || isInternalKey(object.key, internalPrefix)) continue;
      const name = object.key.slice(prefix.length);
      if (name.includes("/")) continue;
      const path = `/${object.key}`;
      if (matchesAny(routes.denied, path) || matchesAny(routes.hidden, path)) continue;
      entries.push({
        name,
        href: encodePathSegment(name),
        directory: false,
        uploaded: object.uploaded,
        size: object.size,
      });
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return entries.sort((a, b) =>
    a.directory !== b.directory ? (a.directory ? -1 : 1) : a.name.localeCompare(b.name),
  );
}

async function directoryHasEntries(
  bucket: R2Bucket,
  prefix: string,
  internalPrefix: string,
  routes: RouteConfig<any>,
): Promise<boolean> {
  const listed = await bucket.list({ prefix, delimiter: "/", limit: 1 });
  return (
    listed.objects.some(
      (object) =>
        object.key !== prefix &&
        !isInternalKey(object.key, internalPrefix) &&
        !matchesAny(routes.denied, `/${object.key}`) &&
        !matchesAny(routes.hidden, `/${object.key}`),
    ) ||
    listed.delimitedPrefixes.some(
      (childPrefix) =>
        !isInternalKey(childPrefix, internalPrefix) &&
        !matchesAny(routes.denied, `/${childPrefix}`) &&
        !matchesAny(routes.hidden, `/${childPrefix}`),
    )
  );
}

function renderAutoindex(pathname: string, entries: DirectoryEntry[]): string {
  const title = `Index of ${escapeHtml(pathname)}`;
  const lines = entries.map(renderEntry);
  if (pathname !== "/") lines.unshift(`<a href="../">../</a>`);
  return `<html>\n<head><title>${title}</title></head>\n<body>\n<h1>${title}</h1><hr><pre>${lines.join("\n")}\n</pre><hr></body>\n</html>\n`;
}

function renderEntry(entry: DirectoryEntry): string {
  const display = entry.name.length > 50 ? `${entry.name.slice(0, 47)}..>` : entry.name;
  const link = `<a href="${entry.href}">${escapeHtml(display)}</a>`;
  const date = entry.uploaded ? formatDate(entry.uploaded) : "                   ";
  const size = entry.directory ? "-" : String(entry.size ?? 0);
  return `${link}${" ".repeat(Math.max(1, 51 - display.length))}${date} ${size.padStart(20)}`;
}

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()];
  return `${day}-${month}-${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function parseRange(header: string | null): R2Range | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return undefined;

  const [, start, end] = match;
  if (start === "" && end === "") return undefined;
  if (start === "") return { suffix: Number(end) };

  const offset = Number(start);
  if (end === "") return { offset };

  const last = Number(end);
  if (last < offset) return undefined;
  return { offset, length: last - offset + 1 };
}

function objectResponse(object: R2ObjectBody, method: string, requestedRange?: R2Range): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const inferredType = lookup(object.key);
  if (
    inferredType &&
    (!headers.has("content-type") || headers.get("content-type") === "application/octet-stream")
  ) {
    headers.set("content-type", inferredType);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  headers.set("accept-ranges", "bytes");

  if (requestedRange) {
    const range = resolvedRange(requestedRange, object.size);
    if (range) {
      headers.set(
        "content-range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
      );
      headers.set("content-length", String(range.length));
      return new Response(method === "HEAD" ? null : object.body, { status: 206, headers });
    }
  }

  return new Response(method === "HEAD" ? null : object.body, { headers });
}

function resolvedRange(
  range: R2Range,
  size: number,
): { offset: number; length: number } | undefined {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }

  const offset = range.offset ?? 0;
  if (offset >= size) return undefined;
  const length = Math.min(range.length ?? size - offset, size - offset);
  return { offset, length };
}

function applyErrorPage(
  response: Response,
  method: string,
  errors: Partial<Record<number, ErrorPage>>,
): Response {
  const page = errors[response.status];
  if (!page || response.status < 400 || response.status > 599) return response;

  const headers = new Headers(response.headers);
  if (page.contentType) headers.set("content-type", page.contentType);
  for (const [key, value] of Object.entries(page.headers ?? {})) headers.set(key, value);

  return new Response(method === "HEAD" ? null : page.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function finalizeResponse<Env>(
  response: Response,
  method: string,
  routes: RouteConfig<Env>,
  pathname: string,
  auth?: AuthRule<Env>,
): Response {
  const withErrorPage = applyErrorPage(response, method, routes.errors);
  const withHeaders = applyHeaders(withErrorPage, routes.headers, pathname);
  return auth?.cache === "allow" ? withHeaders : applyNoStore(withHeaders, auth !== undefined);
}

function applyHeaders(
  response: Response,
  rules: CompiledRule<HeaderRule>[],
  pathname: string,
): Response {
  const headers = new Headers(response.headers);
  for (const rule of rules) {
    const result = rule.matcher(pathname);
    if (!result) continue;
    for (const header of rule.headers)
      headers.set(header.key, interpolate(header.value, result.params));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyNoStore(response: Response, enabled: boolean): Response {
  if (!enabled) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function buildRouteConfig<Env>(config: AutoIndexConfig<Env>): Promise<RouteConfig<Env>> {
  const rewrites = normalizeRewrites((await config.rewrites?.()) ?? []);
  return {
    indexes: config.indexes ?? ["index.html", "index.htm"],
    hidden: compilePatternList(config.hidden ?? []),
    denied: compilePatternList(config.denied ?? []),
    auth: compileRules(config.auth ?? []),
    headers: compileRules((await config.headers?.()) ?? []),
    redirects: compileRules((await config.redirects?.()) ?? []),
    rewrites: {
      beforeFiles: compileRules(rewrites.beforeFiles),
      afterFiles: compileRules(rewrites.afterFiles),
      fallback: compileRules(rewrites.fallback),
    },
    errors: config.errors ?? {},
  };
}

async function authenticate<Env>(
  request: Request,
  env: Env,
  rule: AuthRule<Env>,
): Promise<boolean> {
  const credentials = basicCredentials(request.headers.get("authorization"));
  if (!credentials) return false;
  return rule.verify({ ...credentials, request, env });
}

function basicCredentials(
  header: string | null,
): { username: string; password: string } | undefined {
  if (!header?.startsWith("Basic ")) return undefined;

  try {
    const decoded = atob(header.slice("Basic ".length));
    const separator = decoded.indexOf(":");
    if (separator === -1) return undefined;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function unauthorized(realm = "restricted"): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": `Basic realm="${realm.replace(/"/g, '\\"')}"` },
  });
}

function getBucket<Env>(env: Env, config: AutoIndexConfig<Env>): R2Bucket {
  if (typeof config.bucket === "function") return config.bucket(env);
  const binding = (config.bucket ?? "BUCKET") as keyof Env;
  const bucket = env[binding];
  if (!bucket) throw new Error(`Missing R2 bucket binding ${String(binding)}`);
  return bucket as unknown as R2Bucket;
}

function normalizeRewrites(
  rewrites: RewriteConfig,
): Required<Exclude<RewriteConfig, RewriteRule[]>> {
  if (Array.isArray(rewrites)) return { beforeFiles: rewrites, afterFiles: [], fallback: [] };
  return {
    beforeFiles: rewrites.beforeFiles ?? [],
    afterFiles: rewrites.afterFiles ?? [],
    fallback: rewrites.fallback ?? [],
  };
}

function compilePatternList(patterns: RouteSource[]): CompiledRule<{ source: RouteSource }>[] {
  return compileRules(patterns.map((source) => ({ source })));
}

function compileRules<T extends { source: RouteSource }>(rules: T[]): CompiledRule<T>[] {
  return rules.map((rule) => ({ ...rule, matcher: compileMatcher(rule.source) }));
}

function compileMatcher(source: RouteSource): (pathname: string) => false | MatchResult {
  if (source instanceof RegExp) {
    return (pathname) => {
      source.lastIndex = 0;
      const result = source.exec(pathname);
      if (!result) return false;
      return { params: result.groups ?? {} };
    };
  }

  return match(source, { decode: decodeURIComponent });
}

function firstMatch<T extends { source: RouteSource }>(
  rules: CompiledRule<T>[],
  pathname: string,
): { rule: T; params: Record<string, string | string[]> } | undefined {
  for (const rule of rules) {
    const result = rule.matcher(pathname);
    if (result) return { rule, params: result.params };
  }
  return undefined;
}

function matchesAny(rules: CompiledRule<{ source: RouteSource }>[], pathname: string): boolean {
  return firstMatch(rules, pathname) !== undefined;
}

function rewritePath(
  path: NormalizedPath,
  destination: string,
  params: Record<string, string | string[]>,
): NormalizedPath {
  const pathname = applyDestination(destination, params);
  return { key: pathname.slice(1), pathname, directory: pathname.endsWith("/") };
}

function applyDestination(destination: string, params: Record<string, string | string[]>): string {
  params = normalizeParams(params);
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) {
    const url = new URL(destination);
    url.pathname = compile(url.pathname, { encode: encodeURIComponent })(params);
    return url.toString();
  }

  return compile(destination, { encode: encodeURIComponent })(params);
}

function normalizeParams(
  params: Record<string, string | string[]>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      Array.isArray(value) && value.length === 1 ? value[0] : value,
    ]),
  );
}

function interpolate(value: string, params: Record<string, string | string[]>): string {
  return value.replace(/:([A-Za-z0-9_]+)\*?/g, (_, name: string) => {
    const param = (params as Record<string, string | string[]>)[name];
    return Array.isArray(param) ? param.join("/") : (param ?? "");
  });
}

function ancestorPrefixes(key: string): string[] {
  const prefixes = [""];
  const parts = key.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) prefixes.push(`${parts.slice(0, i).join("/")}/`);
  return prefixes;
}

async function deleteInChunks(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

function indexKey(prefix: string, internalPrefix: string): string {
  return prefix === ""
    ? `${internalPrefix}indexes/root.html`
    : `${internalPrefix}indexes/${encodeURIComponent(prefix)}.html`;
}

function encodePathSegment(segment: string): string {
  return segment
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );
}
