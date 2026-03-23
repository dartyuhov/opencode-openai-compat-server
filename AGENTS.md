# AGENTS.md

## Purpose

- This repository builds an OpenCode plugin that starts a localhost OpenAI-compatible sidecar.
- Agents working here should prefer small, behavior-preserving changes and keep the packaged plugin export healthy.
- Read the relevant file before editing it.
- Run the required verification before proposing a commit.

## Rule Sources

- Primary repository guidance lives in this file.
- Additional local guardrails exist in `.ralph/guardrails.md`.
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` files are present at the time of writing.

## Repository Layout

- `src/index.ts` exports the plugin entrypoint and public API surface.
- `src/sidecar.ts` owns Bun server startup, routing, auth, logging, and response normalization.
- `src/chat.ts` validates OpenAI-style chat requests and serializes prompts.
- `src/upstream.ts` wraps OpenCode upstream HTTP calls, caching, parsing, and sanitized error mapping.
- `src/config.ts` parses plugin config and environment-driven defaults.
- `src/models.ts` maps OpenCode provider metadata into OpenAI model-list responses.
- `test/*.test.ts` contains the Bun test suite.
- `scripts/check-plugin-packaging.ts` validates package/export expectations before build and typecheck.
- `scripts/test-e2e-real.ts` runs packaging smoke checks plus live verification against a real OpenCode server.

## Environment And Tooling

- Runtime: Bun.
- Language: TypeScript in strict mode.
- Module system: `NodeNext` with explicit `.js` import specifiers in TypeScript source.
- Build output: `dist/`.
- Package manager: `bun@1.3.10`.
- There is no dedicated lint task configured; `typecheck` is the closest static validation step.

## Build, Typecheck, And Test Commands

- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Run all unit tests: `bun test`
- Build package output: `bun run build`
- Run real end-to-end verification: `bun run test:e2e:real`

## Single-Test Commands

- Run one test file: `bun test test/sidecar-server.test.ts`
- Run multiple specific files: `bun test test/chat-request.test.ts test/model-list.test.ts`
- Run tests by name pattern: `bun test --test-name-pattern "rejects stream=true"`
- Run one file and one named test together: `bun test test/sidecar-server.test.ts --test-name-pattern "enforces bearer auth"`
- Use `--timeout` when a slow integration-style test needs more than Bun's default 5000 ms.

## Recommended Verification Flow

- For most source edits, run `bun run typecheck` and `bun test`.
- For packaging or public export changes, run `bun run build`.
- For changes affecting packaged behavior or real upstream integration, run `bun run build` before `bun run test:e2e:real`.
- Do not run `bun run test:e2e:real` against a stale `dist/`; the script reads the built package output.

## Real E2E Notes

- `bun run test:e2e:real` auto-starts `opencode serve` when `opencode` is on `PATH`.
- Use `OPENCODE_REAL_UPSTREAM_URL`, `OPENCODE_REAL_MODEL`, `OPENCODE_REAL_TIMEOUT_MS`, and `OPENCODE_REAL_NEGATIVE_UPSTREAM_URL` to override the live verification flow.

## Packaging Notes

- `scripts/check-plugin-packaging.ts` fails fast if `src/index.ts` or package export metadata drift.
- `bun run build` clears `dist/` and compiles with `tsconfig.build.json`.
- The package exports only the built `dist/` output.

## Working Style For Agents

- Prefer minimal diffs over broad refactors.
- Preserve existing API shapes and error-envelope formats unless the task explicitly changes behavior.
- When changing validation or mapping logic, update or add focused tests in the nearest existing test file.
- Reuse existing helpers before introducing new abstractions.
- Keep sensitive upstream credentials sanitized in logs, errors, and test expectations.

## Code Style

### Imports And Exports

- Use ES module syntax everywhere.
- Use `import type` for type-only imports.
- Use relative imports with explicit `.js` extensions from TypeScript files.
- Re-export public API from `src/index.ts` in a stable, explicit list.

### Formatting

- Follow the existing TypeScript style rather than introducing a formatter-specific rewrite.
- Use 2-space indentation.
- Prefer trailing commas in multiline objects, arrays, params, and argument lists.
- Use double quotes, not single quotes.
- Use numeric separators for readable large literals like `30_000`.

### Types

- Keep `strict` TypeScript compatibility.
- Prefer explicit exported types for public data shapes.
- Use narrow string unions and `as const` arrays for allowed-value sets.
- Use `unknown` at trust boundaries, then validate before use.
- Add return types when they improve clarity, especially on exported functions and parsers.

### Naming

- Use `PascalCase` for types, classes, and error classes.
- Use `camelCase` for variables, functions, methods, and non-constant helpers.
- Use `SCREAMING_SNAKE_CASE` for exported constants that behave like configuration constants.
- Name tests by observable behavior, usually starting with a verb like `returns`, `rejects`, `maps`, or `starts`.

### Control Flow And Functions

- Prefer guard clauses and early returns over deep nesting.
- Keep request handling split into focused helpers instead of one large route body.
- Prefer deterministic output ordering when generating lists or serialized content.

### Error Handling

- Fail closed on malformed upstream or client input.
- Use domain-specific error classes when behavior depends on error type.
- Convert internal failures into sanitized user-facing errors.
- Do not leak usernames, passwords, raw upstream URLs with credentials, or opaque upstream internals.
- Preserve the existing OpenAI-style error envelope shape when returning HTTP errors.
- Catch broad failures only where you can normalize or intentionally suppress them.

### HTTP And API Conventions

- Return JSON with consistent content-type headers.
- Keep route matching explicit by method and pathname.
- Enforce auth before handler logic when an API key is configured.
- Normalize timestamps and response payloads into stable OpenAI-compatible shapes.

### Config Conventions

- Parse config from `unknown` inputs and validate every field.
- Trim user-provided strings before storing them.
- Treat blank optional strings as `null`.
- Keep defaults centralized in `DEFAULT_PLUGIN_CONFIG`.
- Restrict bind hosts to the explicit allowlist in `src/config.ts`.

### Tests

- Use `bun:test` primitives: `describe`, `test`, `expect`, and lifecycle hooks where needed.
- Keep tests close to the behavior they exercise; extend existing files before creating new ones when the topic already fits.
- Assert full response envelopes for public HTTP behavior, not just status codes.
- Prefer realistic fixture payloads over heavily mocked shapes when parsing upstream responses.

## Change-Specific Advice

- If you edit `src/index.ts`, verify exports and then run `bun run build`.
- If you edit `src/config.ts`, cover both defaults and invalid-input paths.
- If you edit `src/upstream.ts`, test network errors, timeout handling, and schema parsing.
- If you edit `src/sidecar.ts`, test HTTP status codes, auth behavior, and error-envelope stability.
- If you edit `src/chat.ts` or `src/models.ts`, add focused pure-function tests.

## Commit Readiness Checklist

- Relevant files were read before editing.
- Behavior changes include matching test updates.
- `bun run typecheck` passes.
- `bun test` passes for affected code, or a narrower command was used during iteration.
- `bun run build` was run for packaging/export changes.
- `bun run test:e2e:real` was run when live packaged behavior changed or needs verification.

## Miscellaneous

- Use `./ralph log "message"` to append activity to `.ralph/activity.log` when that workflow is useful.
