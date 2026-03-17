import { afterEach, describe, expect, test } from "bun:test";

import { PLUGIN_PACKAGE_NAME, resetSidecarForTests, startSidecarOnce } from "../src/index.js";

type LogEntry = {
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  extra?: Record<string, unknown>;
};

const activeServers: Bun.Server<undefined>[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const registerServer = (fetchHandler: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: fetchHandler,
  });

  activeServers.push(server);
  return server;
};

const startTestSidecar = async (logs: LogEntry[], input?: { apiKey?: string | null; upstreamUrl?: string; modelsCacheTtlMs?: number }) => {
  const runtime = await startSidecarOnce({
    client: createFakeClient(logs),
    rawConfig: {
      host: "127.0.0.1",
      port: 0,
      ...(input?.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      ...(input?.modelsCacheTtlMs !== undefined ? { modelsCacheTtlMs: input.modelsCacheTtlMs } : {}),
    },
    ...(input?.upstreamUrl ? { upstreamUrl: new URL(input.upstreamUrl) } : {}),
  });

  if (!runtime) {
    throw new Error("Expected the test sidecar to start.");
  }

  return runtime;
};

const getRequestLogs = (logs: LogEntry[]) => logs.filter((entry) => entry.message === "OpenAI compatibility sidecar request completed.");

afterEach(async () => {
  await resetSidecarForTests();

  const servers = activeServers.splice(0);
  await Promise.all(servers.map((server) => server.stop(true).catch(() => undefined)));
});

describe("sidecar server", () => {
  test("lists only connected models and reuses the fresh provider cache", async () => {
    let providerRequests = 0;
    const upstream = registerServer(() => {
      providerRequests += 1;

      return Response.json({
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            env: ["ANTHROPIC_API_KEY"],
            models: {
              "claude-sonnet-4": {
                id: "claude-sonnet-4",
                name: "Claude Sonnet 4",
                release_date: "2025-12-01",
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                limit: {
                  context: 200000,
                  output: 8192,
                },
                options: {},
              },
            },
          },
          {
            id: "openai",
            name: "OpenAI",
            api: "chat",
            env: ["OPENAI_API_KEY"],
            models: {
              "gpt-5.1": {
                id: "gpt-5.1",
                name: "GPT 5.1",
                release_date: "2026-01-01",
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                limit: {
                  context: 200000,
                  output: 16384,
                },
                options: {},
              },
            },
          },
          {
            id: "mistral",
            name: "Mistral",
            env: ["MISTRAL_API_KEY"],
            models: {},
          },
        ],
        default: {
          openai: "gpt-5.1",
        },
        connected: ["openai", "mistral"],
      });
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
      modelsCacheTtlMs: 1_000,
    });

    const firstResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/models`);
    const secondResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/models`);

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      object: "list",
      data: [
        {
          id: "openai/gpt-5.1",
          object: "model",
          created: 1767225600,
          owned_by: "openai",
        },
      ],
    });
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      object: "list",
      data: [
        {
          id: "openai/gpt-5.1",
          object: "model",
          created: 1767225600,
          owned_by: "openai",
        },
      ],
    });
    expect(providerRequests).toBe(1);

    const requestLogs = getRequestLogs(logs);
    expect(requestLogs).toHaveLength(2);
    expect(requestLogs[0]?.extra).toEqual({
      method: "GET",
      route: "/v1/models",
      status: 200,
      failureReason: null,
    });
    expect(requestLogs[1]?.extra).toEqual({
      method: "GET",
      route: "/v1/models",
      status: 200,
      failureReason: null,
    });
  });

  test("refreshes the model list after cache expiry", async () => {
    let providerRequests = 0;
    const upstream = registerServer(() => {
      providerRequests += 1;

      return Response.json({
        all: [
          {
            id: "openai",
            name: "OpenAI",
            api: "chat",
            env: ["OPENAI_API_KEY"],
            models:
              providerRequests === 1
                ? {
                    "gpt-5.1": {
                      id: "gpt-5.1",
                      name: "GPT 5.1",
                      release_date: "2026-01-01",
                      attachment: true,
                      reasoning: true,
                      temperature: true,
                      tool_call: true,
                      limit: {
                        context: 200000,
                        output: 16384,
                      },
                      options: {},
                    },
                  }
                : {
                    "gpt-5.1": {
                      id: "gpt-5.1",
                      name: "GPT 5.1",
                      release_date: "2026-01-01",
                      attachment: true,
                      reasoning: true,
                      temperature: true,
                      tool_call: true,
                      limit: {
                        context: 200000,
                        output: 16384,
                      },
                      options: {},
                    },
                    "gpt-5.1-mini": {
                      id: "gpt-5.1-mini",
                      name: "GPT 5.1 Mini",
                      release_date: "2026-02-01",
                      attachment: true,
                      reasoning: true,
                      temperature: true,
                      tool_call: true,
                      limit: {
                        context: 200000,
                        output: 8192,
                      },
                      options: {},
                    },
                  },
          },
        ],
        default: {
          openai: "gpt-5.1",
        },
        connected: ["openai"],
      });
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
      modelsCacheTtlMs: 40,
    });

    const firstResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/models`);
    await sleep(60);
    const refreshedResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/models`);

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      object: "list",
      data: [
        {
          id: "openai/gpt-5.1",
          object: "model",
          created: 1767225600,
          owned_by: "openai",
        },
      ],
    });
    expect(refreshedResponse.status).toBe(200);
    expect(await refreshedResponse.json()).toEqual({
      object: "list",
      data: [
        {
          id: "openai/gpt-5.1",
          object: "model",
          created: 1767225600,
          owned_by: "openai",
        },
        {
          id: "openai/gpt-5.1-mini",
          object: "model",
          created: 1769904000,
          owned_by: "openai",
        },
      ],
    });
    expect(providerRequests).toBe(2);
  });

  test("returns a sanitized 502 instead of stale models when refreshed metadata is malformed", async () => {
    let providerRequests = 0;
    const upstream = registerServer(() => {
      providerRequests += 1;

      if (providerRequests === 1) {
        return Response.json({
          all: [
            {
              id: "openai",
              name: "OpenAI",
              api: "chat",
              env: ["OPENAI_API_KEY"],
              models: {
                "gpt-5.1": {
                  id: "gpt-5.1",
                  name: "GPT 5.1",
                  release_date: "2026-01-01",
                  attachment: true,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  limit: {
                    context: 200000,
                    output: 16384,
                  },
                  options: {},
                },
              },
            },
          ],
          default: {
            openai: "gpt-5.1",
          },
          connected: ["openai"],
        });
      }

      return Response.json({
        all: [
          {
            id: "openai",
            name: "OpenAI",
            api: "chat",
            env: ["OPENAI_API_KEY"],
            models: [],
          },
        ],
        default: {
          openai: "gpt-5.1",
        },
        connected: ["openai"],
      });
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
      modelsCacheTtlMs: 40,
    });

    const firstResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/models`);
    await sleep(60);
    const refreshedResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/models`);
    const refreshedBody = (await refreshedResponse.json()) as Record<string, any>;

    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      object: "list",
      data: [
        {
          id: "openai/gpt-5.1",
          object: "model",
          created: 1767225600,
          owned_by: "openai",
        },
      ],
    });
    expect(refreshedResponse.status).toBe(502);
    expect(refreshedBody).toEqual({
      error: {
        message: "OpenCode upstream returned an invalid response.",
        type: "api_error",
        param: null,
        code: "invalid_response",
      },
    });
    expect(providerRequests).toBe(2);

    const requestLogs = getRequestLogs(logs);
    expect(requestLogs[0]?.extra).toEqual({
      method: "GET",
      route: "/v1/models",
      status: 200,
      failureReason: null,
    });
    expect(requestLogs[1]?.extra).toEqual({
      method: "GET",
      route: "/v1/models",
      status: 502,
      failureReason: "invalid_response",
    });
  });

  test("reports sidecar health and upstream reachability", async () => {
    let providerRequests = 0;
    const upstream = registerServer((request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/provider");
      providerRequests += 1;

      return Response.json({
        all: [],
        default: {},
        connected: [],
      });
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/health`);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      object: "opencode.sidecar.health",
      status: "ok",
      plugin: {
        name: PLUGIN_PACKAGE_NAME,
      },
      sidecar: {
        healthy: true,
        host: "127.0.0.1",
        port: runtime.server.port,
      },
      auth: {
        enabled: false,
      },
      upstream: {
        configured: true,
        reachable: true,
        status: "reachable",
        target: `http://127.0.0.1:${upstream.port}`,
        error: null,
      },
    });
    expect(providerRequests).toBe(1);

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog).toEqual({
      service: PLUGIN_PACKAGE_NAME,
      level: "info",
      message: "OpenAI compatibility sidecar request completed.",
      extra: {
        method: "GET",
        route: "/health",
        status: 200,
        failureReason: null,
      },
    });
  });

  test("returns degraded health when the upstream is unreachable", async () => {
    const upstream = registerServer(() => Response.json({ ok: true }));
    const port = upstream.port;
    await upstream.stop(true);
    activeServers.splice(activeServers.indexOf(upstream), 1);

    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://127.0.0.1:${port}`,
    });

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/health`);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.upstream).toEqual({
      configured: true,
      reachable: false,
      status: "unreachable",
      target: `http://127.0.0.1:${port}`,
      error: "network",
    });
  });

  test("enforces bearer auth before handler logic executes", async () => {
    let providerRequests = 0;
    const upstream = registerServer((request) => {
      providerRequests += 1;
      expect(new URL(request.url).pathname).toBe("/provider");

      return Response.json({
        all: [],
        default: {},
        connected: [],
      });
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      apiKey: "sidecar-secret",
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });

    const missingAuthResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/health`);
    const missingAuthBody = (await missingAuthResponse.json()) as Record<string, any>;

    expect(missingAuthResponse.status).toBe(401);
    expect(missingAuthBody).toEqual({
      error: {
        message: "Missing or invalid bearer token.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    });

    const wrongAuthResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/health`, {
      headers: {
        authorization: "Bearer wrong-secret",
      },
    });
    const wrongAuthBody = (await wrongAuthResponse.json()) as Record<string, any>;

    expect(wrongAuthResponse.status).toBe(401);
    expect(wrongAuthBody).toEqual(missingAuthBody);
    expect(providerRequests).toBe(0);

    const successResponse = await fetch(`http://127.0.0.1:${runtime.server.port}/health`, {
      headers: {
        authorization: "Bearer sidecar-secret",
      },
    });

    expect(successResponse.status).toBe(200);
    expect(providerRequests).toBe(1);

    const requestLogs = getRequestLogs(logs);
    expect(requestLogs).toHaveLength(3);
    expect(requestLogs[0]?.extra).toEqual({
      method: "GET",
      route: "/health",
      status: 401,
      failureReason: "unauthorized",
    });
    expect(requestLogs[1]?.extra).toEqual({
      method: "GET",
      route: "/health",
      status: 401,
      failureReason: "unauthorized",
    });
    expect(requestLogs[2]?.extra).toEqual({
      method: "GET",
      route: "/health",
      status: 200,
      failureReason: null,
    });
  });

  test("rejects stream=true before any upstream catalog lookup", async () => {
    let providerRequests = 0;
    const upstream = registerServer(() => {
      providerRequests += 1;

      return Response.json({
        all: [],
        default: {},
        connected: [],
      });
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-5.1",
        stream: true,
        messages: [
          {
            role: "user",
            content: "Say hello.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        message: "Invalid value for 'stream': only false or omitted is supported.",
        type: "invalid_request_error",
        param: "stream",
        code: "unsupported_stream",
      },
    });
    expect(providerRequests).toBe(0);

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 400,
      failureReason: "unsupported_stream",
    });
  });

  test("rejects multimodal content arrays with a field-specific error", async () => {
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs);

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-5.1",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Say hello.",
              },
            ],
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        message: "Invalid value for 'messages[0].content': content arrays are not supported.",
        type: "invalid_request_error",
        param: "messages[0].content",
        code: "unsupported_content",
      },
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 400,
      failureReason: "unsupported_content",
    });
  });

  test("rejects unknown models after checking the connected provider catalog", async () => {
    const observedPaths: string[] = [];
    const upstream = registerServer((request) => {
      const url = new URL(request.url);
      observedPaths.push(url.pathname);

      if (url.pathname !== "/provider") {
        return new Response("Not found", { status: 404 });
      }

      return Response.json({
        all: [
          {
            id: "openai",
            name: "OpenAI",
            api: "chat",
            env: ["OPENAI_API_KEY"],
            models: {
              "gpt-5.1": {
                id: "gpt-5.1",
                name: "GPT 5.1",
                release_date: "2026-01-01",
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                limit: {
                  context: 200000,
                  output: 16384,
                },
                options: {},
              },
            },
          },
        ],
        default: {
          openai: "gpt-5.1",
        },
        connected: ["openai"],
      });
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-5.1-mini",
        messages: [
          {
            role: "user",
            content: "Say hello.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        message: "Invalid value for 'model': model 'openai/gpt-5.1-mini' is not available from the current connected catalog.",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_model",
      },
    });
    expect(observedPaths).toEqual(["/provider"]);

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 400,
      failureReason: "invalid_model",
    });
  });

  test("returns a sanitized 502 for valid requests when the upstream is unconfigured", async () => {
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs);

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-5.1",
        messages: [
          {
            role: "system",
            content: "You are concise.",
          },
          {
            role: "user",
            content: "Say hello in one sentence.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        message: "OpenCode upstream is not configured.",
        type: "api_error",
        param: null,
        code: "upstream_unconfigured",
      },
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 502,
      failureReason: "upstream_unconfigured",
    });
  });

  test("returns OpenAI-like errors for unsupported routes", async () => {
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs);

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/chat/completions`);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        message: "Route GET /v1/chat/completions is not supported.",
        type: "invalid_request_error",
        param: null,
        code: "not_found",
      },
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "GET",
      route: "/v1/chat/completions",
      status: 404,
      failureReason: "not_found",
    });
  });
});
