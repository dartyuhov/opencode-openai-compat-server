import { afterEach, describe, expect, test } from "bun:test";

import { OpenCodeUpstreamClient, UpstreamClientError, isUpstreamClientError } from "../src/index.js";

const activeServers: Bun.Server<undefined>[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const registerServer = (fetchHandler: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: fetchHandler,
  });

  activeServers.push(server);
  return server;
};

const buildBaseUrl = (server: Bun.Server<undefined>) => `http://127.0.0.1:${server.port}`;

const getRejectedUpstreamError = async (promise: Promise<unknown>): Promise<UpstreamClientError> => {
  try {
    await promise;
    throw new Error("Expected promise to reject.");
  } catch (error) {
    if (!isUpstreamClientError(error)) {
      throw error;
    }

    return error;
  }
};

afterEach(async () => {
  const servers = activeServers.splice(0);
  await Promise.all(servers.map((server) => server.stop(true).catch(() => undefined)));
});

describe("OpenCodeUpstreamClient", () => {
  test("fetches providers with basic auth and refreshes the cache after expiry", async () => {
    let providerRequestCount = 0;
    const observedAuthHeaders: Array<string | null> = [];
    const observedDirectories: Array<string | null> = [];

    const server = registerServer((request) => {
      const url = new URL(request.url);

      if (url.pathname !== "/provider") {
        return new Response("Not found", { status: 404 });
      }

      providerRequestCount += 1;
      observedAuthHeaders.push(request.headers.get("authorization"));
      observedDirectories.push(url.searchParams.get("directory"));

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
                name: providerRequestCount === 1 ? "GPT 5.1" : "GPT 5.1 refreshed",
                release_date: "2026-01-01",
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                cost: {
                  input: 1,
                  output: 2,
                  cache_read: 0.1,
                  cache_write: 0.2,
                },
                limit: {
                  context: 200000,
                  output: 16384,
                },
                modalities: {
                  input: ["text"],
                  output: ["text"],
                },
                options: {},
              },
            },
          },
          {
            id: "anthropic",
            name: "Anthropic",
            env: ["ANTHROPIC_API_KEY"],
            models: {},
          },
        ],
        default: {
          openai: "gpt-5.1",
        },
        connected: ["openai"],
      });
    });

    const client = new OpenCodeUpstreamClient({
      baseUrl: `http://scott:tiger@127.0.0.1:${server.port}`,
      requestTimeoutMs: 500,
      modelsCacheTtlMs: 40,
      directory: "/workspace/demo",
    });

    const firstCatalog = await client.getProviderCatalog();
    const secondCatalog = await client.getProviderCatalog();
    await sleep(60);
    const refreshedCatalog = await client.getProviderCatalog();

    expect(providerRequestCount).toBe(2);
    expect(firstCatalog).toBe(secondCatalog);
    expect(refreshedCatalog).not.toBe(firstCatalog);
    expect(refreshedCatalog.providers[0]?.models[0]?.name).toBe("GPT 5.1 refreshed");
    expect(firstCatalog.providers[0]).toEqual({
      id: "openai",
      name: "OpenAI",
      api: "chat",
      env: ["OPENAI_API_KEY"],
      npm: null,
      connected: true,
      defaultModelId: "gpt-5.1",
      models: [
        {
          id: "gpt-5.1",
          name: "GPT 5.1",
          releaseDate: "2026-01-01",
          attachment: true,
          reasoning: true,
          temperature: true,
          toolCall: true,
          limit: {
            context: 200000,
            output: 16384,
          },
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0.1,
            cacheWrite: 0.2,
            contextOver200k: null,
          },
          modalities: {
            input: ["text"],
            output: ["text"],
          },
          experimental: false,
          status: null,
          options: {},
          headers: {},
          providerPackageName: null,
        },
      ],
    });
    expect(observedAuthHeaders).toEqual([
      `Basic ${Buffer.from("scott:tiger").toString("base64")}`,
      `Basic ${Buffer.from("scott:tiger").toString("base64")}`,
    ]);
    expect(observedDirectories).toEqual(["/workspace/demo", "/workspace/demo"]);
  });

  test("parses the current OpenCode provider schema with capabilities metadata", async () => {
    const server = registerServer((request) => {
      const url = new URL(request.url);

      if (url.pathname !== "/provider") {
        return new Response("Not found", { status: 404 });
      }

      return Response.json({
        all: [
          {
            id: "opencode",
            name: "OpenCode",
            source: "api",
            env: ["OPENCODE_API_KEY"],
            key: "provider-key",
            options: {},
            models: {
              "big-pickle": {
                id: "big-pickle",
                providerID: "opencode",
                name: "Big Pickle",
                family: "pickle",
                api: {
                  id: "big-pickle",
                  url: "https://opencode.ai/zen/v1",
                  npm: "@ai-sdk/openai-compatible",
                },
                status: "active",
                headers: {},
                options: {},
                cost: {
                  input: 0,
                  output: 0,
                  cache: {
                    read: 0,
                    write: 0,
                  },
                },
                limit: {
                  context: 1_000_000,
                  input: 256_000,
                  output: 128_000,
                },
                capabilities: {
                  temperature: true,
                  reasoning: true,
                  attachment: false,
                  toolcall: true,
                  input: {
                    text: true,
                    audio: false,
                    image: false,
                    video: false,
                    pdf: false,
                  },
                  output: {
                    text: true,
                    audio: false,
                    image: false,
                    video: false,
                    pdf: false,
                  },
                  interleaved: {
                    field: "reasoning_content",
                  },
                },
                release_date: "2026-03-11",
                variants: {
                  low: {
                    reasoningEffort: "low",
                  },
                },
              },
            },
          },
        ],
        default: {
          opencode: "big-pickle",
        },
        connected: ["opencode"],
      });
    });

    const client = new OpenCodeUpstreamClient({
      baseUrl: buildBaseUrl(server),
      requestTimeoutMs: 500,
      modelsCacheTtlMs: 100,
    });

    const catalog = await client.getProviderCatalog();

    expect(catalog.providers).toEqual([
      {
        id: "opencode",
        name: "OpenCode",
        api: null,
        env: ["OPENCODE_API_KEY"],
        npm: null,
        connected: true,
        defaultModelId: "big-pickle",
        models: [
          {
            id: "big-pickle",
            name: "Big Pickle",
            releaseDate: "2026-03-11",
            attachment: false,
            reasoning: true,
            temperature: true,
            toolCall: true,
            limit: {
              context: 1_000_000,
              output: 128_000,
            },
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              contextOver200k: null,
            },
            modalities: {
              input: ["text"],
              output: ["text"],
            },
            experimental: false,
            status: "active",
            options: {},
            headers: {},
            providerPackageName: "@ai-sdk/openai-compatible",
          },
        ],
      },
    ]);
  });

  test("ignores malformed model payloads from disconnected providers", async () => {
    const server = registerServer((request) => {
      const url = new URL(request.url);

      if (url.pathname !== "/provider") {
        return new Response("Not found", { status: 404 });
      }

      return Response.json({
        all: [
          {
            id: "openai",
            name: "OpenAI",
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
            id: "disconnected-provider",
            name: "Disconnected",
            env: [],
            models: {
              broken: {
                unexpected: true,
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

    const client = new OpenCodeUpstreamClient({
      baseUrl: buildBaseUrl(server),
      requestTimeoutMs: 500,
      modelsCacheTtlMs: 100,
    });

    const catalog = await client.getProviderCatalog();

    expect(catalog.providers).toHaveLength(2);
    expect(catalog.providers[0]?.connected).toBe(true);
    expect(catalog.providers[0]?.models).toHaveLength(1);
    expect(catalog.providers[1]).toEqual({
      id: "disconnected-provider",
      name: "Disconnected",
      api: null,
      env: [],
      npm: null,
      connected: false,
      defaultModelId: null,
      models: [],
    });
  });

  test("creates sessions and normalizes assistant message text", async () => {
    let createSessionBody: unknown;
    let createMessageBody: unknown;

    const server = registerServer(async (request) => {
      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/session") {
        expect(url.searchParams.get("directory")).toBe("/workspace/demo");
        createSessionBody = await request.json();

        return Response.json({
          id: "session-123",
          projectID: "project-1",
          directory: "/workspace/demo",
          title: "OpenAI chat request",
          version: "1",
          time: {
            created: 1700000000,
            updated: 1700000001,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/session/session-123/message") {
        expect(url.searchParams.get("directory")).toBe("/workspace/demo");
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
              text: " ignored",
              ignored: true,
            },
            {
              id: "part-4",
              sessionID: "session-123",
              messageID: "message-1",
              type: "text",
              text: " world",
            },
            {
              id: "part-5",
              sessionID: "session-123",
              messageID: "message-1",
              type: "file",
              mime: "text/plain",
              url: "file:///tmp/output.txt",
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const client = new OpenCodeUpstreamClient({
      baseUrl: buildBaseUrl(server),
      requestTimeoutMs: 500,
      modelsCacheTtlMs: 100,
      directory: "/workspace/demo",
    });

    const session = await client.createSession({
      title: "OpenAI chat request",
    });
    const assistantMessage = await client.createAssistantMessage({
      sessionId: "session-123",
      providerId: "openai",
      modelId: "gpt-5.1",
      agent: "build",
      system: "You are concise.",
      prompt: "Say hello in one sentence.",
    });

    expect(session).toEqual({
      id: "session-123",
      projectId: "project-1",
      directory: "/workspace/demo",
      parentId: null,
      title: "OpenAI chat request",
      version: "1",
      shareUrl: null,
      createdAt: 1700000000,
      updatedAt: 1700000001,
      compactingAt: null,
    });
    expect(createSessionBody).toEqual({
      title: "OpenAI chat request",
    });
    expect(createMessageBody).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.1",
      },
      agent: "build",
      system: "You are concise.",
      parts: [
        {
          type: "text",
          text: "Say hello in one sentence.",
        },
      ],
    });
    expect(assistantMessage.text).toBe("Hello world");
    expect(assistantMessage.parts).toHaveLength(5);
    expect(assistantMessage.parts[0]).toMatchObject({
      id: "part-1",
      type: "reasoning",
    });
    expect(assistantMessage.parts[1]).toEqual({
      id: "part-2",
      type: "text",
      text: "Hello",
      ignored: false,
      synthetic: false,
    });
    expect(assistantMessage).toMatchObject({
      id: "message-1",
      sessionId: "session-123",
      parentId: "message-0",
      providerId: "openai",
      modelId: "gpt-5.1",
      role: "assistant",
      mode: "chat",
      finish: "stop",
      createdAt: 1700000002,
      completedAt: 1700000003,
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
    });
  });

  test("converts network failures into sanitized internal errors", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ ok: true });
      },
    });
    const port = server.port;

    await server.stop(true);

    const client = new OpenCodeUpstreamClient({
      baseUrl: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 500,
      modelsCacheTtlMs: 100,
    });

    const error = await getRejectedUpstreamError(client.getProviderCatalog());

    expect(error).toMatchObject({
      name: "UpstreamClientError",
      code: "network",
      message: "OpenCode upstream is unreachable.",
      status: 502,
      retryable: true,
      endpoint: "/provider",
      sourceStatus: null,
    });
  });

  test("converts timeouts into sanitized internal errors", async () => {
    const server = registerServer(async () => {
      await sleep(60);

      return Response.json({
        all: [],
        default: {},
        connected: [],
      });
    });

    const client = new OpenCodeUpstreamClient({
      baseUrl: `http://user:secret@127.0.0.1:${server.port}`,
      requestTimeoutMs: 10,
      modelsCacheTtlMs: 100,
    });

    const error = await getRejectedUpstreamError(client.getProviderCatalog());

    expect(error).toMatchObject({
      name: "UpstreamClientError",
      code: "timeout",
      message: "OpenCode upstream request timed out.",
      status: 502,
      retryable: true,
      endpoint: "/provider",
      sourceStatus: null,
    });
    expect((error as Error).message).not.toContain("user");
    expect((error as Error).message).not.toContain("secret");
  });

  test("converts auth failures into sanitized internal errors", async () => {
    const server = registerServer(() =>
      new Response(
        JSON.stringify({
          message: "Authentication failed for user=wrong password=secret",
          stack: "Sensitive upstream stack",
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const client = new OpenCodeUpstreamClient({
      baseUrl: `http://wrong:secret@127.0.0.1:${server.port}`,
      requestTimeoutMs: 500,
      modelsCacheTtlMs: 100,
    });

    const error = await getRejectedUpstreamError(client.getProviderCatalog());

    expect(error).toMatchObject({
      name: "UpstreamClientError",
      code: "auth",
      message: "OpenCode upstream rejected authentication.",
      status: 502,
      retryable: false,
      endpoint: "/provider",
      sourceStatus: 401,
    });
    expect((error as Error).message).not.toContain("wrong");
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("Sensitive upstream stack");
  });

  test("normalizes assistant payload errors without leaking upstream details", async () => {
    const server = registerServer(() =>
      Response.json({
        info: {
          error: {
            name: "ProviderAuthError",
            data: {
              providerID: "openai",
              message: "credential secret should not leak",
            },
          },
        },
        parts: [],
      }),
    );

    const client = new OpenCodeUpstreamClient({
      baseUrl: buildBaseUrl(server),
      requestTimeoutMs: 500,
      modelsCacheTtlMs: 100,
    });

    const error = await getRejectedUpstreamError(
      client.createAssistantMessage({
        sessionId: "session-123",
        providerId: "openai",
        modelId: "gpt-5.1",
        prompt: "Say hello.",
      }),
    );

    expect(error).toMatchObject({
      name: "UpstreamClientError",
      code: "auth",
      message: "OpenCode upstream rejected authentication.",
      status: 502,
      retryable: false,
      endpoint: "/session/session-123/message",
      sourceStatus: 401,
      upstreamErrorName: "ProviderAuthError",
    });
    expect(error.message).not.toContain("secret");
  });
});
