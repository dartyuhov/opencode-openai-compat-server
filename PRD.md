# opencode-openai-compat MVP PRD

## Overview

`opencode-openai-compat` is an installable OpenCode plugin that starts a sidecar HTTP server exposing an OpenAI-compatible API backed by a real OpenCode instance.

The plugin does not patch or extend the built-in `opencode serve` router. Instead, it uses the supported plugin lifecycle to start a separate local server and translate OpenAI-style requests into OpenCode session/message API calls.

The MVP focuses on practical compatibility for external clients by supporting:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

The MVP must work against a real OpenCode instance, not only mocks.

## Problem

OpenCode plugins cannot cleanly register new HTTP routes on the built-in OpenCode server. At the same time, many external tools expect an OpenAI-compatible interface with `/v1/models` and `/v1/chat/completions`.

Users already configure and authenticate providers inside OpenCode and want to reuse that setup without duplicating provider configuration elsewhere.

## Goals

- Install as a normal OpenCode plugin.
- Auto-start a local sidecar server when the plugin initializes.
- Expose only currently connected OpenCode providers and models.
- Return model IDs in `provider/model` form.
- Support non-streaming OpenAI-style `chat/completions` requests.
- Map responses into OpenAI-compatible JSON.
- Prove the full flow works with a real OpenCode instance in end-to-end testing.

## Non-Goals

- Extending the native `opencode serve` HTTP router.
- Monkeypatching internal OpenCode server APIs.
- Extending OpenCode's `/doc` or OpenAPI spec.
- Supporting the full OpenAI platform surface area in MVP.
- Supporting streaming responses in MVP.
- Supporting embeddings, images, audio, Assistants, Responses API, or tool-calling passthrough in MVP.

## Users

- OpenCode users who want to expose their configured models through an OpenAI-compatible endpoint.
- External tools that can talk to OpenAI-compatible APIs.
- Developers who want a local compatibility layer backed by OpenCode.

## User Stories

- As an OpenCode user, I install a plugin and get a local OpenAI-compatible endpoint.
- As a client, I can list only the models that OpenCode can actually use right now.
- As a client, I can send a standard non-streaming `chat/completions` request and receive assistant text in a familiar schema.
- As a maintainer, I can validate the plugin against a real OpenCode instance and know that compatibility is not only theoretical.

## Constraints

- Must use supported plugin behavior.
- Must not rely on internal route injection.
- Must be installable as an OpenCode plugin.
- Must be safe to run locally by default.
- Plugin lifecycle lacks a strong shutdown/dispose API, so startup must be idempotent and sidecar management defensive.

## Assumptions

- The plugin can determine the upstream OpenCode server URL from plugin context or plugin configuration.
- OpenCode exposes provider and session/message APIs over HTTP.
- OpenCode returns enough provider/model metadata to build a model listing.

## High-Level Solution

The plugin starts a sidecar HTTP server on a configurable localhost port. The sidecar translates OpenAI-style calls into OpenCode upstream API calls.

Main flow:

1. Plugin initializes.
2. Plugin starts one sidecar server.
3. Sidecar calls OpenCode `GET /provider` to discover connected models.
4. Sidecar exposes those models at `GET /v1/models`.
5. Sidecar accepts `POST /v1/chat/completions`, creates an OpenCode session, sends a message, collects assistant text parts, and returns OpenAI-compatible JSON.

## Architecture

### Plugin Layer

Responsibilities:

- parse plugin config
- derive upstream OpenCode server URL
- start sidecar server once per process
- log startup and failure details through OpenCode logging

### Sidecar Server Layer

Responsibilities:

- bind local HTTP endpoint
- expose compatibility routes
- validate client requests
- call OpenCode upstream APIs
- map responses and errors

### OpenCode Upstream Client Layer

Responsibilities:

- communicate with OpenCode APIs
- handle auth if configured
- wrap provider discovery and session/message operations
- centralize timeouts and error handling

### Mapping Layer

Responsibilities:

