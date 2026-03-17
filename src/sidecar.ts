import type { PluginInput } from "@opencode-ai/plugin";
import { timingSafeEqual } from "node:crypto";

import {
  ChatCompletionValidationError,
  parseChatCompletionRequest,
  resolveChatCompletionModel,
  serializeChatCompletionMessages,
} from "./chat.js";
import {
  describeStartupAttempt,
  parsePluginConfig,
  readPluginConfigFromEnv,
  type ParsedPluginConfig,
  PLUGIN_PACKAGE_NAME,
  type RawPluginConfig,
} from "./config.js";
import { mapProviderCatalogToOpenAIModelList } from "./models.js";
import {
  OpenCodeUpstreamClient,
  UpstreamClientError,
  isUpstreamClientError,
  type UpstreamAssistantMessage,
  type UpstreamAssistantMessagePart,
} from "./upstream.js";

type PluginClient = PluginInput["client"];

export type SidecarRuntime = {
  config: ParsedPluginConfig;
  server: Bun.Server<undefined>;
  upstreamClient: OpenCodeUpstreamClient | null;
};

type SidecarState = {
  runtime: SidecarRuntime | null;
  startupPromise: Promise<SidecarRuntime | null> | null;
};

type StartupLogDetails = {
  bindHost: string;
  bindPort: number | string | unknown;
  upstreamTarget: string | null;
};

type StartSidecarOptions = {
  client: PluginClient;
  rawConfig?: RawPluginConfig;
  upstreamUrl?: URL;
};

type SidecarRouteContext = {
  request: Request;
  server: Bun.Server<undefined>;
  url: URL;
  runtime: {
    config: ParsedPluginConfig;
    upstreamClient: OpenCodeUpstreamClient | null;
  };
};

type SidecarRouteMatch = {
  route: string;
  handler: (context: SidecarRouteContext) => Promise<Response>;
};

type OpenAIErrorEnvelope = {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
};

type OpenAIChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type SidecarRequestLogDetails = {
  method: string;
  route: string;
  status: number;
  failureReason: string | null;
};

const SIDECAR_STATE_KEY = Symbol.for("opencode-openai-compat.sidecar-state");
const JSON_RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

class SidecarHttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | null;
  readonly code: string | null;
  readonly failureReason: string;

  constructor(input: {
    status: number;
    message: string;
    type?: string;
    param?: string | null;
    code?: string | null;
    failureReason: string;
  }) {
    super(input.message);
    this.name = "SidecarHttpError";
    this.status = input.status;
    this.type = input.type ?? "invalid_request_error";
    this.param = input.param ?? null;
    this.code = input.code ?? null;
    this.failureReason = input.failureReason;
  }
}

const getSidecarState = () => {
  const globalState = globalThis as typeof globalThis & {
    [SIDECAR_STATE_KEY]?: SidecarState;
  };

  globalState[SIDECAR_STATE_KEY] ??= {
    runtime: null,
    startupPromise: null,
  };

  return globalState[SIDECAR_STATE_KEY];
};

const logSidecarEvent = async (
  client: PluginClient,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra: Record<string, unknown>,
) => {
  try {
    await client.app.log({
      body: {
        service: PLUGIN_PACKAGE_NAME,
        level,
        message,
        extra,
      },
    });
  } catch {
    // Startup should not fail because logging is unavailable.
  }
};

const buildLogDetails = (config: StartupLogDetails) => ({
  pluginName: PLUGIN_PACKAGE_NAME,
  bindHost: config.bindHost,
  bindPort: config.bindPort,
  upstreamTarget: config.upstreamTarget,
});

const buildResponseHeaders = (headersInit?: ResponseInit["headers"]) => {
  const headers = new Headers(JSON_RESPONSE_HEADERS);

  if (!headersInit) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      headers.set(key, value);
    }

    return Object.fromEntries(headers.entries());
  }

  if (headersInit instanceof Headers) {
    for (const [key, value] of headersInit.entries()) {
      headers.set(key, value);
    }

    return Object.fromEntries(headers.entries());
  }

  for (const [key, value] of Object.entries(headersInit)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return Object.fromEntries(headers.entries());
};

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: buildResponseHeaders(init.headers),
  });

const createOpenAIErrorResponse = (input: {
  status: number;
  message: string;
  type?: string;
  param?: string | null;
  code?: string | null;
}) =>
  jsonResponse(
    {
      error: {
        message: input.message,
        type: input.type ?? "invalid_request_error",
        param: input.param ?? null,
        code: input.code ?? null,
      },
    } satisfies OpenAIErrorEnvelope,
    {
      status: input.status,
    },
  );

