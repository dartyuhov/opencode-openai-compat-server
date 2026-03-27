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

const startTestSidecar = async (
  logs: LogEntry[],
  input?: { apiKey?: string | null; upstreamUrl?: string; requestTimeoutMs?: number; modelsCacheTtlMs?: number },
) => {
  const runtime = await startSidecarOnce({
    client: createFakeClient(logs),
    rawConfig: {
      host: "127.0.0.1",
      port: 0,
      ...(input?.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      ...(input?.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
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

const parseServerSentEvents = (bodyText: string) => {
  const events: Array<string | Record<string, unknown>> = [];

  for (const block of bodyText.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (data.length === 0) {
      continue;
    }

    events.push(data === "[DONE]" ? data : (JSON.parse(data) as Record<string, unknown>));
  }

  return events;
};

const buildConnectedOpenAICatalog = () => ({
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

  test("streams assistant deltas as OpenAI-compatible server-sent events", async () => {
    const observedPaths: string[] = [];
    let createMessageBody: unknown;
    let eventController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const writeEvent = (payload: unknown) => {
      eventController?.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };
    const upstream = registerServer(async (request) => {
      const url = new URL(request.url);
      observedPaths.push(`${request.method} ${url.pathname}`);

      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json(buildConnectedOpenAICatalog());
      }

      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({
          id: "session-123",
          projectID: "project-1",
          directory: "/workspace/demo",
          title: "OpenAI chat completion",
          version: "1",
          time: {
            created: 1700000000,
            updated: 1700000001,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/global/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              eventController = controller;
              writeEvent({
                payload: {
                  type: "server.connected",
                  properties: {},
                },
              });
            },
            cancel() {
              eventController = null;
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
            },
          },
        );
      }

      if (request.method === "POST" && url.pathname === "/session/session-123/message") {
        createMessageBody = await request.json();

        writeEvent({
          payload: {
            type: "message.updated",
            properties: {
              info: {
                id: "message-1",
                sessionID: "session-123",
                role: "assistant",
                time: {
                  created: 1700000002,
                },
              },
            },
          },
        });
        writeEvent({
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "part-1",
                sessionID: "session-123",
                messageID: "message-1",
                type: "text",
                text: "",
              },
            },
          },
        });
        writeEvent({
          payload: {
            type: "message.part.delta",
            properties: {
              sessionID: "session-123",
              messageID: "message-1",
              partID: "part-1",
              field: "text",
              delta: "Hello",
            },
          },
        });
        writeEvent({
          payload: {
            type: "message.part.delta",
            properties: {
              sessionID: "session-123",
              messageID: "message-1",
              partID: "part-1",
              field: "text",
              delta: " world",
            },
          },
        });

        await sleep(10);

        return Response.json({
          info: {
            id: "message-1",
            sessionID: "session-123",
            role: "assistant",
            time: {
              created: 1700000002,
              completed: 1700000003,
            },
            parentID: "message-0",
            modelID: "gpt-5.1",
            providerID: "openai",
            mode: "chat",
            path: {
              cwd: "/workspace/demo",
              root: "/workspace/demo",
            },
            tokens: {
              input: 12,
              output: 7,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
            finish: "stop",
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-123",
              messageID: "message-1",
              type: "text",
              text: "Hello world",
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
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
    const bodyText = await response.text();
    const events = parseServerSentEvents(bodyText);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(observedPaths).toEqual([
      "GET /provider",
      "POST /session",
      "GET /global/event",
      "POST /session/session-123/message",
    ]);
    expect(createMessageBody).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.1",
      },
      agent: "build",
      parts: [
        {
          type: "text",
          text: "User:\nSay hello.",
        },
      ],
    });
    expect(events).toEqual([
      {
        id: "message-1",
        object: "chat.completion.chunk",
        created: 1700000002,
        model: "openai/gpt-5.1",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "message-1",
        object: "chat.completion.chunk",
        created: 1700000002,
        model: "openai/gpt-5.1",
        choices: [
          {
            index: 0,
            delta: {
              content: "Hello",
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "message-1",
        object: "chat.completion.chunk",
        created: 1700000002,
        model: "openai/gpt-5.1",
        choices: [
          {
            index: 0,
            delta: {
              content: " world",
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "message-1",
        object: "chat.completion.chunk",
        created: 1700000002,
        model: "openai/gpt-5.1",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      },
      "[DONE]",
    ]);

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 200,
      failureReason: null,
    });
  });

  test("rejects invalid JSON before any upstream work executes", async () => {
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs);

    const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{",
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        message: "Request body must be a valid JSON object.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_json",
      },
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 400,
      failureReason: "invalid_json",
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

  test("returns a sanitized 502 when the upstream provider lookup times out", async () => {
    const observedPaths: string[] = [];
    const upstream = registerServer(async (request) => {
      const url = new URL(request.url);
      observedPaths.push(`${request.method} ${url.pathname}`);
      await sleep(60);

      return Response.json(buildConnectedOpenAICatalog());
    });
    const logs: LogEntry[] = [];
    const runtime = await startTestSidecar(logs, {
      upstreamUrl: `http://user:secret@127.0.0.1:${upstream.port}`,
      requestTimeoutMs: 10,
    });

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
            content: "Say hello.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        message: "OpenCode upstream request timed out.",
        type: "api_error",
        param: null,
        code: "timeout",
      },
    });
    expect(observedPaths).toEqual(["GET /provider"]);
    expect(JSON.stringify(body)).not.toContain("user");
    expect(JSON.stringify(body)).not.toContain("secret");

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 502,
      failureReason: "timeout",
    });
  });

  test("executes chat completions and maps assistant text into OpenAI-style JSON", async () => {
    const observedPaths: string[] = [];
    let createSessionBody: unknown;
    let createMessageBody: unknown;
    const upstream = registerServer(async (request) => {
      const url = new URL(request.url);
      observedPaths.push(`${request.method} ${url.pathname}`);

      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json(buildConnectedOpenAICatalog());
      }

      if (request.method === "POST" && url.pathname === "/session") {
        createSessionBody = await request.json();

        return Response.json({
          id: "session-123",
          projectID: "project-1",
          directory: "/workspace/demo",
          title: "OpenAI chat completion",
          version: "1",
          time: {
            created: 1700000000,
            updated: 1700000001,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/session/session-123/message") {
        createMessageBody = await request.json();

        return Response.json({
          info: {
            id: "message-1",
            sessionID: "session-123",
            role: "assistant",
            time: {
              created: 1700000002,
              completed: 1700000003,
            },
            parentID: "message-0",
            modelID: "gpt-5.1",
            providerID: "openai",
            mode: "chat",
            path: {
              cwd: "/workspace/demo",
              root: "/workspace/demo",
            },
            cost: 0.42,
            tokens: {
              input: 12,
              output: 7,
              reasoning: 2,
              cache: {
                read: 1,
                write: 0,
              },
            },
            finish: "stop",
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-123",
              messageID: "message-1",
              type: "reasoning",
              text: "hidden reasoning",
            },
            {
              id: "part-2",
              sessionID: "session-123",
              messageID: "message-1",
              type: "text",
              text: "Hello",
            },
            {
              id: "part-3",
              sessionID: "session-123",
              messageID: "message-1",
              type: "text",
              text: " world",
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
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
        temperature: 0.2,
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

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "message-1",
      object: "chat.completion",
      created: 1700000002,
      model: "openai/gpt-5.1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello world",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
      },
    });
    expect(observedPaths).toEqual(["GET /provider", "POST /session", "POST /session/session-123/message"]);
    expect(createSessionBody).toEqual({
      title: "OpenAI chat completion",
    });
    expect(createMessageBody).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.1",
      },
      agent: "build",
      parts: [
        {
          type: "text",
          text: "System:\nYou are concise.\n\nUser:\nSay hello in one sentence.",
        },
      ],
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 200,
      failureReason: null,
    });
  });

  test("accepts a bare model id when it uniquely matches the connected catalog", async () => {
    let createMessageBody: unknown;
    const upstream = registerServer(async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json(buildConnectedOpenAICatalog());
      }

      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({
          id: "session-345",
          projectID: "project-1",
          directory: "/workspace/demo",
          title: "OpenAI chat completion",
          version: "1",
          time: {
            created: 1700000200,
            updated: 1700000201,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/session/session-345/message") {
        createMessageBody = await request.json();

        return Response.json({
          info: {
            id: "message-3",
            sessionID: "session-345",
            role: "assistant",
            time: {
              created: 1700000202,
              completed: 1700000203,
            },
            parentID: "message-2",
            modelID: "gpt-5.1",
            providerID: "openai",
            mode: "chat",
            path: {
              cwd: "/workspace/demo",
              root: "/workspace/demo",
            },
            finish: "stop",
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-345",
              messageID: "message-3",
              type: "text",
              text: "Hello again",
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
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
        model: "gpt-5.1",
        messages: [
          {
            role: "user",
            content: "Say hello again.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "message-3",
      object: "chat.completion",
      created: 1700000202,
      model: "gpt-5.1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello again",
          },
          finish_reason: "stop",
        },
      ],
    });
    expect(createMessageBody).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.1",
      },
      agent: "build",
      parts: [
        {
          type: "text",
          text: "User:\nSay hello again.",
        },
      ],
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 200,
      failureReason: null,
    });
  });

  test("omits usage when the upstream assistant response lacks token metadata", async () => {
    const upstream = registerServer(async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json(buildConnectedOpenAICatalog());
      }

      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({
          id: "session-234",
          projectID: "project-1",
          directory: "/workspace/demo",
          title: "OpenAI chat completion",
          version: "1",
          time: {
            created: 1700000100,
            updated: 1700000101,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/session/session-234/message") {
        return Response.json({
          info: {
            id: "message-2",
            sessionID: "session-234",
            role: "assistant",
            time: {
              created: 1700000102,
            },
            parentID: "message-1",
            modelID: "gpt-5.1",
            providerID: "openai",
            mode: "chat",
            path: {
              cwd: "/workspace/demo",
              root: "/workspace/demo",
            },
            finish: null,
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-234",
              messageID: "message-2",
              type: "text",
              text: "Hello without usage",
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
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
        messages: [
          {
            role: "user",
            content: "Say hello.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "message-2",
      object: "chat.completion",
      created: 1700000102,
      model: "openai/gpt-5.1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello without usage",
          },
          finish_reason: "stop",
        },
      ],
    });
    expect(body).not.toHaveProperty("usage");

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 200,
      failureReason: null,
    });
  });

  test("returns a sanitized 502 when the upstream execution fails", async () => {
    const upstream = registerServer(async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json(buildConnectedOpenAICatalog());
      }

      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({
          id: "session-345",
          projectID: "project-1",
          directory: "/workspace/demo",
          title: "OpenAI chat completion",
          version: "1",
          time: {
            created: 1700000200,
            updated: 1700000201,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/session/session-345/message") {
        return new Response("upstream exploded", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
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
        messages: [
          {
            role: "user",
            content: "Say hello.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        message: "OpenCode upstream request failed.",
        type: "api_error",
        param: null,
        code: "upstream",
      },
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 502,
      failureReason: "upstream",
    });
  });

  test("returns a sanitized 502 when the upstream response has no assistant text parts", async () => {
    const upstream = registerServer(async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json(buildConnectedOpenAICatalog());
      }

      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({
          id: "session-456",
          projectID: "project-1",
          directory: "/workspace/demo",
          title: "OpenAI chat completion",
          version: "1",
          time: {
            created: 1700000300,
            updated: 1700000301,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/session/session-456/message") {
        return Response.json({
          info: {
            id: "message-3",
            sessionID: "session-456",
            role: "assistant",
            time: {
              created: 1700000302,
              completed: 1700000303,
            },
            parentID: "message-2",
            modelID: "gpt-5.1",
            providerID: "openai",
            mode: "chat",
            path: {
              cwd: "/workspace/demo",
              root: "/workspace/demo",
            },
            tokens: {
              input: 8,
              output: 0,
              reasoning: 1,
              cache: {
                read: 0,
                write: 0,
              },
            },
            finish: "stop",
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-456",
              messageID: "message-3",
              type: "reasoning",
              text: "hidden",
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
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
        messages: [
          {
            role: "user",
            content: "Say hello.",
          },
        ],
      }),
    });
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        message: "OpenCode upstream returned an invalid response.",
        type: "api_error",
        param: null,
        code: "invalid_response",
      },
    });

    const [requestLog] = getRequestLogs(logs);
    expect(requestLog?.extra).toEqual({
      method: "POST",
      route: "/v1/chat/completions",
      status: 502,
      failureReason: "invalid_response",
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
