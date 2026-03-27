import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndexPath = path.join(rootDir, "dist", "index.js");
const distTypesPath = path.join(rootDir, "dist", "index.d.ts");
const pollIntervalMs = 250;
const defaultTimeoutMs = Number(process.env.OPENCODE_REAL_TIMEOUT_MS ?? "120000");

type SidecarRuntime = {
  config: {
    host: string;
    port: number;
  };
  server: {
    hostname?: string;
    port?: number;
  };
};

type BuiltPluginModule = {
  OpenCodeOpenAICompatPlugin?: Plugin;
  DEFAULT_PLUGIN_CONFIG?: Record<string, unknown>;
  getSidecarRuntimeForTests?: () => SidecarRuntime | null;
  resetSidecarForTests?: () => Promise<void>;
};

type BuiltPluginHooks = Awaited<ReturnType<Plugin>>;

type AutoStartedUpstream = {
  upstreamUrl: URL;
  child: ChildProcess;
  dispose: () => Promise<void>;
};

const run = (command: string[], description: string) => {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? "unknown"}.`);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const sanitizeUrl = (value: string | URL) => {
  const parsed = typeof value === "string" ? new URL(value) : new URL(value.href);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const reservePort = async () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a local port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });

const applySidecarEnv = () => {
  process.env.OPENCODE_OPENAI_COMPAT_ENABLED = "true";
  process.env.OPENCODE_OPENAI_COMPAT_HOST = "127.0.0.1";
  process.env.OPENCODE_OPENAI_COMPAT_PORT = process.env.OPENCODE_REAL_SIDECAR_PORT ?? "0";
  process.env.OPENCODE_OPENAI_COMPAT_REQUEST_TIMEOUT_MS = String(defaultTimeoutMs);
  process.env.OPENCODE_OPENAI_COMPAT_MODELS_CACHE_TTL_MS = "1000";
};

const triggerServeModePluginStartup = async (plugin: BuiltPluginHooks) => {
  const eventHook = plugin?.event;
  ensure(typeof eventHook === "function", "Built package did not return a valid OpenCode plugin event hook.");

  const originalArgv = process.argv;

  try {
    process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "opencode", "serve"];
    await eventHook({
      event: {
        type: "server.connected",
        properties: {},
      },
    } as Parameters<typeof eventHook>[0]);
  } finally {
    process.argv = originalArgv;
  }
};

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const bodyText = await response.text();
  let body: unknown;

  try {
    body = bodyText.length === 0 ? null : JSON.parse(bodyText);
  } catch {
    throw new Error(`Expected JSON from ${url} but received: ${bodyText.slice(0, 200)}`);
  }

  return {
    response,
    body,
  };
};

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

const fetchEventStream = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const bodyText = await response.text();

  return {
    response,
    events: parseServerSentEvents(bodyText),
  };
};

const waitForHealth = async (
  sidecarBaseUrl: string,
  options: {
    timeoutMs: number;
    expectReachable: boolean;
  },
) => {
  const deadline = Date.now() + options.timeoutMs;
  let lastBody: unknown = null;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const { response, body } = await fetchJson(`${sidecarBaseUrl}/health`);
      lastBody = body;

      if (
        response.status === 200 &&
        typeof body === "object" &&
        body !== null &&
        (body as { sidecar?: { healthy?: boolean } }).sidecar?.healthy === true &&
        (body as { upstream?: { reachable?: boolean | null } }).upstream?.reachable === options.expectReachable
      ) {
        return body as {
          status: string;
          upstream: {
            reachable: boolean | null;
            status: string;
          };
        };
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(pollIntervalMs);
  }

  const lastContext =
    lastBody != null
      ? `Last body: ${JSON.stringify(lastBody)}`
      : lastError instanceof Error
        ? `Last error: ${lastError.message}`
        : "No health response received.";

  throw new Error(
    `Timed out waiting for sidecar health at ${sidecarBaseUrl} (expected upstream reachable=${String(options.expectReachable)}). ${lastContext}`,
  );
};

const pickModel = (
  models: Array<{
    id: string;
  }>,
) => {
  const explicitModel = process.env.OPENCODE_REAL_MODEL?.trim();

  if (explicitModel) {
    const matched = models.find((entry) => entry.id === explicitModel);
    if (!matched) {
      throw new Error(`OPENCODE_REAL_MODEL=${explicitModel} was not returned by GET /v1/models.`);
    }

    return matched.id;
  }

  const candidates = models.filter((entry) => entry.id.split("/").length === 2);
  if (candidates.length === 0) {
    throw new Error("GET /v1/models returned no `provider/model` identifiers that can be used for chat verification.");
  }

  const providerPreference = ["opencode", "openai", "anthropic", "google", "github-copilot"];
  for (const providerId of providerPreference) {
    const matched = candidates.find((entry) => entry.id.startsWith(`${providerId}/`));
    if (matched) {
      return matched.id;
    }
  }

  return candidates[0]!.id;
};

const startAutoUpstream = async (): Promise<AutoStartedUpstream> => {
  const port = await reservePort();
  const command = process.env.OPENCODE_REAL_OPENCODE_BIN?.trim() || "opencode";
  const childEnv = { ...process.env };

  delete childEnv.OPENCODE_SERVER_PASSWORD;

  const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: rootDir,
    env: childEnv,
    stdio: "ignore",
  });

  const upstreamUrl = new URL(`http://127.0.0.1:${port}`);
  const deadline = Date.now() + defaultTimeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Auto-started OpenCode server exited early with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(`${upstreamUrl.toString()}/provider`);
      if (response.ok) {
        return {
          upstreamUrl,
          child,
          dispose: async () => {
            try {
              await fetch(`${upstreamUrl.toString()}/global/dispose`, {
                method: "POST",
              });
            } catch {
              // Fall back to process termination below.
            }

            for (let attempt = 0; attempt < 20; attempt += 1) {
              try {
                await fetch(`${upstreamUrl.toString()}/global/health`);
              } catch {
                return;
              }

              await sleep(100);
            }

            if (child.exitCode === null) {
              child.kill("SIGTERM");
              await sleep(250);
            }

            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          },
        };
      }
    } catch {
      // Wait for the server to come up.
    }

    await sleep(pollIntervalMs);
  }

  child.kill("SIGKILL");
  throw new Error(`Timed out waiting for auto-started OpenCode server at ${sanitizeUrl(upstreamUrl)}.`);
};