const normalizeCompletionTimestamp = (value: number) =>
  value >= 1_000_000_000_000 ? Math.floor(value / 1_000) : Math.floor(value);

const buildAssistantMessageEndpoint = (sessionId: string) => `/session/${encodeURIComponent(sessionId)}/message`;

const readAssistantContent = (assistantMessage: UpstreamAssistantMessage) => {
  const content = assistantMessage.parts
    .filter((part): part is Extract<UpstreamAssistantMessagePart, { type: "text" }> => part.type === "text")
    .filter((part) => !part.ignored)
    .map((part) => part.text)
    .join("");

  if (content.length === 0) {
    throw new UpstreamClientError({
      code: "invalid_response",
      message: "OpenCode upstream returned an invalid response.",
      endpoint: buildAssistantMessageEndpoint(assistantMessage.sessionId),
    });
  }

  return content;
};

const mapUsage = (assistantMessage: UpstreamAssistantMessage): OpenAIChatCompletionResponse["usage"] | undefined => {
  const tokens = assistantMessage.tokens;

  if (!tokens || tokens.input < 0 || tokens.output < 0) {
    return undefined;
  }

  return {
    prompt_tokens: tokens.input,
    completion_tokens: tokens.output,
    total_tokens: tokens.input + tokens.output,
  };
};

const mapAssistantMessageToChatCompletion = (
  assistantMessage: UpstreamAssistantMessage,
  requestedModel: string,
): OpenAIChatCompletionResponse => {
  const content = readAssistantContent(assistantMessage);
  const usage = mapUsage(assistantMessage);

  return {
    id: assistantMessage.id,
    object: "chat.completion",
    created: normalizeCompletionTimestamp(assistantMessage.createdAt),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: assistantMessage.finish && assistantMessage.finish.length > 0 ? assistantMessage.finish : "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  };
};

const readJsonRequest = async <T>(request: Request): Promise<T> => {
  const rawBody = await request.text();

  if (rawBody.trim().length === 0) {
    throw new SidecarHttpError({
      status: 400,
      message: "Request body must be a valid JSON object.",
      code: "invalid_json",
      failureReason: "invalid_json",
    });
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new SidecarHttpError({
      status: 400,
      message: "Request body must be a valid JSON object.",
      code: "invalid_json",
      failureReason: "invalid_json",
    });
  }
};

const secureCompare = (expected: string, actual: string) => {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
};

const getBearerToken = (request: Request) => {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1]?.trim();
  return token ? token : null;
};

const ensureAuthorized = (request: Request, apiKey: string | null) => {
  if (!apiKey) {
    return;
  }

  const token = getBearerToken(request);
  if (!token || !secureCompare(apiKey, token)) {
    throw new SidecarHttpError({
      status: 401,
      message: "Missing or invalid bearer token.",
      code: "invalid_api_key",
      failureReason: "unauthorized",
    });
  }
};

const resolveRoute = (request: Request, url: URL): SidecarRouteMatch | null => {
  if (request.method === "GET" && url.pathname === "/health") {
    return {
      route: "/health",
      handler: handleHealthRequest,
    };
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    return {
      route: "/v1/models",
      handler: handleModelsRequest,
    };
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    return {
      route: "/v1/chat/completions",
      handler: handleChatCompletionsRequest,
    };
  }

  return null;
};

const createNotFoundError = (request: Request, pathname: string) =>
  new SidecarHttpError({
    status: 404,
    message: `Route ${request.method.toUpperCase()} ${pathname} is not supported.`,
    code: "not_found",
    failureReason: "not_found",
  });

const normalizeError = (error: unknown): {
  response: Response;
  failureReason: string;
} => {
  if (error instanceof SidecarHttpError) {
    return {
      response: createOpenAIErrorResponse({
        status: error.status,
        message: error.message,
        type: error.type,
        param: error.param,
        code: error.code,
      }),
      failureReason: error.failureReason,
    };
  }

  if (error instanceof ChatCompletionValidationError) {
    return {
      response: createOpenAIErrorResponse({
        status: 400,
        message: error.message,
        param: error.param,
        code: error.code,
      }),
      failureReason: error.failureReason,
    };
  }

  if (isUpstreamClientError(error)) {
    return {
      response: createOpenAIErrorResponse({
        status: error.status,
        message: error.message,
        type: "api_error",
        code: error.code,
      }),
      failureReason: error.code,
    };
  }

  return {
    response: createOpenAIErrorResponse({
      status: 500,
      message: "The OpenAI compatibility sidecar encountered an unexpected error.",
      type: "server_error",
      code: "internal_error",
    }),
    failureReason: "internal_error",
  };
};

