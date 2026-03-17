import type { Plugin } from "@opencode-ai/plugin";
import { startSidecarOnce } from "./sidecar.js";

export {
  ChatCompletionValidationError,
  parseChatCompletionRequest,
  prepareChatCompletionRequest,
  resolveChatCompletionModel,
  serializeChatCompletionMessages,
  type OpenAIChatCompletionRequest,
  type OpenAIChatMessage,
  type OpenAIChatMessageRole,
  type PreparedChatCompletionRequest,
  type ResolvedChatCompletionModel,
} from "./chat.js";
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
export {
  getSidecarRuntimeForTests,
  mapAssistantMessageToChatCompletion,
  mapErrorToOpenAIResponse,
  resetSidecarForTests,
  startSidecarOnce,
  type OpenAIChatCompletionResponse,
  type OpenAIErrorEnvelope,
  type SidecarRuntime,
} from "./sidecar.js";
export { mapProviderCatalogToOpenAIModelList, type OpenAIModel, type OpenAIModelList } from "./models.js";
export {
  OpenCodeUpstreamClient,
  UpstreamClientError,
  isUpstreamClientError,
  type CreateUpstreamAssistantMessageInput,
  type CreateUpstreamSessionInput,
  type OpenCodeUpstreamClientOptions,
  type UpstreamAssistantMessage,
  type UpstreamAssistantMessagePart,
  type UpstreamClientErrorCode,
  type UpstreamModel,
  type UpstreamModelCost,
  type UpstreamModelStatus,
  type UpstreamModality,
  type UpstreamProvider,
  type UpstreamProviderCatalog,
  type UpstreamProviderCatalogRequest,
  type UpstreamSession,
} from "./upstream.js";

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
