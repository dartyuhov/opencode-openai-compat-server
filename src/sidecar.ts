import type { PluginInput } from "@opencode-ai/plugin";

import {
  describeStartupAttempt,
  parsePluginConfig,
  readPluginConfigFromEnv,
  type ParsedPluginConfig,
  PLUGIN_PACKAGE_NAME,
  type RawPluginConfig,
} from "./config.js";

type PluginClient = PluginInput["client"];

export type SidecarRuntime = {
  config: ParsedPluginConfig;
  server: Bun.Server<undefined>;
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

const SIDECAR_STATE_KEY = Symbol.for("opencode-openai-compat.sidecar-state");

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

const createSidecarServer = (config: ParsedPluginConfig): Bun.Server<undefined> =>
  Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch() {
      return Response.json(
        {
          error: {
            message: "The OpenAI compatibility sidecar is not fully initialized yet.",
            type: "not_implemented",
          },
        },
        { status: 404 },
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

    try {
      server = createSidecarServer(config);
      const runtime: SidecarRuntime = {
        config,
        server,
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
