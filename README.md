# opencode-openai-compat

`opencode-openai-compat` turns a local OpenCode server into an OpenAI API-compatible server by running a small compatibility sidecar in front of it.

This repo packages that sidecar for wrapper mode, `launchd`, and plugin-based startup.

Request flow:

```text
OpenAI-compatible client
  -> localhost sidecar
  -> OpenCode server
  -> connected OpenCode provider
```

The sidecar implements only:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

It is intentionally narrow:

- chat completions are supported in regular JSON mode and streaming SSE mode with `stream: true`
- the request body accepts `model`, `messages`, optional `stream`, and optional `temperature` (accepted for client compatibility and currently ignored)
- `model` can be `provider/model` or a bare model id when it uniquely matches one connected provider
- each chat completion creates a fresh upstream OpenCode session

## Modes

This repo can be used in 3 different ways.

### Wrapper mode

This is the recommended path.

- Run `bun run serve:compat`
- The wrapper starts `opencode serve`
- It waits for the upstream OpenCode server to become healthy
- Then it starts the OpenAI-compatible sidecar

Wrapper mode does not require adding anything to `~/.config/opencode/opencode.jsonc`.

### launchd mode on macOS

This is wrapper mode managed by `launchd`.

- `launchd` starts `scripts/serve-with-sidecar.ts`
- the wrapper starts `opencode serve`
- the wrapper starts the sidecar after the upstream is healthy

### Plugin mode

This repo also ships a real OpenCode plugin export in `src/index.ts`.

- the plugin export is `OpenCodeOpenAICompatPlugin`
- it starts the sidecar on the OpenCode `server.connected` event
- it only auto-starts during `opencode serve`
- the repo-local dev shim is `.opencode/plugins/opencode-openai-compat.js`

Plugin mode is useful for local development and packaging validation, but the recommended operational path is still wrapper mode.

That is why you may not see this repo referenced in global `~/.config/opencode/opencode.jsonc`.

## Wrapper Mode Quick Start

Default ports:

- OpenCode server: `http://127.0.0.1:4096`
- OpenAI-compatible sidecar: `http://127.0.0.1:4097/v1`

### Run in a terminal

1. Install repo dependencies:

```bash
bun install
```

2. Make sure `opencode` is installed and available on `PATH`:

```bash
opencode --help
```

3. Start the wrapper:

```bash
OPENCODE_OPENAI_COMPAT_API_KEY="<YOUR TOKEN>" bun run serve:compat
```

4. Verify the upstream OpenCode server and the sidecar:

```bash
curl -s http://127.0.0.1:4096/global/health | jq
curl -s -H 'authorization: Bearer <YOUR TOKEN>' http://127.0.0.1:4097/health | jq
curl -s -H 'authorization: Bearer <YOUR TOKEN>' http://127.0.0.1:4097/v1/models | jq '.data[0:5]'
```

5. Point your OpenAI-compatible client at:

- Base URL: `http://127.0.0.1:4097/v1`
- API key: `<YOUR TOKEN>`
- Model: any exact ID returned by `GET /v1/models`

Example client settings for Handy:

- Base URL: `http://127.0.0.1:4097/v1`
- API key: `<YOUR TOKEN>`
- Model: for example `opencode/big-pickle` if that exact ID appears in `GET /v1/models`

6. If you want different ports, set them before startup:

```bash
OPENCODE_SERVER_PORT=43119 \
OPENCODE_OPENAI_COMPAT_PORT=4147 \
OPENCODE_OPENAI_COMPAT_API_KEY="<YOUR TOKEN>" \
bun run serve:compat
```

## launchd Autostart on macOS

If you want one always-on background service at login, install the `launchd` wrapper agent.

1. Build the repo:

```bash
bun run build
```

2. Install the agent:

```bash
OPENCODE_OPENAI_COMPAT_API_KEY="<YOUR TOKEN>" ./scripts/install-launchd-agent.sh
```

3. Confirm it is loaded:

```bash
launchctl list | rg 'opencode-serve-openai-compat'
```

4. Verify the sidecar:

```bash
curl -s -H 'authorization: Bearer <YOUR TOKEN>' http://127.0.0.1:4097/health | jq
```

Useful overrides when installing:

