# AGENTS.md

## Build And Test

- Install dependencies with `bun install`.
- Run `bun run typecheck` before committing.
- Run `bun test` for the Bun test suite.
- Run `bun run build` to produce `dist/`.
- Run `bun run test:e2e:real` to verify the packaged plugin contents and built export.

## Project Notes

- `scripts/check-plugin-packaging.ts` fails fast when `src/index.ts` or the npm export metadata is missing.
- Run `bun run build` to completion before `bun run test:e2e:real`; the packaging smoke test reads `dist/` and can fail if the build is still running.
- `bun run test:e2e:real` auto-starts `opencode serve` when `opencode` is on `PATH`; set `OPENCODE_REAL_UPSTREAM_URL` to reuse an existing server and `OPENCODE_REAL_MODEL` to pin the live verification model.
- Use `./ralph log "message"` to append activity entries to `.ralph/activity.log`.
