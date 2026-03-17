import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PLUGIN_CONFIG,
  OpenCodeOpenAICompatPlugin,
  PLUGIN_CONFIG_KEYS,
} from "../src/index.js";

describe("plugin scaffold", () => {
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

  test("returns a hooks object from the plugin entrypoint", async () => {
    const hooks = await OpenCodeOpenAICompatPlugin({
      client: {} as never,
      project: {} as never,
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://127.0.0.1:4096"),
      $: {} as never,
    });

    expect(hooks).toEqual({});
  });
});