const logRequest = async (client: PluginClient, details: SidecarRequestLogDetails) => {
  await logSidecarEvent(client, details.status >= 500 ? "error" : details.status >= 400 ? "warn" : "info", "OpenAI compatibility sidecar request completed.", {
    method: details.method,
    route: details.route,
    status: details.status,
    failureReason: details.failureReason,
  });
};

const buildUpstreamHealth = async (runtime: SidecarRouteContext["runtime"]) => {
  if (!runtime.upstreamClient || !runtime.config.upstreamBaseUrl) {
    return {
      configured: false,
      reachable: null,
      status: "unconfigured",
      target: runtime.config.sanitizedUpstreamTarget,
      error: null,
    };
  }

  try {
    await runtime.upstreamClient.getProviderCatalog();

    return {
      configured: true,
      reachable: true,
      status: "reachable",
      target: runtime.config.sanitizedUpstreamTarget,
      error: null,
    };
  } catch (error) {
    if (isUpstreamClientError(error)) {
      return {
        configured: true,
        reachable: false,
        status: "unreachable",
        target: runtime.config.sanitizedUpstreamTarget,
        error: error.code,
      };
    }

    throw error;
  }
};

const handleHealthRequest = async (context: SidecarRouteContext) => {
  const upstream = await buildUpstreamHealth(context.runtime);

  return jsonResponse({
    object: "opencode.sidecar.health",
    status: upstream.reachable === false ? "degraded" : "ok",
    plugin: {
      name: PLUGIN_PACKAGE_NAME,
    },
    sidecar: {
      healthy: true,
      host: context.server.hostname ?? context.runtime.config.host,
      port: context.server.port ?? context.runtime.config.port,
    },
    auth: {
      enabled: context.runtime.config.apiKey !== null,
    },
    upstream,
  });
};

const handleModelsRequest = async (context: SidecarRouteContext) => {
  if (!context.runtime.upstreamClient) {
    throw new SidecarHttpError({
      status: 502,
      message: "OpenCode upstream is not configured.",
      type: "api_error",
      code: "upstream_unconfigured",
      failureReason: "upstream_unconfigured",
    });
  }

  const catalog = await context.runtime.upstreamClient.getProviderCatalog();

  try {
    return jsonResponse(mapProviderCatalogToOpenAIModelList(catalog));
  } catch {
    throw new UpstreamClientError({
      code: "invalid_response",
      message: "OpenCode upstream returned an invalid response.",
      endpoint: "/provider",
    });
  }
};

const handleChatCompletionsRequest = async (context: SidecarRouteContext) => {
  const requestBody = await readJsonRequest<unknown>(context.request);
  const parsedRequest = parseChatCompletionRequest(requestBody);

  if (!context.runtime.upstreamClient) {
    throw new SidecarHttpError({
      status: 502,
      message: "OpenCode upstream is not configured.",
      type: "api_error",
      code: "upstream_unconfigured",
      failureReason: "upstream_unconfigured",
    });
  }

  const catalog = await context.runtime.upstreamClient.getProviderCatalog();
  const resolvedModel = resolveChatCompletionModel(parsedRequest.model, catalog);
  const prompt = serializeChatCompletionMessages(parsedRequest.messages);
  const session = await context.runtime.upstreamClient.createSession({
    title: "OpenAI chat completion",
  });
  const assistantMessage = await context.runtime.upstreamClient.createAssistantMessage({
    sessionId: session.id,
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    agent: context.runtime.config.defaultAgent,
    prompt,
  });

  return jsonResponse(mapAssistantMessageToChatCompletion(assistantMessage, parsedRequest.model));
};

const handleSidecarRequest = async (
  request: Request,
  server: Bun.Server<undefined>,
  runtime: SidecarRouteContext["runtime"],
  client: PluginClient,
) => {
  const url = new URL(request.url);
  const routeMatch = resolveRoute(request, url);
  const route = routeMatch?.route ?? url.pathname;
  let status = 500;
  let failureReason: string | null = null;

  try {
    ensureAuthorized(request, runtime.config.apiKey);

    if (!routeMatch) {
      throw createNotFoundError(request, url.pathname);
    }

    const response = await routeMatch.handler({
      request,
      server,
      url,
      runtime,
    });

    status = response.status;
    return response;
  } catch (error) {
    const normalized = normalizeError(error);
    status = normalized.response.status;
    failureReason = normalized.failureReason;
    return normalized.response;
  } finally {
    await logRequest(client, {
      method: request.method.toUpperCase(),
      route,
      status,
      failureReason,
    });
  }
};

