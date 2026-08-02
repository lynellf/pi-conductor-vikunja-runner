# Authoring coding tasks

## Workflow

Create coding work in a configured Vikunja project. Backlog is ignored. Move a
task to Ready only when its requirements and acceptance criteria are suitable
for unattended implementation.

The runner owns these active transitions:

```text
Ready → Running → Waiting → Running → Review
                ↘                 ↘ Failed
```

Done remains human-controlled. Moving Review or Failed back to Ready creates a
new attempt on the preserved task branch. Moving an active task to another
bucket requests a manual override; the runner aborts and preserves that bucket.

## Recommended task format

**Title:** State the reviewable outcome, not an activity.

**Description:** Include:

1. Problem and user impact
2. Required behavior
3. Explicit non-goals
4. Acceptance criteria
5. Relevant repository paths or existing conventions
6. Constraints that are not already in repository documentation

Example:

```markdown
## Problem
Expired API sessions return an unhandled 500 response.

## Required behavior
Return the existing typed 401 response and preserve audit logging.

## Acceptance criteria
- Expired sessions return 401 with code SESSION_EXPIRED.
- Valid sessions are unchanged.
- A regression test covers the expired path.

## Non-goals
Do not change token lifetime or authentication providers.
```

Do not put repository URLs, branches, commands, model credentials, secrets, or
analytics endpoints in task content. The runner ignores such values and uses
trusted repository configuration only.

## Questions

When conductor calls `ask_user`, the task moves to Waiting and receives one
Question comment.

Reply with a plain owner-authored comment:

- input: any non-empty text
- confirmation: `yes`, `y`, `no`, or `n`
- selection: exact option text or its one-based number

Invalid confirmation or selection replies receive one correction and leave the
run waiting. Only the configured owner account may answer. A daemon restart
while waiting fails safely with `WAIT_INTERRUPTED`; move the task to Ready to
start a fresh attempt.

## Live commands

Only owner-authored commands are accepted:

```text
/pi steer <message>
/pi abort [reason]
```

Use steering for information that must affect the currently running role. Plain
comments while Running are retained as context for a later attempt but are not
silently injected into the live run.

`/pi abort` stops the live run and preserves artifacts. Unknown `/pi` commands
receive help and do not change state.

## Review and retry

A task reaches Review only after conductor completes, every configured check
passes, the worktree is clean, and any configured normal branch push succeeds.
The final comment includes the branch, commit, checks, attempt, run ID, publish
result, and bounded conductor summary.

To accept, inspect the branch/worktree and move the task to Done. To request
changes, add clear feedback and move it to Ready. The next attempt reuses the
preserved branch and includes owner feedback in its initial goal.

A Failed task retains its branch, worktree, logs, and conductor records. Read the
stable error code and next action in the failure comment before retrying.