const verifyPackagedBuild = async (): Promise<BuiltPluginModule> => {
  if (!existsSync(distIndexPath) || !existsSync(distTypesPath)) {
    run([process.execPath, "run", "build"], "Build prerequisite");
  }

  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
  });

  if (packed.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${packed.stderr}`);
  }

  const [packResult] = JSON.parse(packed.stdout) as Array<{
    files: Array<{
      path: string;
    }>;
  }>;

  const packagedFiles = new Set(packResult.files.map((file) => file.path));
  for (const requiredFile of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
    if (!packagedFiles.has(requiredFile)) {
      throw new Error(`Expected ${requiredFile} to be included in the published package.`);
    }
  }

  const builtPlugin = (await import(pathToFileURL(distIndexPath).href)) as BuiltPluginModule;

  if (typeof builtPlugin.OpenCodeOpenAICompatPlugin !== "function") {
    throw new Error("Built package is missing the OpenCodeOpenAICompatPlugin export.");
  }

  if (builtPlugin.DEFAULT_PLUGIN_CONFIG?.host !== "127.0.0.1") {
    throw new Error("Built package is missing the declared default host configuration.");
  }

  if (builtPlugin.DEFAULT_PLUGIN_CONFIG?.port !== 4097) {
    throw new Error("Built package is missing the declared default port configuration.");
  }

  if (typeof builtPlugin.getSidecarRuntimeForTests !== "function" || typeof builtPlugin.resetSidecarForTests !== "function") {
    throw new Error("Built package is missing the sidecar test helpers required for live verification.");
  }

  console.log("Packaging smoke validation passed.");
  return builtPlugin;
};

const startBuiltPluginSidecar = async (builtPlugin: BuiltPluginModule, upstreamUrl: URL) => {
  applySidecarEnv();
  const resetSidecar = builtPlugin.resetSidecarForTests;
  ensure(typeof resetSidecar === "function", "Built package is missing the sidecar reset helper.");
  await resetSidecar();

  const pluginFactory = builtPlugin.OpenCodeOpenAICompatPlugin;
  ensure(typeof pluginFactory === "function", "Built package is missing the OpenCodeOpenAICompatPlugin export.");

  const plugin = await pluginFactory({
    client: {
      app: {
        log: async () => ({ data: true }),
      },
    } as unknown as Parameters<typeof pluginFactory>[0]["client"],
    serverUrl: upstreamUrl,
    project: {
      id: "real-e2e",
      name: "real-e2e",
    },
    directory: rootDir,
    worktree: rootDir,
    $: ((..._args: unknown[]) => {
      throw new Error("The real verifier should not invoke the OpenCode shell helper.");
    }) as unknown as Parameters<typeof pluginFactory>[0]["$"],
  } as unknown as Parameters<typeof pluginFactory>[0]);

  await triggerServeModePluginStartup(plugin);

  const getRuntime = builtPlugin.getSidecarRuntimeForTests;
  ensure(typeof getRuntime === "function", "Built package is missing the sidecar runtime helper.");
  const runtime = getRuntime();
  ensure(runtime, "Built plugin did not start the sidecar.");
  ensure(typeof runtime.server.port === "number", "Started sidecar did not expose a listening port.");

  const sidecarBaseUrl = `http://127.0.0.1:${runtime.server.port}`;
  return {
    runtime,
    sidecarBaseUrl,
  };
};

