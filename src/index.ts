import type { Plugin } from "@opencode-ai/plugin";
import { startSidecarOnce } from "./sidecar.js";

export {
  ALLOWED_PLUGIN_HOSTS,
  DEFAULT_PLUGIN_CONFIG,
  PLUGIN_ENV_PREFIX,
  PLUGIN_CONFIG_KEYS,
  PLUGIN_EXPORT_NAME,
  PLUGIN_PACKAGE_NAME,
  PluginConfigError,
  describeStartupAttempt,
  parsePluginConfig,
  readPluginConfigFromEnv,
  sanitizeUpstreamTarget,
  type PluginConfig,
  type PluginConfigKey,
  type ParsedPluginConfig,
  type RawPluginConfig,
} from "./config.js";
export { getSidecarRuntimeForTests, resetSidecarForTests, startSidecarOnce, type SidecarRuntime } from "./sidecar.js";

export const OpenCodeOpenAICompatPlugin: Plugin = async (input) => {
  return {
    config: async (_config) => {
      await startSidecarOnce({
        client: input.client,
        upstreamUrl: input.serverUrl,
      });
    },
  };
};