const createSidecarServer = (input: {
  client: PluginClient;
  config: ParsedPluginConfig;
  upstreamClient: OpenCodeUpstreamClient | null;
}): Bun.Server<undefined> =>
  Bun.serve({
    hostname: input.config.host,
    port: input.config.port,
    fetch(request, server) {
      return handleSidecarRequest(
        request,
        server,
        {
          config: input.config,
          upstreamClient: input.upstreamClient,
        },
        input.client,
      );
    },
  });

export const startSidecarOnce = async ({ client, rawConfig, upstreamUrl }: StartSidecarOptions) => {
  const resolvedRawConfig = rawConfig ?? readPluginConfigFromEnv(process.env);
  let config: ParsedPluginConfig;

  try {
    config = parsePluginConfig(resolvedRawConfig, {
      upstreamUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await logSidecarEvent(client, "error", "OpenAI compatibility sidecar startup failed.", {
      ...buildLogDetails(describeStartupAttempt(resolvedRawConfig, { upstreamUrl })),
      error: message,
    });

    throw error;
  }

  const state = getSidecarState();

  if (!config.enabled) {
    await logSidecarEvent(client, "info", "Sidecar startup skipped because the plugin is disabled.", buildLogDetails({
      bindHost: config.host,
      bindPort: config.port,
      upstreamTarget: config.sanitizedUpstreamTarget,
    }));
    return null;
  }

  if (state.runtime) {
    await logSidecarEvent(
      client,
      "info",
      "Sidecar startup already completed; reusing the existing listener.",
      buildLogDetails({
        bindHost: state.runtime.server.hostname ?? state.runtime.config.host,
        bindPort: state.runtime.server.port ?? state.runtime.config.port,
        upstreamTarget: state.runtime.config.sanitizedUpstreamTarget,
      }),
    );
    return state.runtime;
  }

  if (state.startupPromise) {
    return state.startupPromise;
  }

  await logSidecarEvent(client, "info", "Starting the OpenAI compatibility sidecar.", buildLogDetails({
    bindHost: config.host,
    bindPort: config.port,
    upstreamTarget: config.sanitizedUpstreamTarget,
  }));

  state.startupPromise = (async () => {
    let server: Bun.Server<undefined> | null = null;
    const upstreamClient = config.upstreamBaseUrl
      ? new OpenCodeUpstreamClient({
          baseUrl: config.upstreamBaseUrl,
          username: config.upstreamUsername,
          password: config.upstreamPassword,
          requestTimeoutMs: config.requestTimeoutMs,
          modelsCacheTtlMs: config.modelsCacheTtlMs,
        })
      : null;

    try {
      server = createSidecarServer({
        client,
        config,
        upstreamClient,
      });
      const runtime: SidecarRuntime = {
        config,
        server,
        upstreamClient,
      };

      state.runtime = runtime;

      await logSidecarEvent(
        client,
        "info",
        "OpenAI compatibility sidecar is listening.",
        buildLogDetails({
          bindHost: server.hostname ?? config.host,
          bindPort: server.port ?? config.port,
          upstreamTarget: config.sanitizedUpstreamTarget,
        }),
      );

      return runtime;
    } catch (error) {
      state.runtime = null;

      if (server) {
        await server.stop(true).catch(() => undefined);
      }

      const attemptedStartup = describeStartupAttempt(resolvedRawConfig, {
        upstreamUrl,
      });
      const message = error instanceof Error ? error.message : String(error);

      await logSidecarEvent(client, "error", "OpenAI compatibility sidecar startup failed.", {
        ...buildLogDetails(attemptedStartup),
        error: message,
      });

      throw error;
    } finally {
      state.startupPromise = null;
    }
  })();

  return state.startupPromise;
};

export const getSidecarRuntimeForTests = () => getSidecarState().runtime;

export const resetSidecarForTests = async () => {
  const state = getSidecarState();
  const runtime = state.runtime;

  state.runtime = null;
  state.startupPromise = null;

  if (runtime) {
    await runtime.server.stop(true);
  }
};
