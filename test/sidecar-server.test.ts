import { afterEach, describe, expect, test } from "bun:test";

import { PLUGIN_PACKAGE_NAME, resetSidecarForTests, startSidecarOnce } from "../src/index.js";

type LogEntry = {
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  extra?: Record<string, unknown>;
};

const activeServers: Bun.Server<undefined>[] = [];

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

const startTestSidecar = async (logs: LogEntry[], input?: { apiKey?: string | null; upstreamUrl?: string }) => {
  const runtime = await startSidecarOnce({
    client: createFakeClient(logs),
    rawConfig: {
      host: "127.0.0.1",
      port: 0,
      ...(input?.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
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
