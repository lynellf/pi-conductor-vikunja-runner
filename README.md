# pi-conductor-vikunja-runner

A single-user, self-hosted daemon that turns approved Vikunja coding tasks into
durable `pi-conductor` runs. It claims tasks from Ready, creates isolated Git
worktrees, bridges agent questions and control commands through Vikunja, runs
configured verification, optionally pushes the task branch, and reports the
result in Review or Failed.

The runner never merges, deploys, force-pushes, deletes preserved work, or moves
a task to Done.

## Requirements

- Node.js 22.19 or newer
- pnpm
- Git
- Vikunja 2.4.x
- One unprivileged runner account and one service replica

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm build
cp config.example.yaml /path/to/config.yaml
pnpm runner:validate -- --config /path/to/config.yaml
pnpm runner:once -- --config /path/to/config.yaml
```

Credentials are protected files referenced by configuration, never YAML values.
See [`docs/operations.md`](docs/operations.md) before running against live
projects.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev -- --config <path>` | Run the daemon from TypeScript |
| `pnpm start -- --config <path>` | Run the compiled daemon |
| `pnpm runner:validate -- --config <path>` | Read-only dependency and layout validation |
| `pnpm runner:once -- --config <path>` | Run one poll/claim/execution cycle |
| `pnpm runner:health -- --config <path>` | Check layouts, SQLite, and heartbeat without claiming |
| `pnpm build` | Compile TypeScript |
| `pnpm typecheck` | Type-check source and tests |
| `pnpm lint` / `pnpm lint:fix` | Check or fix Biome formatting/lint |
| `pnpm test` | Run the test suite |
| `pnpm test:coverage` | Run enforced domain coverage thresholds |
| `pnpm audit --prod` | Audit production dependencies |

## Architecture

External boundaries are dependency-injected behind typed interfaces:

- `src/vikunja/` — validated, paginated native-fetch adapter
- `src/persistence/` — transactional SQLite state and idempotency intents
- `src/repositories/` — confined Git clone/worktree/verify/publish operations
- `src/conductor/` — pinned pi-conductor library and analytics integration
- `src/domain/` — claiming, interactions, orchestration, and reconciliation
- `src/cli/` — validate, once, health, daemon lifecycle, and JSON logging

SQLite migrations are versioned in `src/persistence/sqlite.ts` and applied in a
single immediate transaction. Runtime state and conductor sessions live only
under the configured data directory.

## Documentation

- [Version 1 specification](docs/pi-conductor-vikunja-runner-spec.md)
- [Operations and recovery](docs/operations.md)
- [Task authoring and commands](docs/task-authoring.md)
- [systemd installation](deploy/README.md)
