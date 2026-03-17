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
