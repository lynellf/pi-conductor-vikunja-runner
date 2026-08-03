# Runner operations

## Safety model

The runner is a single-replica, unprivileged service. It may create task branches,
worktrees, conductor sessions, comments, and configured normal branch pushes. It
never moves a task to Done, merges, deploys, force-pushes, or deletes preserved
artifacts.

Run only one service instance. The SQLite claim model intentionally does not
support distributed replicas.

## Installation

Requirements:

- Node.js 22.19 or newer
- pnpm
- Git and repository credentials for the service account
- A dedicated Linux account without sudo or Docker socket access

Build and verify a release checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm audit --prod
```

Follow [`../deploy/README.md`](../deploy/README.md) to install the systemd unit.

## Configuration and credentials

Copy `config.example.yaml` outside the repository and replace every example ID,
URL, repository, and verification command. Project keys must be numeric Vikunja
project IDs.

Install the Vikunja token and analytics JSON as files owned by the service user
with mode `0600`. Configure model authentication either through provider
environment variables or an isolated `auth.json` under `runner.agent_dir`.
Never put credentials in YAML, task content, comments, or the repository.

Before first use or after configuration changes:

```bash
pnpm runner:validate -- --config /etc/pi-conductor-vikunja-runner/config.yaml
```

Validation is read-only with respect to Vikunja and configured Git remotes. It
checks protected credential permissions, analytics configuration, the one
shared conductor manifest and its prompt paths, registered model providers, a
temporary shallow clone of each default branch, and Vikunja workflow layouts.
The shared manifest is loaded once regardless of project count.

## Starting and observing

```bash
sudo systemctl enable --now pi-conductor-vikunja-runner.service
sudo systemctl status pi-conductor-vikunja-runner.service
sudo journalctl -u pi-conductor-vikunja-runner.service -f
```

Logs are one JSON object per line. Search by `event`, `projectId`, `taskId`,
`jobId`, or `runId` when those fields are present.

Health checks configuration, SQLite access, Vikunja layouts, and the durable
daemon heartbeat without claiming work:

```bash
pnpm runner:health -- --config /etc/pi-conductor-vikunja-runner/config.yaml
```

To execute one complete poll/claim cycle and wait for any claimed job:

```bash
pnpm runner:once -- --config /etc/pi-conductor-vikunja-runner/config.yaml
```

## Shutdown and restart

`SIGTERM` and `SIGINT` stop new claims and request conductor abort. The daemon
allows up to 25 seconds for the active cycle and then up to 2 seconds for the
analytics queue to drain; the systemd unit has a 30-second stop timeout. A forced exit relies on startup
reconciliation.

On restart:

- Running jobs with a durable conductor run ID resume through `resumeRun()`.
- Any stranded Waiting dialog fails with `WAIT_INTERRUPTED`; no answer is
  fabricated.
- Interrupted claims fail safely and release the global active slot.
- Pending idempotent Vikunja mutations are replayed.
- Human-selected buckets are preserved.
- Analytics JSONL records past the committed watermark are backfilled.

## Failure recovery

Do not delete `<data_dir>` while investigating. It contains:

- `state.sqlite`
- `conductor-runs/`
- persistent repository clones
- task branches and worktrees
- job metadata and analytics watermarks

A failed claim trips a process-level circuit breaker after the runner records
the failed job and its owner-visible comment. The daemon logs the original
claim error and exits successfully so `Restart=on-failure` does not immediately
claim the still-Ready task again. Correct the underlying problem, move the task
out of Ready and back when a retry is desired, then restart the service.

Read the task's stable error code and local JSON logs. Correct the underlying
problem, then move the task from Failed or Review to Ready to create a new
attempt. Retries reuse the preserved task branch and worktree by default.

For `WAIT_INTERRUPTED`, review the saved question and any owner response before
moving the task to Ready. The new attempt receives relevant owner comments as
prompt context but never silently reuses an answer as the interrupted tool-call
result.

## Backup and retention

Back up the complete data directory while the service is stopped, or use a
SQLite-safe snapshot process. Preserve file ownership and modes. State, branches,
worktrees, logs, and sessions are retained indefinitely; pruning requires a
separate owner-approved procedure.

## Production approval checklist

Confirm before enabling the service against live projects:

- publishing mode and scoped SSH key for each repository
- model authentication location
- exact verification commands
- Git author name and email
- conductor role commit expectations
- acceptance of any Tailscale/private-network HTTP exception
- one and only one enabled service replica
