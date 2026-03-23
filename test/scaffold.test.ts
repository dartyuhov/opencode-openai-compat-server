import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_PLUGIN_CONFIG,
  PLUGIN_ENV_PREFIX,
  OpenCodeOpenAICompatPlugin,
  PLUGIN_CONFIG_KEYS,
  PLUGIN_PACKAGE_NAME,
  PluginConfigError,
  getSidecarRuntimeForTests,
  parsePluginConfig,
  resetSidecarForTests,
  shouldAutoStartSidecarForCurrentProcess,
  startSidecarOnce,
} from "../src/index.js";

type LogEntry = {
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  extra?: Record<string, unknown>;
};

const createFakeClient = (logs: LogEntry[]) =>
  ({
    app: {
      log: async (options?: { body?: LogEntry }) => {
        if (options?.body) {
          logs.push(options.body);
        }

        return { data: true };
      },
    },
  }) as never;

const withEnv = async (values: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const previousEntries = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }

    await fn();
  } finally {
    for (const [key, value] of Object.entries(previousEntries)) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }
  }
};

afterEach(async () => {
  await resetSidecarForTests();
});

describe("plugin startup", () => {
  test("declares the required config keys in a stable order", () => {
    const requiredKeys: Array<(typeof PLUGIN_CONFIG_KEYS)[number]> = [...PLUGIN_CONFIG_KEYS];

    expect([...PLUGIN_CONFIG_KEYS]).toEqual(requiredKeys);
    expect(Object.keys(DEFAULT_PLUGIN_CONFIG) as Array<(typeof PLUGIN_CONFIG_KEYS)[number]>).toEqual(requiredKeys);
  });

  test("exposes the scaffold defaults", () => {
    expect(DEFAULT_PLUGIN_CONFIG).toEqual({
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
    });
  });

  test("parses defaults and derives a sanitized upstream target", () => {
    expect(parsePluginConfig(undefined, { upstreamUrl: new URL("http://127.0.0.1:4096") })).toEqual({
      ...DEFAULT_PLUGIN_CONFIG,
      upstreamBaseUrl: "http://127.0.0.1:4096/",
      sanitizedUpstreamTarget: "http://127.0.0.1:4096",
    });
  });

  test("rejects invalid numeric and host config values", () => {
    expect(() => parsePluginConfig({ port: "not-a-port" })).toThrow(PluginConfigError);
    expect(() => parsePluginConfig({ host: "0.0.0.0" })).toThrow(PluginConfigError);
  });

  test("detects serve mode from process arguments", () => {
    expect(shouldAutoStartSidecarForCurrentProcess(["node", "opencode", "serve"])) .toBe(true);
    expect(shouldAutoStartSidecarForCurrentProcess(["node", "opencode", "."])) .toBe(false);
  });

  test("logs clear startup failures and does not leave runtime state behind", async () => {
    const logs: LogEntry[] = [];

    await expect(
      startSidecarOnce({
        client: createFakeClient(logs),
        rawConfig: {
          host: "127.0.0.1",
          port: "not-a-port",
        },
        upstreamUrl: new URL("http://user:secret@127.0.0.1:4096/api"),
      }),
    ).rejects.toThrow('Invalid port: expected an integer between 0 and 65535 but received "not-a-port".');

    expect(getSidecarRuntimeForTests()).toBeNull();
    expect(logs).toContainEqual({
      service: PLUGIN_PACKAGE_NAME,
      level: "error",
      message: "OpenAI compatibility sidecar startup failed.",
      extra: {
        pluginName: PLUGIN_PACKAGE_NAME,
        bindHost: "127.0.0.1",
        bindPort: "not-a-port",
        upstreamTarget: "http://127.0.0.1:4096",
        error: 'Invalid port: expected an integer between 0 and 65535 but received "not-a-port".',
      },
    });

    const runtime = await startSidecarOnce({
      client: createFakeClient(logs),
      rawConfig: {
        host: "127.0.0.1",
        port: 0,
      },
      upstreamUrl: new URL("http://127.0.0.1:4096"),
    });

    expect(runtime).not.toBeNull();
    expect(runtime?.server.port).toBeGreaterThan(0);
  });

  test("skips sidecar startup when the configured port is already in use", async () => {
    const logs: LogEntry[] = [];
    const occupiedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("occupied");
      },
    });

    try {
      const runtime = await startSidecarOnce({
        client: createFakeClient(logs),
        rawConfig: {
          host: "127.0.0.1",
          port: occupiedServer.port,
        },
        upstreamUrl: new URL("http://127.0.0.1:4096"),
      });

      expect(runtime).toBeNull();
      expect(getSidecarRuntimeForTests()).toBeNull();
      expect(logs).toContainEqual({
        service: PLUGIN_PACKAGE_NAME,
        level: "warn",
        message: "Sidecar port is already in use; skipping startup and letting OpenCode continue.",
        extra: {
          pluginName: PLUGIN_PACKAGE_NAME,
          bindHost: "127.0.0.1",
          bindPort: occupiedServer.port,
          upstreamTarget: "http://127.0.0.1:4096",
          error: `Failed to start server. Is port ${occupiedServer.port} in use?`,
        },
      });
    } finally {
      await occupiedServer.stop(true);
    }
  });

  test("starts the sidecar once per process during serve mode and reuses the existing listener", async () => {
    const logs: LogEntry[] = [];
    const hooks = await OpenCodeOpenAICompatPlugin({
      client: createFakeClient(logs),
      project: {} as never,
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://127.0.0.1:4096"),
      $: {} as never,
    });

    expect(typeof hooks.event).toBe("function");

    const originalArgv = process.argv;
    await withEnv(
      {
        [`${PLUGIN_ENV_PREFIX}_HOST`]: "127.0.0.1",
        [`${PLUGIN_ENV_PREFIX}_PORT`]: "0",
        [`${PLUGIN_ENV_PREFIX}_UPSTREAM_BASE_URL`]: "http://user:secret@localhost:4096/session?token=secret",
      },
      async () => {
        try {
          process.argv = ["node", "opencode", "."];
          await hooks.event?.({ event: { type: "server.connected", properties: {} } as never });
          expect(getSidecarRuntimeForTests()).toBeNull();

          process.argv = ["node", "opencode", "serve"];
          await hooks.event?.({ event: { type: "server.connected", properties: {} } as never });
          const firstRuntime = getSidecarRuntimeForTests();

          expect(firstRuntime).not.toBeNull();
          expect(firstRuntime?.server.port).toBeGreaterThan(0);

          const firstResponse = await fetch(`http://127.0.0.1:${firstRuntime?.server.port}/`);
          expect(firstResponse.status).toBe(404);

          await hooks.event?.({ event: { type: "server.connected", properties: {} } as never });
          const secondRuntime = getSidecarRuntimeForTests();

          expect(secondRuntime).toBe(firstRuntime);
        } finally {
          process.argv = originalArgv;
        }
      },
    );

    expect(logs[0]).toMatchObject({
      service: PLUGIN_PACKAGE_NAME,
      level: "info",
      message: "Starting the OpenAI compatibility sidecar.",
      extra: {
        pluginName: PLUGIN_PACKAGE_NAME,
        bindHost: "127.0.0.1",
        bindPort: 0,
        upstreamTarget: "http://localhost:4096",
      },
    });

    expect(logs[1]).toMatchObject({
      service: PLUGIN_PACKAGE_NAME,
      level: "info",
      message: "OpenAI compatibility sidecar is listening.",
      extra: {
        pluginName: PLUGIN_PACKAGE_NAME,
        bindHost: "127.0.0.1",
        upstreamTarget: "http://localhost:4096",
      },
    });

    const reuseLog = logs.find((entry) => entry.message === "Sidecar startup already completed; reusing the existing listener.");
    expect(reuseLog).toMatchObject({
      service: PLUGIN_PACKAGE_NAME,
      level: "info",
      message: "Sidecar startup already completed; reusing the existing listener.",
      extra: {
        pluginName: PLUGIN_PACKAGE_NAME,
        bindHost: "127.0.0.1",
        upstreamTarget: "http://localhost:4096",
      },
    });
  });
});
