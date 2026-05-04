import { createAutoIndexWorker } from "./lib/worker";
import type {
  AutoIndexConfig,
  ErrorPage,
  HeaderRule,
  RedirectRule,
  RewriteConfig,
  RewriteRule,
} from "./lib/types";

export interface Env {
  BUCKET: R2Bucket;
  AUTO_INDEX_CONFIG?: StandaloneConfig | string;
}

type R2Event = {
  bucket: string;
  action: string;
  object: { key: string; size?: number; eTag?: string };
  eventTime: string;
};

type StandaloneRuleSource = string;

type StandaloneHeaderRule = Omit<HeaderRule, "source"> & { source: StandaloneRuleSource };
type StandaloneRedirectRule = Omit<RedirectRule, "source"> & { source: StandaloneRuleSource };
type StandaloneRewriteRule = Omit<RewriteRule, "source"> & { source: StandaloneRuleSource };
type StandaloneRewriteConfig =
  | StandaloneRewriteRule[]
  | {
      beforeFiles?: StandaloneRewriteRule[];
      afterFiles?: StandaloneRewriteRule[];
      fallback?: StandaloneRewriteRule[];
    };

type StandaloneAuthUser = {
  username: string;
  passwordSha256: string;
};

type StandaloneAuthRule = {
  source: StandaloneRuleSource;
  realm?: string;
  cache?: "no-store" | "allow";
  users: StandaloneAuthUser[];
};

type StandaloneConfig = {
  internalPrefix?: string;
  indexes?: string[];
  hidden?: StandaloneRuleSource[];
  denied?: StandaloneRuleSource[];
  errors?: Partial<Record<number, ErrorPage>>;
  auth?: StandaloneAuthRule[];
  headers?: StandaloneHeaderRule[];
  redirects?: StandaloneRedirectRule[];
  rewrites?: StandaloneRewriteConfig;
};

const DEFAULT_CONFIG: StandaloneConfig = {
  indexes: ["index.html", "index.htm"],
  headers: [
    {
      source: "/{/*path}",
      headers: [{ key: "x-content-type-options", value: "nosniff" }],
    },
  ],
};

let worker: ExportedHandler<Env, R2Event> | undefined;
let workerConfigKey: string | undefined;

export default {
  async fetch(request, env, context) {
    return (
      getWorker(env).fetch?.(request, env, context) ?? new Response("Not Found", { status: 404 })
    );
  },

  async queue(batch, env, context) {
    return getWorker(env).queue?.(batch, env, context);
  },
} satisfies ExportedHandler<Env, R2Event>;

function getWorker(env: Env): ExportedHandler<Env, R2Event> {
  const config = parseConfig(env.AUTO_INDEX_CONFIG);
  const key = JSON.stringify(config);
  if (!worker || workerConfigKey !== key) {
    worker = createAutoIndexWorker<Env>(toAutoIndexConfig(config));
    workerConfigKey = key;
  }
  return worker;
}

function parseConfig(input: StandaloneConfig | string | undefined): StandaloneConfig {
  if (input === undefined) return DEFAULT_CONFIG;
  const config = typeof input === "string" ? (JSON.parse(input) as StandaloneConfig) : input;
  return { ...DEFAULT_CONFIG, ...config };
}

function toAutoIndexConfig(config: StandaloneConfig): AutoIndexConfig<Env> {
  return {
    bucket: (env) => env.BUCKET,
    internalPrefix: config.internalPrefix,
    indexes: config.indexes,
    hidden: config.hidden,
    denied: config.denied,
    errors: config.errors,
    auth: config.auth?.map((rule) => ({
      source: rule.source,
      realm: rule.realm,
      cache: rule.cache,
      verify: async ({ username, password }) => {
        const user = rule.users.find((candidate) => candidate.username === username);
        return user !== undefined && (await sha256Hex(password)) === user.passwordSha256;
      },
    })),
    headers: config.headers ? async () => config.headers ?? [] : undefined,
    redirects: config.redirects ? async () => config.redirects ?? [] : undefined,
    rewrites: config.rewrites ? async () => config.rewrites as RewriteConfig : undefined,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