const verifyPositiveFlow = async (builtPlugin: BuiltPluginModule, upstreamUrl: URL) => {
  const { sidecarBaseUrl } = await startBuiltPluginSidecar(builtPlugin, upstreamUrl);
  const health = await waitForHealth(sidecarBaseUrl, {
    timeoutMs: defaultTimeoutMs,
    expectReachable: true,
  });

  console.log(`Sidecar health check passed via ${sidecarBaseUrl}/health (${health.status}).`);

  const { response: modelsResponse, body: modelsBody } = await fetchJson(`${sidecarBaseUrl}/v1/models`);
  ensure(modelsResponse.status === 200, `Expected GET /v1/models to return 200, received ${modelsResponse.status}.`);
  ensure(
    typeof modelsBody === "object" && modelsBody !== null && Array.isArray((modelsBody as { data?: unknown[] }).data),
    "GET /v1/models did not return an OpenAI-compatible model list.",
  );

  const models = (modelsBody as { data: Array<{ id: string }> }).data;
  ensure(models.length > 0, "GET /v1/models returned no connected models. Configure at least one OpenCode provider before running the real verifier.");

  const selectedModel = pickModel(models);
  console.log(`Selected model for live chat verification: ${selectedModel}`);

  const { response: chatResponse, body: chatBody } = await fetchJson(`${sidecarBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        {
          role: "system",
          content: "You are concise.",
        },
        {
          role: "user",
          content: "Reply with exactly REAL_E2E_OK and nothing else.",
        },
      ],
    }),
  });

  ensure(chatResponse.status === 200, `Expected POST /v1/chat/completions to return 200, received ${chatResponse.status}.`);
  ensure(typeof chatBody === "object" && chatBody !== null, "POST /v1/chat/completions did not return a JSON object.");

  const completion = chatBody as {
    object?: string;
    model?: string;
    choices?: Array<{
      message?: {
        role?: string;
        content?: string;
      };
    }>;
  };

  ensure(completion.object === "chat.completion", "Live chat completion response used an unexpected object type.");
  ensure(completion.model === selectedModel, "Live chat completion response reported the wrong model.");
  ensure(Array.isArray(completion.choices) && completion.choices.length > 0, "Live chat completion response did not include any choices.");
  const firstChoice = completion.choices[0];
  ensure(firstChoice?.message?.role === "assistant", "Live chat completion did not return an assistant message.");
  const assistantContent = firstChoice.message.content;
  ensure(typeof assistantContent === "string" && assistantContent.trim().length > 0, "Live chat completion returned empty assistant content.");

  console.log(`Live chat verification passed with assistant content: ${assistantContent.trim()}`);

  const { response: streamResponse, events: streamEvents } = await fetchEventStream(`${sidecarBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: selectedModel,
      stream: true,
      messages: [
        {
          role: "system",
          content: "You are concise.",
        },
        {
          role: "user",
          content: "Reply with exactly REAL_STREAM_E2E_OK and nothing else.",
        },
      ],
    }),
  });

  ensure(streamResponse.status === 200, `Expected streaming POST /v1/chat/completions to return 200, received ${streamResponse.status}.`);
  ensure(
    streamResponse.headers.get("content-type")?.includes("text/event-stream") === true,
    "Streaming POST /v1/chat/completions did not return an event-stream content type.",
  );
  ensure(streamEvents.length >= 3, "Streaming POST /v1/chat/completions returned too few SSE events.");
  ensure(streamEvents[streamEvents.length - 1] === "[DONE]", "Streaming POST /v1/chat/completions did not terminate with [DONE].");

  const streamedPayloads = streamEvents.filter(
    (event): event is Record<string, unknown> => typeof event === "object" && event !== null,
  );
  ensure(streamedPayloads.length >= 2, "Streaming POST /v1/chat/completions did not return JSON chunk payloads.");

  const streamedAssistantContent = streamedPayloads
    .flatMap((payload) => {
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      return choices.map((choice) => {
        if (typeof choice !== "object" || choice === null) {
          return "";
        }

        const delta = (choice as { delta?: { content?: unknown } }).delta;
        return typeof delta?.content === "string" ? delta.content : "";
      });
    })
    .join("");
  ensure(
    streamedAssistantContent.trim().length > 0,
    "Streaming POST /v1/chat/completions returned no assistant text deltas.",
  );
  ensure(
    streamedAssistantContent.trim() === "REAL_STREAM_E2E_OK",
    `Streaming POST /v1/chat/completions returned unexpected assistant content: ${streamedAssistantContent.trim()}`,
  );

  console.log(`Live streaming verification passed with assistant content: ${streamedAssistantContent.trim()}`);
  return {
    selectedModel,
  };
};

