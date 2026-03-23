import { startSidecarOnce, resetSidecarForTests, PLUGIN_PACKAGE_NAME } from "../src/index.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const serverHostname = process.env.OPENCODE_SERVER_HOSTNAME ?? "127.0.0.1";
const serverPort = Number(process.env.OPENCODE_SERVER_PORT ?? "4096");
const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
const startupTimeoutMs = Number(process.env.OPENCODE_SERVE_STARTUP_TIMEOUT_MS ?? "15000");

const log = (level: LogLevel, message: string, extra?: Record<string, unknown>) => {
  const details = extra ? ` ${JSON.stringify(extra)}` : "";
  const line = `[${PLUGIN_PACKAGE_NAME}] ${level.toUpperCase()} ${message}${details}`;
  if (level === "error" || level === "warn") {
    console.error(line);
    return;
  }

  console.log(line);
};

const client = {
  app: {
    log: async (options?: { body?: { level?: LogLevel; message?: string; extra?: Record<string, unknown> } }) => {
      const body = options?.body;
      if (body?.message) {
        log(body.level ?? "info", body.message, body.extra);
      }

      return { data: true };
    },
  },
} as never;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForUpstream = async (url: URL) => {
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/global/health", url));
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling until timeout
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for OpenCode server at ${url.origin}.`);
};

const child = Bun.spawn(
  [opencodeBin, "serve", "--hostname", serverHostname, "--port", String(serverPort), "--print-logs"],
  {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  },
);

const upstreamUrl = new URL(`http://${serverHostname}:${serverPort}`);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log("info", `Shutting down wrapper after ${signal}.`);
  child.kill();
  await resetSidecarForTests().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await waitForUpstream(upstreamUrl);
  await startSidecarOnce({
    client,
    upstreamUrl,
  });

  log("info", "OpenCode serve wrapper is ready.", {
    upstream: upstreamUrl.origin,
    sidecarPort: process.env.OPENCODE_OPENAI_COMPAT_PORT ?? "4097",
  });

  const exitCode = await child.exited;
  await resetSidecarForTests().catch(() => undefined);
  process.exit(exitCode);
} catch (error) {
  log("error", error instanceof Error ? error.message : String(error));
  child.kill();
  await resetSidecarForTests().catch(() => undefined);
  process.exit(1);
}