- convert OpenCode provider/model data into OpenAI-style models
- convert OpenAI chat requests into OpenCode message payloads
- convert OpenCode assistant parts into OpenAI chat completion responses

## Supported Endpoints

### `GET /health`

Purpose:

- basic readiness check
- useful for local testing and startup verification

Response should include:

- sidecar healthy flag
- upstream reachable flag if feasible
- version or plugin name if available

### `GET /v1/models`

Purpose:

- expose only currently connected OpenCode models

Upstream source:

- `GET /provider`

Behavior:

- read all providers and `connected` provider IDs
- include only models from connected providers
- flatten model map into OpenAI-style `data` array
- use model IDs formatted as `providerID/modelID`

Example model IDs:

- `openai/gpt-5.1`
- `anthropic/claude-sonnet-4`

### `POST /v1/chat/completions`

Purpose:

- provide the MVP OpenAI-compatible generation endpoint

Supported request fields:

- `model`
- `messages`
- `stream` only when `false` or omitted

Unsupported in MVP:

- `stream: true`
- tool calling
- multimodal message content arrays unless explicitly flattened later
- structured response format features

## Model Rules

- Only currently connected providers are exposed.
- Disconnected providers are hidden.
- Model IDs must be exact and unambiguous.
- The sidecar must not invent fake models in MVP.
- If a provider is connected but has no models, it contributes nothing to the response.

## Request Mapping

### Input Validation

- `model` is required.
- `messages` must be a non-empty array.
- `stream: true` returns a validation error in MVP.
- `model` must match a currently available `provider/model` entry.

### Model Resolution

- Split `model` into `providerID` and `modelID`.
- Verify that both exist in the current connected model set.

### Message Translation

For MVP, OpenAI messages are converted into a single OpenCode text prompt preserving role structure.

Recommended serialization format:

- optional `System:` section built from all `system` messages
- chronological conversation transcript for `user` and `assistant`
- final user turn preserved clearly at the end

This is intentionally simple and stable for MVP.

### Session Strategy

- Create a fresh OpenCode session for each request.
- Send one message into that session.
- Do not reuse sessions in MVP.

Rationale:

- keeps requests stateless
- avoids cross-request leakage
- simplifies compatibility and testing

## Response Mapping

The sidecar will parse the OpenCode assistant response and collect assistant parts of type `text`.

Response assembly rules:

- concatenate text parts in order
- ignore non-text parts in MVP
- return OpenAI-style `chat.completion` JSON

Minimum response shape:

- `id`
- `object: "chat.completion"`
- `created`
- `model`
- `choices[0].index`
- `choices[0].message.role = "assistant"`
- `choices[0].message.content`
- `choices[0].finish_reason`

If token usage is available from OpenCode and easily mappable, include it. Otherwise usage may be omitted in MVP.

## Error Handling

### Client Errors

- invalid JSON -> `400`
- missing model -> `400`
- unknown model -> `400`
- unsupported streaming -> `400`

### Upstream Errors

- OpenCode unreachable -> `502`
- upstream auth/config failure -> `502`
- upstream provider execution failure -> `502` with safe detail

### Error Response Shape

Use a consistent OpenAI-like error envelope where practical.

Example:

```json
{
  "error": {
    "message": "Model 'foo/bar' is not currently available",
    "type": "invalid_request_error"
  }
}
```

## Security

- default bind address must be `127.0.0.1`
- default port should be local-only and configurable
- optional bearer token support for sidecar clients
- upstream credentials must never be written to logs
- do not expose disconnected provider/model metadata

## Observability

Log the following through OpenCode logging when possible:

- sidecar startup success
- bind address and port
- upstream connectivity failures
- request handling failures

Do not log prompts or completions by default.

## Configuration

MVP config fields:

- `enabled`: default `true`
- `host`: default `127.0.0.1`
- `port`: default `4097`
- `apiKey`: optional bearer token for sidecar
- `upstreamBaseUrl`: optional override for OpenCode server URL
- `upstreamUsername`: optional basic auth username
- `upstreamPassword`: optional basic auth password
- `defaultAgent`: optional, default `build`
- `requestTimeoutMs`: upstream timeout
- `modelsCacheTtlMs`: short cache for model discovery