const verifyNegativeFlow = async (builtPlugin: BuiltPluginModule, selectedModel: string) => {
  const negativeUpstreamUrl =
    process.env.OPENCODE_REAL_NEGATIVE_UPSTREAM_URL?.trim() ?? `http://127.0.0.1:${await reservePort()}`;
  const { sidecarBaseUrl } = await startBuiltPluginSidecar(builtPlugin, new URL(negativeUpstreamUrl));
  const health = await waitForHealth(sidecarBaseUrl, {
    timeoutMs: defaultTimeoutMs,
    expectReachable: false,
  });

  ensure(health.status === "degraded", `Expected negative health status to be degraded, received ${health.status}.`);

  const { response: modelsResponse, body: modelsBody } = await fetchJson(`${sidecarBaseUrl}/v1/models`);
  ensure(modelsResponse.status === 502, `Expected negative GET /v1/models to return 502, received ${modelsResponse.status}.`);
  ensure(
    typeof modelsBody === "object" &&
      modelsBody !== null &&
      typeof (modelsBody as { error?: { message?: unknown; type?: unknown } }).error?.message === "string" &&
      (modelsBody as { error?: { type?: unknown } }).error?.type === "api_error" &&
      !Array.isArray((modelsBody as { data?: unknown[] }).data),
    "Negative GET /v1/models did not return a readable API error without fake model data.",
  );

  const { response: chatResponse, body: chatBody } = await fetchJson(`${sidecarBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        {
          role: "user",
          content: "Reply with exactly REAL_E2E_OK and nothing else.",
        },
      ],
    }),
  });

  ensure(chatResponse.status === 502, `Expected negative POST /v1/chat/completions to return 502, received ${chatResponse.status}.`);
  ensure(
    typeof chatBody === "object" &&
      chatBody !== null &&
      typeof (chatBody as { error?: { message?: unknown; type?: unknown } }).error?.message === "string" &&
      (chatBody as { error?: { type?: unknown } }).error?.type === "api_error" &&
      !Array.isArray((chatBody as { choices?: unknown[] }).choices),
    "Negative POST /v1/chat/completions did not return a readable API error.",
  );

  console.log(`Negative-path verification passed against ${sanitizeUrl(negativeUpstreamUrl)}.`);
};

const main = async () => {
  const builtPlugin = await verifyPackagedBuild();
  const configuredUpstream = process.env.OPENCODE_REAL_UPSTREAM_URL?.trim();
  const upstream = configuredUpstream
    ? {
        upstreamUrl: new URL(configuredUpstream),
        child: null,
        dispose: async () => undefined,
      }
    : await startAutoUpstream();

  try {
    console.log(`Using OpenCode upstream ${sanitizeUrl(upstream.upstreamUrl)}.`);
    const { selectedModel } = await verifyPositiveFlow(builtPlugin, upstream.upstreamUrl);
    await verifyNegativeFlow(builtPlugin, selectedModel);
    console.log("Real OpenCode end-to-end verification passed.");
  } finally {
    await builtPlugin.resetSidecarForTests?.();
    await upstream.dispose();
  }
};

await main();
