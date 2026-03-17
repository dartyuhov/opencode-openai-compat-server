import type { Plugin } from "@opencode-ai/plugin";

export {
  DEFAULT_PLUGIN_CONFIG,
  PLUGIN_CONFIG_KEYS,
  PLUGIN_EXPORT_NAME,
  PLUGIN_PACKAGE_NAME,
  type PluginConfig,
  type PluginConfigKey,
} from "./config.js";

export const OpenCodeOpenAICompatPlugin: Plugin = async () => {
  return {};
};