## Suggested Repo Structure

```text
src/
  index.ts
  config.ts
  errors.ts
  types/
    openai.ts
    opencode.ts
  sidecar/
    server.ts
    routes/
      health.ts
      models.ts
      chat-completions.ts
  upstream/
    opencode-client.ts
  mappers/
    models.ts
    chat-request.ts
    chat-response.ts
README.md
PRD.md
```

## Implementation Details

### Plugin Entry (`src/index.ts`)

- export the plugin function expected by OpenCode
- parse config
- ensure startup happens once per process
- construct and launch sidecar server
- report startup state through logger

### Sidecar Server (`src/sidecar/server.ts`)

- create Bun HTTP server
- attach route handlers
- inject config and upstream client into handlers
- handle auth middleware if `apiKey` is configured

### Upstream Client (`src/upstream/opencode-client.ts`)

- wrap `GET /provider`
- wrap `POST /session`
- wrap `POST /session/:id/message`
- normalize upstream response payloads and errors

### Models Mapper (`src/mappers/models.ts`)

- filter connected providers
- flatten provider model maps
- build OpenAI-compatible model list output

### Chat Request Mapper (`src/mappers/chat-request.ts`)

- validate request payload
- resolve selected model
- transform messages into an OpenCode-friendly prompt

### Chat Response Mapper (`src/mappers/chat-response.ts`)

- collect text parts from assistant response
- build OpenAI-compatible completion payload

## Testing Strategy

### Unit Tests

- config parsing
- provider filtering
- model list mapping
- request validation
- message serialization
- response mapping
- error mapping

### Integration Tests

- mock OpenCode `GET /provider`
- mock session creation and message APIs
- verify `/v1/models` response shape
- verify `/v1/chat/completions` happy path
- verify upstream failure translation

### Mandatory E2E Testing With Real OpenCode

This is a critical part of the MVP.

The plugin must be tested end-to-end against a real OpenCode instance. Mock-only testing is not sufficient.

Required real e2e coverage:

- install the plugin into a real OpenCode setup
- start OpenCode and confirm the sidecar starts successfully
- call `GET /v1/models`
- verify only currently connected models are returned
- select a returned model ID and call `POST /v1/chat/completions`
- verify the request succeeds using real OpenCode upstream behavior
- verify response format is compatible and contains assistant text
- verify a failure scenario such as no connected providers or unreachable upstream

The PRD requirement is explicit:

**The MVP is not complete until it has been tested e2e with a real OpenCode instance and shown to work.**

### Manual E2E Script Requirement

The repository should include a documented manual test flow or helper script that:

1. starts or connects to a real OpenCode instance
2. waits for sidecar health
3. fetches `/v1/models`
4. sends a real `chat/completions` request
5. verifies the returned shape and basic usability

## Acceptance Criteria

- Plugin installs via OpenCode's plugin mechanism.
- Sidecar starts automatically by default.
- `GET /health` returns healthy status when running.
- `GET /v1/models` returns only connected models.
- Model IDs are exposed as `provider/model`.
- `POST /v1/chat/completions` works for non-streaming text requests.
- Unsupported streaming requests fail clearly.
- Errors are returned in a stable, readable format.
- Real e2e testing with a live OpenCode instance verifies the full flow.
- Repository includes setup and testing documentation.

## Risks

- Plugin lifecycle may not provide strong shutdown behavior, making cleanup tricky.
- Upstream API changes in OpenCode may require mapper updates.
- Some OpenAI request fields may need explicit rejection to avoid misleading compatibility.

## Post-MVP Ideas

- streaming `chat/completions`
- session reuse mode
- cached provider/model discovery improvements
- expanded OpenAI compatibility surface
- better usage/token mapping
- optional richer compatibility with external client expectations
