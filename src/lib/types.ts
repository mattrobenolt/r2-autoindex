export type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

export type RedirectRule = {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: 301 | 302 | 303 | 307 | 308;
};

export type RewriteRule = {
  source: string;
  destination: string;
};

export type AuthRule<Env = unknown> = {
  source: string;
  realm?: string;
  cache?: "no-store" | "allow";
  verify: (input: {
    username: string;
    password: string;
    request: Request;
    env: Env;
  }) => boolean | Promise<boolean>;
};

export type RewriteConfig =
  | RewriteRule[]
  | {
      beforeFiles?: RewriteRule[];
      afterFiles?: RewriteRule[];
      fallback?: RewriteRule[];
    };

export type ErrorPage = {
  body: string | ArrayBuffer;
  contentType?: string;
  headers?: Record<string, string>;
};

export type AutoIndexConfig<Env = unknown> = {
  bucket?: keyof Env | ((env: Env) => R2Bucket);
  internalPrefix?: string;
  indexes?: string[];
  hidden?: string[];
  denied?: string[];
  errors?: Partial<Record<number, ErrorPage>>;
  auth?: AuthRule<Env>[];
  headers?: () => HeaderRule[] | Promise<HeaderRule[]>;
  redirects?: () => RedirectRule[] | Promise<RedirectRule[]>;
  rewrites?: () => RewriteConfig | Promise<RewriteConfig>;
};
