# opencode-openai-compat

`opencode-openai-compat` is an OpenCode plugin package that starts a localhost sidecar exposing a small OpenAI-compatible API:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

The sidecar talks to a real OpenCode instance instead of patching OpenCode’s built-in router.

## Build And Test

```bash
bun install
bun run typecheck
bun test
bun run build
bun run test:e2e:real
```

`bun run test:e2e:real` now performs two checks:

1. Packaging smoke validation for the built `dist/` export.
2. A live verification run against a real OpenCode server.

## Real OpenCode Verification

### Prerequisites

- `opencode` is installed and available on `PATH`, or you already have a reachable OpenCode server URL.
- At least one OpenCode provider is connected for the positive-path chat request.
- Run `bun run build` first so the verifier exercises the packaged plugin export from `dist/`.

### Default Helper Flow

```bash
bun run test:e2e:real
```

When `OPENCODE_REAL_UPSTREAM_URL` is not set, the helper:

1. Starts a real `opencode serve` process on `127.0.0.1`.
2. Loads the built plugin export from `dist/index.js`.
3. Waits for the sidecar `GET /health` response to show the upstream is reachable.
4. Calls `GET /v1/models` and selects a connected model.
5. Sends a real non-streaming `POST /v1/chat/completions`.
6. Restarts the sidecar against an unreachable upstream and verifies the readable failure path.

### Useful Overrides

- `OPENCODE_REAL_UPSTREAM_URL`
  Connect to an already-running OpenCode server instead of auto-starting one.
- `OPENCODE_REAL_MODEL`
  Force a specific model returned by `GET /v1/models`, for example `opencode/big-pickle`.
- `OPENCODE_REAL_TIMEOUT_MS`
  Increase the helper timeout for slower providers.
- `OPENCODE_REAL_NEGATIVE_UPSTREAM_URL`
  Override the unreachable-upstream target used for the negative-path verification.

Example using an existing OpenCode server:

```bash
OPENCODE_REAL_UPSTREAM_URL=http://127.0.0.1:43111 \
OPENCODE_REAL_MODEL=opencode/big-pickle \
bun run test:e2e:real
```

### Manual Curl Flow

If you have already installed this plugin into OpenCode, the sidecar defaults to `http://127.0.0.1:4097`.

Check health:

```bash
curl -s http://127.0.0.1:4097/health | jq
```

Expected shape:

```json
{
  "object": "opencode.sidecar.health",
  "status": "ok",
  "sidecar": {
    "healthy": true
  },
  "upstream": {
    "configured": true,
    "reachable": true,
    "status": "reachable"
  }
}
```

List connected models:

```bash
curl -s http://127.0.0.1:4097/v1/models | jq '.data[0:5]'
```

Expected shape:

```json
[
  {
    "id": "opencode/big-pickle",
    "object": "model",
    "created": 1773187200,
    "owned_by": "opencode"
  }
]
```

Send a non-streaming chat request using a model returned by `GET /v1/models`:

```bash
curl -s http://127.0.0.1:4097/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [
      { "role": "system", "content": "You are concise." },
      { "role": "user", "content": "Reply with exactly REAL_E2E_OK and nothing else." }
    ]
  }' | jq
```

Expected shape:

```json
{
  "object": "chat.completion",
  "model": "opencode/big-pickle",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "REAL_E2E_OK"
      }
    }
  ]
}
```

### Negative Case

Stop the upstream OpenCode server, or point the helper at an unreachable URL:

```bash
OPENCODE_REAL_NEGATIVE_UPSTREAM_URL=http://127.0.0.1:65530 \
bun run test:e2e:real
```

The expected negative-path behavior is:

- `GET /health` returns `status: "degraded"` with `upstream.reachable: false`.
- `GET /v1/models` returns a readable `502` error envelope instead of advertising stale or fake models.
- `POST /v1/chat/completions` returns a readable `502` error envelope instead of a fabricated assistant response.

Example negative `GET /v1/models` output:

```json
{
  "error": {
    "message": "OpenCode upstream is unreachable.",
    "type": "api_error",
    "code": "network"
  }
}
```