```bash
REPO_DIR="$(pwd)" \
LAUNCHD_PATH="$PATH" \
OPENCODE_SERVER_PORT=43119 \
OPENCODE_OPENAI_COMPAT_PORT=4147 \
OPENCODE_OPENAI_COMPAT_API_KEY="<YOUR TOKEN>" \
LAUNCHD_LABEL=com.user.opencode-serve-openai-compat \
./scripts/install-launchd-agent.sh
```

`launchd` starts with a minimal default `PATH`, so the installer now records the current shell `PATH` by default. That keeps local MCP tools that depend on `npx`, `docker`, or Homebrew-installed binaries available after login.

Logs are written to:

- `~/Library/Logs/opencode-openai-compat/stdout.log`
- `~/Library/Logs/opencode-openai-compat/stderr.log`

Watch logs live:

```bash
tail -f ~/Library/Logs/opencode-openai-compat/stdout.log
tail -f ~/Library/Logs/opencode-openai-compat/stderr.log
```

Remove the agent later:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.opencode-serve-openai-compat.plist
rm ~/Library/LaunchAgents/com.user.opencode-serve-openai-compat.plist
```

## Common Environment Variables

Wrapper process:

- `OPENCODE_BIN`: path to the `opencode` executable
- `OPENCODE_SERVER_HOSTNAME`: upstream OpenCode bind host, default `127.0.0.1`
- `OPENCODE_SERVER_PORT`: upstream OpenCode bind port, default `4096`

Sidecar:

- `OPENCODE_OPENAI_COMPAT_ENABLED`: enable or disable sidecar startup, default `true`
- `OPENCODE_OPENAI_COMPAT_HOST`: sidecar bind host, default `127.0.0.1`
- `OPENCODE_OPENAI_COMPAT_PORT`: sidecar bind port, default `4097`
- `OPENCODE_OPENAI_COMPAT_API_KEY`: bearer token required by the sidecar; empty means auth disabled
- `OPENCODE_OPENAI_COMPAT_DEFAULT_AGENT`: upstream agent name used for chat completions, default `build`
- `OPENCODE_OPENAI_COMPAT_REQUEST_TIMEOUT_MS`: upstream request timeout, default `30000`
- `OPENCODE_OPENAI_COMPAT_MODELS_CACHE_TTL_MS`: provider catalog cache TTL, default `5000`
- `OPENCODE_OPENAI_COMPAT_UPSTREAM_BASE_URL`: explicit upstream URL for standalone sidecar/plugin usage; wrapper mode usually does not need this

## Development

Install dependencies:

```bash
bun install
```

Run the normal verification flow:

```bash
bun run typecheck
bun test
bun run build
bun run test:e2e:real
```

`bun run test:e2e:real` performs 2 checks:

1. packaging smoke validation for the built `dist/` export
2. live verification against a real OpenCode server

## Real OpenCode Verification

Prerequisites:

- `opencode` is installed and available on `PATH`, or you already have a reachable OpenCode server URL
- at least one OpenCode provider is connected for the positive-path chat request
- run `bun run build` first so the verifier exercises the packaged plugin export from `dist/`

Default helper flow:

```bash
bun run test:e2e:real
```

When `OPENCODE_REAL_UPSTREAM_URL` is not set, the helper:

1. starts a real `opencode serve` process on `127.0.0.1`
2. loads the built plugin export from `dist/index.js`
3. triggers plugin startup in serve mode
4. waits for `GET /health` to report a reachable upstream
5. calls `GET /v1/models` and selects a connected model
6. sends real non-streaming and streaming `POST /v1/chat/completions` requests
7. restarts the sidecar against an unreachable upstream and verifies the readable failure path

Useful overrides:

- `OPENCODE_REAL_UPSTREAM_URL`: use an already-running OpenCode server instead of auto-starting one
- `OPENCODE_REAL_MODEL`: force a specific model returned by `GET /v1/models`
- `OPENCODE_REAL_TIMEOUT_MS`: increase the helper timeout for slower providers
- `OPENCODE_REAL_NEGATIVE_UPSTREAM_URL`: override the unreachable target used for the negative-path verification

Example against an existing OpenCode server:

```bash
OPENCODE_REAL_UPSTREAM_URL=http://127.0.0.1:43111 \
OPENCODE_REAL_MODEL=opencode/big-pickle \
bun run test:e2e:real
```

Expected negative-path behavior:

- `GET /health` returns `status: "degraded"` with `upstream.reachable: false`
- `GET /v1/models` returns a readable `502` error envelope instead of stale or fake model data
- `POST /v1/chat/completions` returns a readable `502` error envelope instead of a fabricated assistant response
