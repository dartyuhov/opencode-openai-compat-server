export const PLUGIN_PACKAGE_NAME = "opencode-openai-compat";
export const PLUGIN_EXPORT_NAME = "OpenCodeOpenAICompatPlugin";

export const PLUGIN_CONFIG_KEYS = [
  "enabled",
  "host",
  "port",
  "apiKey",
  "upstreamBaseUrl",
  "upstreamUsername",
  "upstreamPassword",
  "defaultAgent",
  "requestTimeoutMs",
  "modelsCacheTtlMs",
] as const;

export type PluginConfigKey = (typeof PLUGIN_CONFIG_KEYS)[number];

export type PluginConfig = {
  enabled: boolean;
  host: string;
  port: number;
  apiKey: string | null;
  upstreamBaseUrl: string | null;
  upstreamUsername: string | null;
  upstreamPassword: string | null;
  defaultAgent: string;
  requestTimeoutMs: number;
  modelsCacheTtlMs: number;
};

export type RawPluginConfig = Partial<{
  [Key in PluginConfigKey]: unknown;
}>;

export type ParsedPluginConfig = PluginConfig & {
  sanitizedUpstreamTarget: string | null;
};

export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginConfigError";
  }
}

export const PLUGIN_ENV_PREFIX = "OPENCODE_OPENAI_COMPAT";

export const ALLOWED_PLUGIN_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

// Later stories will validate and apply these defaults at runtime.
export const DEFAULT_PLUGIN_CONFIG: Readonly<PluginConfig> = {
  enabled: true,
  host: "127.0.0.1",
  port: 4097,
  apiKey: null,
  upstreamBaseUrl: null,
  upstreamUsername: null,
  upstreamPassword: null,
  defaultAgent: "build",
  requestTimeoutMs: 30_000,
  modelsCacheTtlMs: 5_000,
};

const readString = (value: unknown) => (typeof value === "string" ? value.trim() : null);

const readHost = (value: unknown) => {
  if (value == null) {
    return DEFAULT_PLUGIN_CONFIG.host;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginConfigError("Invalid host: expected a non-empty string.");
  }

  return value.trim();
};

const readOptionalString = (value: unknown) => {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new PluginConfigError(`Expected a string value but received ${typeof value}.`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const readBoolean = (key: PluginConfigKey, value: unknown, defaultValue: boolean) => {
  if (value == null) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  throw new PluginConfigError(`Invalid ${key}: expected a boolean value but received ${JSON.stringify(value)}.`);
};

const readInteger = (
  key: PluginConfigKey,
  value: unknown,
  defaultValue: number,
  options: {
    min: number;
    max: number;
  },
) => {
  if (value == null) {
    return defaultValue;
  }

  const parsed = (() => {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }

    return Number.NaN;
  })();

  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new PluginConfigError(
      `Invalid ${key}: expected an integer between ${options.min} and ${options.max} but received ${JSON.stringify(value)}.`,
    );
  }

  return parsed;
};

const readDefaultAgent = (value: unknown) => {
  if (value == null) {
    return DEFAULT_PLUGIN_CONFIG.defaultAgent;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginConfigError("Invalid defaultAgent: expected a non-empty string.");
  }

  return value.trim();
};

export const sanitizeUpstreamTarget = (value: string | URL | null | undefined) => {
  if (!value) {
    return null;
  }

  try {
    const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
};

export const readPluginConfigFromEnv = (env: NodeJS.ProcessEnv): RawPluginConfig => ({
  enabled: env[`${PLUGIN_ENV_PREFIX}_ENABLED`],
  host: env[`${PLUGIN_ENV_PREFIX}_HOST`],
  port: env[`${PLUGIN_ENV_PREFIX}_PORT`],
  apiKey: env[`${PLUGIN_ENV_PREFIX}_API_KEY`],
  upstreamBaseUrl: env[`${PLUGIN_ENV_PREFIX}_UPSTREAM_BASE_URL`],
  upstreamUsername: env[`${PLUGIN_ENV_PREFIX}_UPSTREAM_USERNAME`],
  upstreamPassword: env[`${PLUGIN_ENV_PREFIX}_UPSTREAM_PASSWORD`],
  defaultAgent: env[`${PLUGIN_ENV_PREFIX}_DEFAULT_AGENT`],
  requestTimeoutMs: env[`${PLUGIN_ENV_PREFIX}_REQUEST_TIMEOUT_MS`],
  modelsCacheTtlMs: env[`${PLUGIN_ENV_PREFIX}_MODELS_CACHE_TTL_MS`],
});

export const describeStartupAttempt = (
  rawConfig: RawPluginConfig | undefined,
  options: {
    upstreamUrl?: URL | string | null;
  } = {},
) => ({
  pluginName: PLUGIN_PACKAGE_NAME,
  bindHost: readString(rawConfig?.host) ?? DEFAULT_PLUGIN_CONFIG.host,
  bindPort: rawConfig?.port ?? DEFAULT_PLUGIN_CONFIG.port,
  upstreamTarget:
    sanitizeUpstreamTarget(readString(rawConfig?.upstreamBaseUrl)) ?? sanitizeUpstreamTarget(options.upstreamUrl),
});

export const parsePluginConfig = (
  rawConfig: RawPluginConfig | undefined,
  options: {
    upstreamUrl?: URL | string | null;
  } = {},
): ParsedPluginConfig => {
  const host = readHost(rawConfig?.host);
  if (!ALLOWED_PLUGIN_HOSTS.includes(host as (typeof ALLOWED_PLUGIN_HOSTS)[number])) {
    throw new PluginConfigError(
      `Invalid host: expected one of ${ALLOWED_PLUGIN_HOSTS.join(", ")} but received ${JSON.stringify(rawConfig?.host)}.`,
    );
  }

  const upstreamBaseUrl = readOptionalString(rawConfig?.upstreamBaseUrl) ?? options.upstreamUrl?.toString() ?? null;
  if (upstreamBaseUrl) {
    try {
      new URL(upstreamBaseUrl);
    } catch {
      throw new PluginConfigError(`Invalid upstreamBaseUrl: expected an absolute URL but received ${JSON.stringify(rawConfig?.upstreamBaseUrl)}.`);
    }
  }

  return {
    enabled: readBoolean("enabled", rawConfig?.enabled, DEFAULT_PLUGIN_CONFIG.enabled),
    host,
    port: readInteger("port", rawConfig?.port, DEFAULT_PLUGIN_CONFIG.port, {
      min: 0,
      max: 65_535,
    }),
    apiKey: readOptionalString(rawConfig?.apiKey),
    upstreamBaseUrl,
    upstreamUsername: readOptionalString(rawConfig?.upstreamUsername),
    upstreamPassword: readOptionalString(rawConfig?.upstreamPassword),
    defaultAgent: readDefaultAgent(rawConfig?.defaultAgent),
    requestTimeoutMs: readInteger(
      "requestTimeoutMs",
      rawConfig?.requestTimeoutMs,
      DEFAULT_PLUGIN_CONFIG.requestTimeoutMs,
      {
        min: 1,
        max: 300_000,
      },
    ),
    modelsCacheTtlMs: readInteger(
      "modelsCacheTtlMs",
      rawConfig?.modelsCacheTtlMs,
      DEFAULT_PLUGIN_CONFIG.modelsCacheTtlMs,
      {
        min: 1,
        max: 300_000,
      },
    ),
    sanitizedUpstreamTarget: sanitizeUpstreamTarget(upstreamBaseUrl),
  };
};
