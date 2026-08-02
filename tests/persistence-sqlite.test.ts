import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingTask } from "../src/domain/types.js";
import { bucketId, commentId, projectId, taskId } from "../src/domain/types.js";
import { SqliteJobStore } from "../src/persistence/sqlite.js";

const stores: SqliteJobStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const task = (id: number, project = 42): CodingTask => ({
  id: taskId(id),
  projectId: projectId(project),
  title: `Task ${id}`,
  priority: 1,
  position: 1,
  bucketId: bucketId(2),
  done: false,
});

const openStoreAt = async (path: string): Promise<SqliteJobStore> => {
  const store = await SqliteJobStore.open(path);
  stores.push(store);
  return store;
};

const openStore = async (): Promise<SqliteJobStore> => {
  const directory = await mkdtemp(join(tmpdir(), "vikunja-runner-"));
  return openStoreAt(join(directory, "state.sqlite"));
};

describe("SqliteJobStore", () => {
  it("persists and reopens the daemon heartbeat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-runner-"));
    const path = join(directory, "state.sqlite");
    const first = await openStoreAt(path);
    await first.recordHeartbeat("2026-08-02T03:00:00.000Z");
    expect(await first.getHeartbeat()).toBe("2026-08-02T03:00:00.000Z");
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await openStoreAt(path);
    expect(await reopened.getHeartbeat()).toBe("2026-08-02T03:00:00.000Z");
  });

  it("claims only one active task globally and increments attempts after failure", async () => {
    const store = await openStore();
    const first = await store.tryClaim(task(10));
    expect(first).not.toBeNull();
    if (first === null) throw new Error("claim unexpectedly failed");
    expect(first.attempt).toBe(1);
    expect(await store.tryClaim(task(10))).toBeNull();
    expect(await store.tryClaim(task(11))).toBeNull();

    const failed = await store.transition(first.id, {
      state: "failed",
      terminalErrorCode: "VERIFY_FAILED",
    });
    expect(failed.state).toBe("failed");
    const retry = await store.tryClaim(task(10));
    expect(retry?.attempt).toBe(2);
  });

  it("carries a persisted branch and worktree into a retry attempt", async () => {
    const store = await openStore();
    const first = await store.tryClaim(task(10), "repo-a");
    if (first === null) throw new Error("claim unexpectedly failed");
    await store.recordWorktree(
      first.id,
      "pi/vikunja-10-original-title",
      "/var/lib/runner/jobs/10/worktree",
    );
    await store.transition(first.id, {
      state: "failed",
      terminalErrorCode: "VERIFY_FAILED",
    });

    const retry = await store.tryClaim(
      { ...task(10), title: "Owner renamed" },
      "repo-a",
    );

    expect(retry).toMatchObject({
      attempt: 2,
      branch: "pi/vikunja-10-original-title",
      worktree: "/var/lib/runner/jobs/10/worktree",
    });
  });

  it("does not carry worktree artifacts when a task changes projects", async () => {
    const store = await openStore();
    const first = await store.tryClaim(task(10, 42), "repo-a");
    if (first === null) throw new Error("claim unexpectedly failed");
    await store.recordWorktree(
      first.id,
      "pi/vikunja-10-original-title",
      "/var/lib/runner/jobs/10/worktree",
    );
    await store.transition(first.id, {
      state: "failed",
      terminalErrorCode: "VERIFY_FAILED",
    });

    const retry = await store.tryClaim(task(10, 43), "repo-b");

    expect(retry).toMatchObject({
      attempt: 2,
      branch: null,
      worktree: null,
    });
  });

  it("does not carry artifacts when the configured repository changes", async () => {
    const store = await openStore();
    const first = await store.tryClaim(task(10, 42), "repo-a");
    if (first === null) throw new Error("claim unexpectedly failed");
    await store.recordWorktree(
      first.id,
      "pi/vikunja-10-original-title",
      "/var/lib/runner/jobs/10/worktree",
    );
    await store.transition(first.id, {
      state: "failed",
      terminalErrorCode: "VERIFY_FAILED",
    });

    const retry = await store.tryClaim(task(10, 42), "repo-b");

    expect(retry).toMatchObject({ branch: null, worktree: null });
  });

  it("upgrades a v1 database without losing recoverable jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-runner-"));
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (1, '2026-08-01T00:00:00.000Z');
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY NOT NULL,
        task_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        state TEXT NOT NULL CHECK (state IN ('claiming', 'running', 'waiting', 'review', 'failed')),
        branch TEXT,
        worktree TEXT,
        conductor_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_error_code TEXT
      );
      CREATE UNIQUE INDEX jobs_one_active_task
        ON jobs (task_id)
        WHERE state IN ('claiming', 'running', 'waiting');
      CREATE UNIQUE INDEX jobs_one_active_globally
        ON jobs ((1))
        WHERE state IN ('claiming', 'running', 'waiting');
      CREATE UNIQUE INDEX jobs_task_attempt ON jobs (task_id, attempt);
      INSERT INTO jobs
        (id, task_id, project_id, attempt, state, branch, worktree,
         conductor_run_id, created_at, updated_at, terminal_error_code)
      VALUES
        ('legacy-job', 8, 42, 1, 'running', 'pi/vikunja-8-task-8',
         '/var/lib/runner/jobs/8/worktree', 'legacy-run',
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const upgraded = await openStoreAt(path);
    const recovered = await upgraded.recoverableJobs();
    expect(recovered).toMatchObject([
      {
        id: "legacy-job",
        taskId: taskId(8),
        projectId: projectId(42),
        state: "running",
        conductorRunId: "legacy-run",
      },
    ]);
    expect(await upgraded.getCommentWatermark(taskId(8))).toBeNull();
  });

  it("persists the task-to-job-to-run mapping and recoverable jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-runner-"));
    const path = join(directory, "state.sqlite");
    const firstStore = await SqliteJobStore.open(path);
    stores.push(firstStore);
    const claimed = await firstStore.tryClaim(task(7));
    expect(claimed).not.toBeNull();
    if (claimed === null) throw new Error("claim unexpectedly failed");
    const jobId = claimed.id;
    await firstStore.recordWorktree(
      jobId,
      "pi/vikunja-7-task-7",
      `${directory}/jobs/7/worktree`,
    );
    await firstStore.recordRunId(jobId, "run-7");
    await firstStore.transition(jobId, { state: "running" });
    firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const reopened = await SqliteJobStore.open(path);
    stores.push(reopened);
    const recovered = await reopened.recoverableJobs();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: jobId,
      taskId: taskId(7),
      projectId: projectId(42),
      branch: "pi/vikunja-7-task-7",
      worktree: `${directory}/jobs/7/worktree`,
      conductorRunId: "run-7",
      state: "running",
    });
  });

  it("rejects illegal transitions and keeps terminal errors typed", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(4));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    const id = claimed.id;
    await expect(store.transition(id, { state: "review" })).rejects.toThrow(
      "illegal job transition claiming -> review",
    );
    await store.transition(id, { state: "running" });
    await store.transition(id, { state: "waiting" });
    const failed = await store.transition(id, {
      state: "failed",
      terminalErrorCode: "WAIT_INTERRUPTED",
    });
    expect(failed.terminalErrorCode).toBe("WAIT_INTERRUPTED");
  });

  it("atomically records terminal failure intents with the job transition", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(30));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    const moveKey = `job:${claimed.id}:failure:move`;
    const commentKey = `job:${claimed.id}:failure:comment`;

    const failed = await store.recordTerminalFailure(
      claimed.id,
      "VERIFY_FAILED",
      [
        {
          jobId: claimed.id,
          taskId: claimed.taskId,
          operation: "move_task",
          idempotencyKey: moveKey,
          request: { bucketId: 6, expectedBucketId: 3 },
        },
        {
          jobId: claimed.id,
          taskId: claimed.taskId,
          operation: "post_comment",
          idempotencyKey: commentKey,
          request: { body: "Verification failed" },
        },
      ],
    );

    expect(failed).toMatchObject({
      state: "failed",
      terminalErrorCode: "VERIFY_FAILED",
    });
    expect(await store.getMutationIntent(moveKey)).toMatchObject({
      state: "pending",
    });
    expect(await store.getMutationIntent(commentKey)).toMatchObject({
      state: "pending",
    });
  });

  it("rolls back failure intents when their terminal transition cannot commit", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(31));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    const key = `job:${claimed.id}:failure:move`;

    await expect(
      store.recordTerminalFailure(claimed.id, "VERIFY_FAILED", [
        {
          jobId: claimed.id,
          taskId: taskId(999),
          operation: "move_task",
          idempotencyKey: key,
          request: { bucketId: 6, expectedBucketId: 3 },
        },
      ]),
    ).rejects.toThrow("does not match its job");

    expect(await store.getJob(claimed.id)).toMatchObject({
      state: "claiming",
      terminalErrorCode: null,
    });
    expect(await store.getMutationIntent(key)).toBeNull();
  });

  it("durably records a question, answer, and monotonic comment watermark", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(20));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    const question = await store.createQuestion({
      jobId: claimed.id,
      taskId: taskId(20),
      kind: "confirm",
      prompt: "Proceed?",
      commentWatermark: commentId(4),
    });
    expect(question).toMatchObject({
      jobId: claimed.id,
      taskId: taskId(20),
      kind: "confirm",
      options: [],
      commentWatermark: commentId(4),
      state: "pending",
    });
    expect(await store.getActiveQuestion(claimed.id)).toMatchObject({
      id: question.id,
    });
    await store.recordQuestionComment(question.id, commentId(5));
    const resolved = await store.resolveQuestion(
      question.id,
      commentId(6),
      "yes",
    );
    expect(resolved).toMatchObject({
      commentId: commentId(5),
      responseCommentId: commentId(6),
      answer: "yes",
      state: "resolved",
    });
    await store.recordCommentWatermark(taskId(20), commentId(8));
    await store.recordCommentWatermark(taskId(20), commentId(7));
    expect(await store.getCommentWatermark(taskId(20))).toBe(commentId(8));
    expect(await store.getActiveQuestion(claimed.id)).toBeNull();
  });

  it("atomically resolves a question and resumes its Waiting job", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(23));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.transition(claimed.id, { state: "waiting" });
    const question = await store.createQuestion({
      jobId: claimed.id,
      taskId: claimed.taskId,
      kind: "input",
      prompt: "Continue?",
      commentWatermark: null,
    });

    const resolved = await store.resolveQuestionAndResume(
      question.id,
      commentId(9),
      "continue",
    );

    expect(resolved.question).toMatchObject({
      state: "resolved",
      responseCommentId: commentId(9),
      answer: "continue",
    });
    expect(resolved.job).toMatchObject({ state: "running" });
    expect(await store.getQuestion(question.id)).toMatchObject({
      state: "resolved",
    });
    expect(await store.getJob(claimed.id)).toMatchObject({ state: "running" });
  });

  it("does not resolve a question when its job cannot resume", async () => {
    const store = await openStore();
    const claimed = await store.tryClaim(task(24));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    await store.transition(claimed.id, { state: "running" });
    await store.transition(claimed.id, { state: "waiting" });
    const question = await store.createQuestion({
      jobId: claimed.id,
      taskId: claimed.taskId,
      kind: "input",
      prompt: "Continue?",
      commentWatermark: null,
    });
    await store.transition(claimed.id, {
      state: "failed",
      terminalErrorCode: "WAIT_INTERRUPTED",
    });

    await expect(
      store.resolveQuestionAndResume(question.id, commentId(10), "continue"),
    ).rejects.toThrow("question job must be waiting");

    expect(await store.getQuestion(question.id)).toMatchObject({
      state: "pending",
      responseCommentId: null,
      answer: null,
    });
  });

  it("persists a bounded abort reason across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-runner-abort-"));
    const path = join(directory, "state.sqlite");
    const store = await openStoreAt(path);
    const claimed = await store.tryClaim(task(22));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    const question = await store.createQuestion({
      jobId: claimed.id,
      taskId: taskId(22),
      kind: "input",
      prompt: "Continue?",
      commentWatermark: null,
    });
    const aborted = await store.abortQuestion(
      question.id,
      `${"reason ".repeat(500)}tail`,
    );
    expect(aborted.state).toBe("aborted");
    expect(aborted.abortReason).toHaveLength(2000);
    stores.splice(stores.indexOf(store), 1);
    store.close();

    const reopened = await openStoreAt(path);
    await expect(reopened.getQuestion(question.id)).resolves.toMatchObject({
      state: "aborted",
      abortReason: `${"reason ".repeat(500)}tail`.slice(0, 2000),
    });
  });

  it("deduplicates milestone delivery and remote mutation intents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vikunja-runner-"));
    const path = join(directory, "state.sqlite");
    const store = await openStoreAt(path);
    const claimed = await store.tryClaim(task(21));
    if (claimed === null) throw new Error("claim unexpectedly failed");
    const milestone = await store.recordMilestone({
      jobId: claimed.id,
      type: "claimed",
      idempotencyKey: `job:${claimed.id}:claimed`,
    });
    expect(
      await store.recordMilestone({
        jobId: claimed.id,
        type: "claimed",
        idempotencyKey: `job:${claimed.id}:claimed`,
      }),
    ).toEqual(milestone);
    const delivered = await store.recordMilestoneComment(
      milestone.id,
      commentId(10),
    );
    expect(delivered).toMatchObject({
      deliveryState: "delivered",
      commentId: commentId(10),
    });
    expect(
      await store.recordMilestoneComment(milestone.id, commentId(10)),
    ).toEqual(delivered);

    const mutation = await store.recordMutationIntent({
      jobId: claimed.id,
      taskId: taskId(21),
      operation: "move_task",
      idempotencyKey: `job:${claimed.id}:move`,
      request: { bucketId: 3 },
    });
    expect(
      await store.recordMutationIntent({
        jobId: claimed.id,
        taskId: taskId(21),
        operation: "move_task",
        idempotencyKey: `job:${claimed.id}:move`,
        request: { bucketId: 3 },
      }),
    ).toEqual(mutation);
    await expect(
      store.recordMutationIntent({
        jobId: claimed.id,
        taskId: taskId(21),
        operation: "move_task",
        idempotencyKey: `job:${claimed.id}:move`,
        request: { bucketId: 999 },
      }),
    ).rejects.toThrow("already used");
    const completed = await store.completeMutation(
      mutation.idempotencyKey,
      "remote-10",
    );
    expect(completed).toMatchObject({
      state: "succeeded",
      remoteId: "remote-10",
      request: { bucketId: 3 },
    });

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await openStoreAt(path);
    expect(
      await reopened.getMilestone(claimed.id, milestone.idempotencyKey),
    ).toEqual(delivered);
    expect(await reopened.getMutationIntent(mutation.idempotencyKey)).toEqual(
      completed,
    );
  });
});
